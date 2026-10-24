import { createAugmentDecoder } from './decoder.mjs';

// This desktop-only probe never writes to the game, the production helper, or a
// file. SDK objects are reduced to allowlisted fields before decoding. Unknown
// names, callback errors, player fields, and match IDs never reach the DOM.
const LOL_CLASS_ID = 5426;
const FEATURES = Object.freeze(['augments', 'matchState']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const element = id => document.getElementById(id);
const ui = {
  start: element('start'), stop: element('stop'), clear: element('clear'),
  status: element('status'), subscription: element('subscription'), match: element('match'),
  updated: element('updated'), candidates: [1, 2, 3].map(index => element(`candidate-${index}`)),
  candidateNote: element('candidate-note'), picked: element('picked'), pickedNote: element('picked-note'),
};
ui.start.disabled = true;
ui.stop.disabled = true;

let decoder = null;
let sdk = null;
let observing = false;
let subscribed = false;
let generation = 0;
let gateTimer = null;
let gateBusy = false;
let lastMatchId = null;
let lastMatchStarted = null;
let lastQueue = null;

function setStatus(message) { ui.status.textContent = message; }

function clearObservations() {
  for (const node of ui.candidates) node.textContent = '等待真实数据';
  ui.picked.replaceChildren();
  ui.candidateNote.textContent = '尚未收到候选更新。';
  ui.pickedNote.textContent = '尚未收到已选更新。';
  ui.updated.textContent = '尚未收到真实数据';
}

function resetMatch() {
  lastMatchId = null;
  lastMatchStarted = null;
  lastQueue = null;
  ui.match.textContent = '尚未观察';
  clearObservations();
}

function current(run) { return observing && generation === run; }

function removeListeners() {
  if (!sdk) return;
  try { sdk.games.events.onInfoUpdates2.removeListener(onInfo); } catch { /* No callback data is retained. */ }
  try { sdk.games.events.onError.removeListener(onError); } catch { /* Nothing else to release. */ }
}

function stopObserver(message = '已停止观察；显示内容仅为停止前的结果') {
  observing = false;
  subscribed = false;
  generation += 1;
  gateBusy = false;
  if (gateTimer !== null) clearInterval(gateTimer);
  gateTimer = null;
  removeListeners();
  ui.stop.disabled = true;
  ui.start.disabled = !decoder || !sdk;
  ui.subscription.textContent = '未订阅更新；本窗口已停止接收';
  setStatus(message);
}

function readRunningGame(result) {
  if (!record(result) || result.success !== true) return null;
  // The current getRunningGameInfo2 section documents .gameInfo, while the
  // historical GetRunningGameInfoResult example is flat. Read only the gate.
  const info = own(result, 'gameInfo') ? result.gameInfo : result;
  if (!record(info)) return null;
  return { isRunning: info.isRunning === true, classId: info.classId };
}

function checkGame(run, onSuccess) {
  if (!current(run) || gateBusy) return;
  gateBusy = true;
  try {
    sdk.games.getRunningGameInfo2(result => {
      if (!current(run)) return;
      gateBusy = false;
      const game = readRunningGame(result);
      if (!game || !game.isRunning || game.classId !== LOL_CLASS_ID) {
        resetMatch();
        stopObserver('尚未检测到英雄联盟对局；进入游戏后请重新开始观察');
        return;
      }
      onSuccess();
    });
  } catch {
    gateBusy = false;
    stopObserver('无法检查当前游戏；尚未验证接口是否可用');
  }
}

function safeMatchId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function readMatchContext(info) {
  if (!record(info) || !record(info.game_info)) return;
  const game = info.game_info;
  const matchId = safeMatchId(game.matchId);
  const started = game.matchStarted === true || game.matchStarted === 'True' || game.matchStarted === 'true' ? true
    : game.matchStarted === false || game.matchStarted === 'False' || game.matchStarted === 'false' ? false : null;
  const queue = typeof game.queueId === 'number' ? game.queueId
    : typeof game.queueId === 'string' && /^\d{1,6}$/.test(game.queueId) ? Number(game.queueId) : null;
  const changedMatch = matchId !== null && lastMatchId !== null && matchId !== lastMatchId;
  if (changedMatch) {
    lastMatchStarted = null;
    lastQueue = null;
  }
  if (changedMatch || (started === false && lastMatchStarted !== false)
    || (started === true && lastMatchStarted === false)) clearObservations();
  if (matchId !== null) lastMatchId = matchId;
  if (started !== null) lastMatchStarted = started;
  if (Number.isSafeInteger(queue) && queue >= 0 && queue <= 999999) lastQueue = queue;
  const label = lastMatchStarted === true ? '对局进行中' : lastMatchStarted === false ? '对局尚未开始或已结束' : '尚未收到开始状态';
  ui.match.textContent = lastQueue === null ? label : `${label} · 队列 ${lastQueue}`;
}

function allowedAugmentEvent(event) {
  if (!record(event) || event.feature !== 'augments') return null;
  const me = record(event.info) && record(event.info.me) ? event.info.me : null;
  const envelope = event.category === 'me' && event.key === 'augments' && own(event, 'value');
  if (me && envelope && ['augments', 'picked_augment'].some(key => own(me, key))) return null;
  if (me) {
    const allowed = {};
    for (const key of ['augments', 'picked_augment']) if (own(me, key)) allowed[key] = me[key];
    if (Object.keys(allowed).length > 0) return { feature: 'augments', info: { me: allowed } };
  }
  if (envelope) {
    return { feature: 'augments', category: 'me', key: 'augments', value: event.value };
  }
  return null;
}

function renderUpdate(update) {
  const candidate = update.key === 'augments';
  const note = candidate ? ui.candidateNote : ui.pickedNote;
  // Each decoder update is a snapshot. An uncertain/empty one is never inferred
  // as a confirmed choice or silently accumulated into the current selection.
  if (candidate) {
    for (const node of ui.candidates) node.textContent = '暂无可映射数据';
    for (const slot of update.slots) {
      const match = /^augment_([1-3])$/.exec(slot.slot);
      if (match) ui.candidates[Number(match[1]) - 1].textContent = slot.nameMapped;
    }
  } else {
    ui.picked.replaceChildren();
    for (const slot of update.slots) {
      const item = document.createElement('li');
      const index = Number(slot.slot.slice('slot_'.length));
      item.textContent = `槽位 ${index}：${slot.nameMapped}`;
      ui.picked.appendChild(item);
    }
  }
  if (update.malformed) note.textContent = '收到更新，但格式无法验证；未确认任何选择。';
  else if (update.unknownCount > 0) note.textContent = `已映射 ${update.slots.length} 项；未识别 ${update.unknownCount} 项。尚不能完整确认。`;
  else if (update.status === 'observed') note.textContent = `收到真实接口更新；已映射 ${update.slots.length} 项，未识别 0 项。`;
  else note.textContent = '收到更新，但没有可确认的非空海克斯；未识别 0 项。';
}

function observeAugments(event) {
  const allowed = allowedAugmentEvent(event);
  if (!allowed) return;
  const decoded = decoder.decode(allowed);
  if (decoded.updates.length === 0) return;
  for (const update of decoded.updates) renderUpdate(update);
  ui.updated.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  setStatus(decoded.status === 'observed' ? '已收到并映射海克斯更新；请对照游戏核查' : '已收到海克斯更新；部分结果尚不能确认');
}

function onInfo(event) {
  if (!observing || !subscribed || !record(event)) return;
  if (event.feature === 'matchState') readMatchContext(event.info);
  else if (event.feature === 'augments') observeAugments(event);
}

function onError() {
  if (observing) stopObserver('游戏事件接口报告错误；已停止观察，尚未验证实际可用');
}

function readSnapshot(run) {
  try {
    sdk.games.events.getInfo(result => {
      if (!current(run) || !subscribed) return;
      if (!record(result) || result.success !== true || !record(result.res)) {
        setStatus('当前快照暂不可用；继续等待真实更新');
        return;
      }
      const snapshot = result.res;
      // getInfo().res is grouped by category, not an onInfoUpdates2 envelope.
      readMatchContext({ game_info: record(snapshot.game_info) ? {
        matchStarted: snapshot.game_info.matchStarted,
        queueId: snapshot.game_info.queueId,
        matchId: snapshot.game_info.matchId,
      } : {} });
      if (record(snapshot.me)) observeAugments({ feature: 'augments', info: { me: {
        ...(own(snapshot.me, 'augments') ? { augments: snapshot.me.augments } : {}),
        ...(own(snapshot.me, 'picked_augment') ? { picked_augment: snapshot.me.picked_augment } : {}),
      } } });
    });
  } catch {
    setStatus('无法读取当前快照；继续等待真实更新');
  }
}

function startObserver() {
  if (observing || !decoder || !sdk) return;
  resetMatch();
  observing = true;
  subscribed = false;
  const run = ++generation;
  ui.start.disabled = true;
  ui.stop.disabled = false;
  ui.subscription.textContent = '尚未订阅；正在检查游戏';
  setStatus('正在检查当前英雄联盟对局');
  checkGame(run, () => {
    if (!current(run)) return;
    try {
      removeListeners();
      sdk.games.events.onInfoUpdates2.addListener(onInfo);
      sdk.games.events.onError.addListener(onError);
      ui.subscription.textContent = '正在请求海克斯与对局状态';
      sdk.games.events.setRequiredFeatures([...FEATURES], result => {
        if (!current(run)) return;
        if (!record(result) || result.success !== true || !Array.isArray(result.supportedFeatures)
          || !FEATURES.every(feature => result.supportedFeatures.includes(feature))) {
          stopObserver('订阅未成功，或所需字段尚不可用；未验证已选海克斯');
          return;
        }
        subscribed = true;
        ui.subscription.textContent = '订阅成功：海克斯、对局状态';
        setStatus('订阅成功；等待本局真实海克斯数据');
        readSnapshot(run);
        gateTimer = setInterval(() => checkGame(run, () => {}), 5000);
      });
    } catch {
      stopObserver('接口调用失败；尚未验证实际可用');
    }
  });
}

ui.start.addEventListener('click', startObserver);
ui.stop.addEventListener('click', () => stopObserver());
ui.clear.addEventListener('click', () => {
  resetMatch();
  if (observing) setStatus('已清除显示；继续等待下一次真实更新');
});
window.addEventListener('beforeunload', () => stopObserver());

async function prepare() {
  const candidate = globalThis.overwolf;
  const events = candidate?.games?.events;
  if (typeof candidate?.games?.getRunningGameInfo2 !== 'function'
    || typeof events?.setRequiredFeatures !== 'function' || typeof events?.getInfo !== 'function'
    || typeof events?.onInfoUpdates2?.addListener !== 'function' || typeof events?.onInfoUpdates2?.removeListener !== 'function'
    || typeof events?.onError?.addListener !== 'function' || typeof events?.onError?.removeListener !== 'function') {
    setStatus('当前不在可用的 Overwolf 环境中，无法进行真实验证');
    ui.subscription.textContent = '未订阅；普通浏览器不能实测此接口';
    return;
  }
  sdk = candidate;
  try {
    const response = await fetch('./catalog.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('catalog');
    const catalog = await response.json();
    if (!record(catalog) || !Array.isArray(catalog.augments)) throw new Error('catalog');
    decoder = createAugmentDecoder(catalog);
    setStatus('准备就绪；点击“开始观察”后才会订阅');
    ui.start.disabled = false;
  } catch {
    sdk = null;
    setStatus('本地海克斯目录无法加载；未订阅任何游戏数据');
  }
}

prepare();

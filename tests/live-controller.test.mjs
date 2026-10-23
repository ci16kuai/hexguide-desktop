import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {UI_ELEMENTS} from '../dist/layout-elements.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const items = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const champions = new Map(data.champions.map(champion => [champion.id, champion]));
const augments = new Map(data.augments.map(augment => [augment.id, augment]));
let instance = 0;
const settle = async () => {
  // Drain fetch/json continuations without advancing the controller's timers.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};
const snapshot = (overrides = {}) => ({
  connection: {status: 'connected', message: '已读取本局数据'},
  phase: 'InProgress', gameId: 'game-one', championId: 'Ahri', championSource: 'live-client',
  level: 11, gameTime: 660, currentGold: 1200,
  stats: {abilityPower: 175, attackDamage: 72, abilityHaste: 35}, items: [],
  augments: {status: 'unavailable', ids: []},
  mode: {known: true, isMayhem: true, queueId: 2400}, ...overrides
});

async function browserHarness(t, {initial = snapshot(), championId = 'Ahri', owned = ['firebrand'], stored = {}, gameId = null, initialHash = '#live'} = {}) {
  const globals = ['location', 'sessionStorage', 'history', 'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'Date'];
  const original = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const realSetTimeout = globalThis.setTimeout;
  const intervals = [], delays = [], clicks = [], unload = [], liveReplies = [], ocrReplies = [], deferred = [];
  const session = new Map([['hexguide-local-session', 'test-only-local-session'], ...Object.entries(stored)]);
  const state = {championId, owned: [...owned], gameId, resets: 0, offers: [], renders: 0, ocrRequests: 0};
  let nextSnapshot = initial;
  let sidebarModel={ocr:{enabled:false,status:'disabled',message:'',proposals:[],observedAt:null}};
  const OriginalDate = globalThis.Date;
  let currentTime = OriginalDate.now();
  const define = (key, value) => Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  define('Date', class extends OriginalDate { static now() { return currentTime; } });
  define('location', {hash: initialHash});
  define('sessionStorage', {
    getItem: key => session.has(key) ? session.get(key) : null,
    setItem: (key, value) => session.set(key, String(value)),
    removeItem: key => session.delete(key)
  });
  define('history', {replaceState(_state, _title, url) { if (url?.startsWith('#')) location.hash = url; }});
  define('window', {addEventListener(name, callback) { if (name === 'pagehide') unload.push(callback); }});
  define('document', {addEventListener(name, callback) { if (name === 'click') clicks.push(callback); }});
  define('setInterval', callback => { intervals.push(callback); return intervals.length; });
  define('clearInterval', () => {});
  define('setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 3000) { delays.push(() => callback(...args)); return delays.length; }
    return realSetTimeout(callback, milliseconds, ...args);
  });
  define('fetch', async (url, options={}) => {
    if (url === './items.json') return {ok: true, json: async () => items};
    if (url === '/api/sidebar') return {ok:true,json:async()=>structuredClone(sidebarModel)};
    if (url === '/api/sidebar/ocr') {sidebarModel.ocr.enabled=JSON.parse(options.body).enabled;return {ok:true,json:async()=>structuredClone(sidebarModel)};}
    if (url === '/api/live') {
      const value = liveReplies.length ? await liveReplies.shift() : nextSnapshot;
      if (value instanceof Error) throw value;
      return {ok: true, json: async () => value};
    }
    if (url === '/api/ocr') {
      state.ocrRequests++;
      const value = ocrReplies.length ? await ocrReplies.shift() : {status: 'unavailable', proposals: []};
      return {ok: true, json: async () => value};
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  const {createLiveController} = await import(`../dist/live.js?test-instance=${++instance}`);
  const controller = createLiveController({
    getChampion: () => champions.get(state.championId),
    getChampionById: id => champions.get(id),
    getOwned: () => state.owned.map(id => augments.get(id)).filter(Boolean),
    getRoute: () => 'auto', getAugments: () => data.augments,
    getGameId: () => state.gameId,
    onGameId: id => { state.gameId = id; },
    renderLive: () => { state.renders++; },
    onChampion: id => { state.championId = id; },
    onNewGame: () => { state.owned = []; state.resets++; },
    onOffers: ids => { state.offers.push(ids); }
  });
  await settle();
  t.after(async () => {
    for (const callback of unload) callback();
    for (const pending of deferred) pending.resolve(pending.kind === 'live' ? snapshot() : {status: 'unavailable', proposals: []});
    for (const delay of delays.splice(0)) delay();
    await settle();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const pendingReply = kind => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    (kind === 'live' ? liveReplies : ocrReplies).push(promise);
    deferred.push({kind, resolve});
    return resolve;
  };
  return {
    state, controller, session,
    advance(milliseconds) { currentTime += milliseconds; },
    setSidebar(value) { sidebarModel=value; },
    html: () => controller.html(),
    deferLive: () => pendingReply('live'), deferOcr: () => pendingReply('ocr'),
    async tick(value) { if (value !== undefined) nextSnapshot = value; for (const callback of intervals) callback(); await settle(); },
    async click(action) { for (const callback of clicks) callback({target: {closest: () => ({dataset: {liveAction: action}})}}); await settle(); },
    async finishScanDelay() { for (const callback of delays.splice(0)) callback(); await settle(); }
  };
}

test('local session bootstrap opens match home and removes the token from the visible URL', {concurrency: false}, async t => {
  const h=await browserHarness(t,{initialHash:'#session=fixture-local-session'});
  assert.equal(location.hash,'#live');
  assert.equal(h.session.get('hexguide-local-session'),'fixture-local-session');
  assert.match(h.html(),/data-ui-id="live-title"[^>]*>我的这一局/);
});

test('live controller follows game boundaries without presenting drafts as current game data', {concurrency: false}, async t => {
  await t.test('ChampSelect follows the hero but keeps unavailable game stats unknown', async t => {
    const h = await browserHarness(t, {initial: snapshot({phase: 'ChampSelect', championId: 'Jinx', championSource: 'champ-select', gameId: null, gameTime: null, level: null, stats: {}})});
    assert.equal(h.state.championId, 'Jinx');
    assert.match(h.html(), /<dt>游戏时间<\/dt><dd>—<\/dd>/);
    assert.doesNotMatch(h.html(), /机制建议 · 已读取本局数据/);
    assert.doesNotMatch(h.html(), /<dt>游戏时间<\/dt><dd>0:00<\/dd>/);
  });

  await t.test('entering another champion selection clears the previous game augments', async t => {
    const h = await browserHarness(t);
    assert.deepEqual(h.state.owned, ['firebrand']);
    await h.tick(snapshot({phase: 'ChampSelect', championId: 'Jinx', championSource: 'champ-select', gameId: null, gameTime: null}));
    assert.equal(h.state.championId, 'Jinx');
    assert.deepEqual(h.state.owned, []);
    assert.equal(h.state.resets, 1);
  });

  await t.test('a game clock restart clears augments even when no LCU game id exists', async t => {
    const h = await browserHarness(t, {initial: snapshot({gameId: null, gameTime: 900})});
    await h.tick(snapshot({gameId: null, gameTime: 5}));
    assert.deepEqual(h.state.owned, []);
    assert.equal(h.state.resets, 1);
  });

  await t.test('manual hero selection stops follow and preserves a known non-Mayhem gate', async t => {
    const h = await browserHarness(t);
    h.controller.manualChampion();
    h.state.championId = 'Jinx';
    await h.tick(snapshot({championId: 'Ahri', mode: {known: true, isMayhem: false, queueId: 450}}));
    assert.equal(h.state.championId, 'Jinx');
    assert.match(h.html(), /<h2\b[^>]*>当前模式不是海克斯大乱斗<\/h2>/);
    assert.doesNotMatch(h.html(), /<h3>保持普攻输出<\/h3>/);
    await h.click('follow');
    assert.equal(h.state.championId, 'Ahri');
  });

  await t.test('demo isolates its hero and augments without changing the real selection', async t => {
    const h = await browserHarness(t, {initial: snapshot({championId: 'Jinx'}), championId: 'Jinx'});
    await h.click('sample');
    assert.equal(h.state.championId, 'Jinx');
    assert.deepEqual(h.state.owned, ['firebrand']);
    assert.match(h.html(), /阿狸的可选玩法/);
    assert.match(h.html(), /演示数据 · 机制参考/);
    assert.match(h.html(), /已确认 0 个海克斯/);
    assert.doesNotMatch(h.html(), /<span class="subtle-tag">机制建议 · 已读取本局数据<\/span>/);
  });

  await t.test('a live response already in flight cannot apply after pause', async t => {
    const h = await browserHarness(t);
    const resolve = h.deferLive();
    await h.tick();
    await h.click('pause');
    resolve(snapshot({championId: 'Jinx', stats: {abilityPower: 999}}));
    await settle();
    assert.equal(h.state.championId, 'Ahri');
    assert.match(h.html(), /同步已暂停/);
    assert.doesNotMatch(h.html(), /999/);
  });

  await t.test('a live response already in flight cannot overwrite a demo', async t => {
    const h = await browserHarness(t, {initial: snapshot({championId: 'Jinx'}), championId: 'Jinx'});
    const resolve = h.deferLive();
    await h.tick();
    await h.click('sample');
    resolve(snapshot({championId: 'Gwen', stats: {abilityPower: 999}}));
    await settle();
    assert.equal(h.state.championId, 'Jinx');
    assert.match(h.html(), /演示数据 · 机制参考/);
    assert.match(h.html(), /<dt>法术强度<\/dt><dd>175<\/dd>/);
    assert.doesNotMatch(h.html(), /999/);
  });

  await t.test('an OCR response from the previous game cannot restore obsolete offers', async t => {
    const h = await browserHarness(t);
    const resolve = h.deferOcr();
    await h.click('ocr-scan');
    assert.match(h.html(), /请在 3 秒内切回游戏/);
    await h.finishScanDelay();
    assert.equal(h.state.ocrRequests, 1);
    await h.tick(snapshot({gameId: 'game-two', gameTime: 3}));
    resolve({status: 'recognized', message: 'OLD_OCR_RESULT', proposals: [
      {id: 'firebrand', name: '火上浇油'}, {id: 'goliath', name: '歌利亚巨人'}, {id: 'jeweled_gauntlet', name: '珠光护手'}
    ]});
    await settle();
    assert.doesNotMatch(h.html(), /OLD_OCR_RESULT/);
    assert.doesNotMatch(h.html(), /核对无误，带入三选一/);
    await h.click('ocr-confirm');
    assert.deepEqual(h.state.offers, []);
    assert.deepEqual(h.state.owned, []);
  });

  await t.test('valid offers survive an empty scan but never have their age extended by polling', async t => {
    const h = await browserHarness(t);
    const resolve = h.deferOcr();
    await h.click('ocr-scan');
    await h.finishScanDelay();
    resolve({status:'recognized', message:'VERIFIED_CARD_TITLES',proposals:[
      {id:'firebrand',name:'火上浇油'},{id:'goliath',name:'歌利亚巨人'},{id:'jeweled_gauntlet',name:'珠光护手'}
    ]});
    await settle();
    assert.match(h.html(), /VERIFIED_CARD_TITLES/);
    assert.equal(h.state.offers.length,1,'complete recognized cards populate comparison immediately');
    assert.deepEqual(h.state.owned,['firebrand'],'recognizing candidates never selects one');
    h.advance(10000);
    await h.click('ocr-scan');await h.finishScanDelay();
    await h.tick();
    assert.match(h.html(), /VERIFIED_CARD_TITLES/);
    assert.match(h.html(), /最近识别 · 10 秒前/);
    await h.click('ocr-confirm');
    assert.equal(h.state.offers.length,1);
    h.advance(51000);
    await h.tick();
    assert.doesNotMatch(h.html(), /核对无误，带入三选一/);
    assert.doesNotMatch(h.html(), /VERIFIED_CARD_TITLES/);
    await h.click('ocr-confirm');
    assert.equal(h.state.offers.length,1,'expired offers cannot be adopted');
  });

  await t.test('automatic OCR runs in the backend and its offers hydrate the main window',async t=>{
    const h=await browserHarness(t);
    await h.click('ocr-auto');
    assert.match(h.html(),/自动扫描已开/);
    h.advance(10000);await h.tick();
    assert.equal(h.state.ocrRequests,0,'the frontend never starts its own automatic capture loop');
    h.setSidebar({ocr:{enabled:true,status:'recognized',message:'BACKGROUND_VERIFIED_OFFERS',observedAt:new Date(Date.now()).toISOString(),proposals:[
      {id:'firebrand',name:'火上浇油'},{id:'goliath',name:'歌利亚巨人'},{id:'jeweled_gauntlet',name:'珠光护手'}
    ]}});
    await h.tick();assert.match(h.html(),/BACKGROUND_VERIFIED_OFFERS/);
    assert.equal(h.state.offers.length,1,'background cards populate comparison without a second confirmation');
    assert.deepEqual(h.state.owned,['firebrand'],'background detection does not adopt any candidate');
    await h.tick();assert.equal(h.state.offers.length,1,'the same frame is not published repeatedly');
    h.advance(7000);h.setSidebar({ocr:{enabled:true,status:'recognized',message:'SAME_NEW_FRAME',observedAt:new Date(Date.now()).toISOString(),proposals:[
      {id:'firebrand',name:'火上浇油'},{id:'goliath',name:'歌利亚巨人'},{id:'jeweled_gauntlet',name:'珠光护手'}
    ]}});
    await h.tick();assert.equal(h.state.offers.length,1,'rescanning identical cards does not reopen a consumed round');
    await h.click('ocr-confirm');assert.equal(h.state.offers.length,1);
  });

  await t.test('a disconnected snapshot does not leave old stats or items on screen', async t => {
    const h = await browserHarness(t, {initial: snapshot({items: [{id: 3089, name: 'TEST_OLD_ITEM', count: 1}]})});
    assert.match(h.html(), /TEST_OLD_ITEM/);
    await h.tick({connection: {status: 'waiting', message: '游戏已关闭'}, phase: 'None', championId: null, stats: {}, items: [], mode: {known: false}});
    assert.match(h.html(), /等待连接/);
    assert.match(h.html(), /<dt>法术强度<\/dt><dd>—<\/dd>/);
    assert.doesNotMatch(h.html(), /TEST_OLD_ITEM/);
  });
});

test('live editor targets keep valid stable identities through polling and conditional notices', {concurrency: false}, async t => {
  const registry = new Map(UI_ELEMENTS.map(element => [element.id, element]));
  const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const inspect = html => {
    const stack = [{tag: 'live-root', container: 'live-content'}], seen = new Set();
    for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)(\s[^>]*|)>/gi)) {
      const [,closing,rawTag,attributes] = match, tag = rawTag.toLowerCase();
      if (closing) {
        const index = stack.findLastIndex(entry => entry.tag === tag);
        if (index > 0) stack.length = index;
        continue;
      }
      const id = /\bdata-ui-id="([^"]+)"/.exec(attributes)?.[1];
      const container = /\bdata-ui-container="([^"]+)"/.exec(attributes)?.[1];
      if (id) {
        assert.ok(registry.has(id), `unregistered editor target ${id}`);
        assert.ok(!seen.has(id), `duplicate editor target ${id}`);
        seen.add(id);
        assert.equal(registry.get(id).parent, stack.at(-1).container || null, `incorrect parent for ${id}`);
        assert.equal(Boolean(container), registry.get(id).container, `incorrect container flag for ${id}`);
        if (container) assert.equal(container, id);
      }
      if (!voidTags.has(tag)) stack.push({tag,container});
    }
    return seen;
  };
  const h = await browserHarness(t);
  const initial = inspect(h.html());
  for (const id of ['live-title','live-background-guide','live-connection','live-champion','live-stats','live-stat-ap','live-owned-note','live-ocr','live-plan','live-next','live-help']) assert.ok(initial.has(id), id);
  await h.tick(snapshot({level: 12,gameTime: 690,stats: {abilityPower: 200}}));
  assert.deepEqual(inspect(h.html()), initial, 'data refresh does not change layout identities');
  await h.click('ocr-auto');
  assert.ok(inspect(h.html()).has('live-ocr-notice'));
  h.setSidebar({ocr:{enabled:true,status:'recognized',message:'编辑目标测试',observedAt:new Date(Date.now()).toISOString(),proposals:[
    {id:'firebrand',name:'火上浇油'},{id:'goliath',name:'歌利亚巨人'},{id:'jeweled_gauntlet',name:'珠光护手'}
  ]}});
  await h.tick();
  const withOffers = inspect(h.html());
  assert.ok(withOffers.has('live-ocr-confirm'));
  assert.ok(withOffers.has('live-ocr-proposals'));
  assert.ok(!withOffers.has('live-ocr-manual'));
  await h.click('sample');
  assert.ok(inspect(h.html()).has('live-sample-notice'));
  await h.click('sample');
  await h.tick(snapshot({mode: {known: true,isMayhem: false,queueId: 450}}));
  assert.ok(inspect(h.html()).has('live-mode-notice'));
});

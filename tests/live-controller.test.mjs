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
  const intervals = [], delays = [], clicks = [], unload = [], liveReplies = [], ocrReplies = [], sidebarReplies = [], deferred = [];
  const session = new Map([['hexguide-local-session', 'test-only-local-session'], ...Object.entries(stored)]);
  const state = {championId, owned: [...owned], gameId, resets: 0, offers: [], currentOffers: [], expired: 0, renders: 0, ocrRequests: 0, confirmations: [], sessionResets: [], pendingConfirmed: 0, explicitReset: 0, session: null};
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
    if (url === '/api/sidebar') {const model=sidebarReplies.length?await sidebarReplies.shift():structuredClone(sidebarModel);if(model instanceof Error)throw model;return {ok:true,json:async()=>model};}
    if (url === '/api/session/confirm') {state.confirmations.push(JSON.parse(options.body));return {ok:true,json:async()=>structuredClone(sidebarModel)};}
    if (url === '/api/session/reset') {state.sessionResets.push(JSON.parse(options.body));return {ok:true,json:async()=>structuredClone(sidebarModel)};}
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
    getSessionContext: () => state.session,
    onGameId: id => { state.gameId = id; },
    renderLive: () => { state.renders++; },
    onChampion: id => { state.championId = id; },
    onNewGame: () => { state.owned = []; state.currentOffers=[]; state.resets++; },
    onOffers: (ids,meta) => { if(state.rejectOffers)return false;state.offers.push(ids); state.currentOffers=[...ids];state.offerScope=meta; },
    onOffersExpired: () => { state.currentOffers=[]; state.expired++; },
    onPendingConfirmed: () => { state.pendingConfirmed++; },
    onSessionReset: () => { state.explicitReset++; }
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
    (kind === 'live' ? liveReplies : kind === 'sidebar' ? sidebarReplies : ocrReplies).push(promise);
    deferred.push({kind, resolve});
    return resolve;
  };
  return {
    state, controller, session,
    advance(milliseconds) { currentTime += milliseconds; },
    setSidebar(value) { sidebarModel=value; },
    html: () => controller.html(),
    deferLive: () => pendingReply('live'), deferOcr: () => pendingReply('ocr'), deferSidebar: () => pendingReply('sidebar'),
    failLive(error = new Error('temporary API failure')) { liveReplies.push(error); },
    failSidebar(error = new Error('temporary API failure')) { sidebarReplies.push(error); },
    async tick(value) { if (value !== undefined) nextSnapshot = value; for (const callback of intervals) callback(); await settle(); },
    async click(action, dataset = {}) { for (const callback of clicks) callback({target: {closest: () => ({dataset: {liveAction: action, ...dataset}})}}); await settle(); },
    async finishScanDelay() { for (const callback of delays.splice(0)) callback(); await settle(); }
  };
}

test('local session bootstrap opens match home and removes the token from the visible URL', {concurrency: false}, async t => {
  const h=await browserHarness(t,{initialHash:'#session=fixture-local-session'});
  assert.equal(location.hash,'#live');
  assert.equal(h.session.get('hexguide-local-session'),'fixture-local-session');
  assert.match(h.html(),/data-ui-id="live-title"[^>]*>我的这一局/);
});

const pendingGroup=(pendingId,sequence,ids,active=false)=>({pendingId,sequence,active,createdAt:Date.now()-360000,offers:ids.map(id=>{const a=augments.get(id);return {id,name:a.name,icon:a.icon,rarity:a.rarity};})});
const firstIds=['firebrand','goliath','jeweled_gauntlet'],nextIds=['transmute_prismatic','recursion','shrink_engine'];
const pendingModel=(groups,overrides={})=>({gameId:'game-one',gameEpoch:4,sessionRevision:12,pendingRevision:12,owned:[],pendingOffers:groups,offers:groups.at(-1)?.offers||[],ocr:{enabled:true,status:'waiting',message:'当前未读到卡片',proposals:[],observedAt:new Date(Date.now()-360000).toISOString()},...overrides});

test('new authoritative candidates received while dead publish without any alive snapshot', {concurrency:false}, async t=>{
  const dead=snapshot({isDead:true,life:{status:'detected',isDead:true}});
  const h=await browserHarness(t,{owned:[],initial:dead});
  h.setSidebar(pendingModel([]));await h.tick(dead);
  assert.deepEqual(h.state.currentOffers,[]);
  const group=pendingGroup('death-round',1,nextIds,true);
  h.setSidebar(pendingModel([group],{pendingRevision:13,life:{status:'detected',isDead:true}}));
  await h.tick(dead);
  assert.deepEqual(h.state.currentOffers,nextIds);
  assert.deepEqual(h.state.owned,[],'dead candidates are displayed, not silently adopted');
  h.advance(1000);await h.tick(dead);
  assert.deepEqual(h.state.currentOffers,nextIds,'a repeated dead snapshot keeps the newly delivered cards visible');
});

test('server pending choices survive death, old observations, pause and temporary disconnects', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  const group=pendingGroup('round-one',1,firstIds,true);
  h.setSidebar(pendingModel([group]));await h.tick();
  assert.deepEqual(h.state.currentOffers,firstIds,'an observation older than five minutes still hydrates authoritative pending choices');
  assert.match(h.html(),/待确认，已保留/);
  assert.match(h.html(),/最近识别 · 360 秒前/,'numeric server creation times preserve the actual age');
  h.advance(61000);await h.tick(snapshot({isDead:true}));
  assert.deepEqual(h.state.currentOffers,firstIds);
  h.advance(360000);await h.tick(snapshot({isDead:true}));
  assert.deepEqual(h.state.currentOffers,firstIds);
  await h.click('pause');h.advance(360000);await h.tick();
  assert.deepEqual(h.state.currentOffers,firstIds,'pausing does not turn unconfirmed choices into expired frames');
  assert.match(h.html(),/火上浇油/);
  await h.click('pause');
  h.failLive();await h.tick();
  assert.match(h.html(),/等待连接/);
  assert.deepEqual(h.state.currentOffers,firstIds,'a failed live API read preserves the last server pending state');
  h.failSidebar();await h.tick(snapshot({connection:{status:'waiting',message:'暂时断开'},phase:'None',gameId:null,gameTime:null}));
  assert.deepEqual(h.state.currentOffers,firstIds,'an unavailable nonterminal snapshot also preserves pending choices');
  assert.deepEqual(h.state.owned,[],'retaining candidates never selects them');
});

test('pending publication retries after local session hydration initially rejects the cards', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});h.state.rejectOffers=true;
  h.setSidebar(pendingModel([pendingGroup('round-one',1,firstIds,true)]));await h.tick();
  assert.deepEqual(h.state.currentOffers,[]);
  h.state.rejectOffers=false;await h.tick();
  assert.deepEqual(h.state.currentOffers,firstIds,'a rejected callback does not mark the server group as already displayed');
});

test('newest pending choices publish independently while older rounds can be confirmed by identity', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  const old=pendingGroup('old-round',1,firstIds),latest=pendingGroup('new-round',2,nextIds,true);
  h.setSidebar(pendingModel([old,latest]));await h.tick();
  assert.deepEqual(h.state.currentOffers,nextIds);
  assert.match(h.html(),/较早轮次待确认/);
  assert.match(h.html(),/第 1 轮 · 待确认/);
  assert.match(h.html(),/data-pending-id="old-round" data-id="firebrand"/);
  assert.deepEqual(h.state.owned,[]);
  h.setSidebar(pendingModel([latest],{sessionRevision:13,owned:[{id:'firebrand'}]}));
    await h.click('pending-confirm',{pendingId:'old-round',id:'firebrand',gameId:'game-one',revision:'12'});
  assert.deepEqual(h.state.confirmations,[{id:'firebrand',pendingId:'old-round',gameId:'game-one',revision:12}]);
  assert.equal(h.state.pendingConfirmed,1,'the app is told to pull the authoritative selected session');
  assert.deepEqual(h.state.currentOffers,nextIds,'confirming an older round leaves the newer choices visible');
  assert.doesNotMatch(h.html(),/较早轮次待确认/);
    await h.click('pending-confirm',{pendingId:'old-round',id:'goliath',gameId:'game-one',revision:'12'});
  assert.equal(h.state.confirmations.length,1,'a removed pending identity cannot be submitted again');
});

test('selection resynchronizes remaining rounds and authoritative empty state suppresses old OCR', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  const old=pendingGroup('old-round',1,firstIds),latest=pendingGroup('new-round',2,nextIds,true);
  h.setSidebar(pendingModel([old,latest]));await h.tick();
  h.state.owned=[nextIds[0]];
  h.setSidebar(pendingModel([{...old,active:true}],{sessionRevision:13,owned:[{id:nextIds[0]}]}));
  h.controller.confirmedSelection();await settle();
  assert.deepEqual(h.state.currentOffers,firstIds,'selecting the latest round reveals the remaining unresolved round');
  h.setSidebar(pendingModel([],{sessionRevision:14,ocr:{enabled:true,status:'recognized',proposals:old.offers,observedAt:new Date(Date.now()).toISOString()}}));
  await h.tick();
  assert.deepEqual(h.state.currentOffers,[],'an authoritative empty pending list clears stale choices even when OCR still contains names');
  assert.doesNotMatch(h.html(),/识别到的候选海克斯|较早轮次待确认/);
  await h.click('ocr-confirm');assert.deepEqual(h.state.currentOffers,[]);
});

test('the latest pending triple confirms through its scoped endpoint and keeps older rounds', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  const old=pendingGroup('old-round',1,firstIds),latest=pendingGroup('new-round',2,nextIds,true);
  h.setSidebar(pendingModel([old,latest]));await h.tick();
  h.setSidebar(pendingModel([{...old,active:true}],{sessionRevision:13,owned:[{id:nextIds[0]}]}));
  assert.equal(h.controller.confirmCandidate(nextIds[0],'new-round',{gameId:'game-one',revision:12}),true);await settle();
  assert.deepEqual(h.state.confirmations,[{id:nextIds[0],pendingId:'new-round',gameId:'game-one',revision:12}]);
  assert.deepEqual(h.state.currentOffers,firstIds);
  assert.equal(h.controller.confirmCandidate('not-a-choice',''),true,'missing pending guards are consumed while a server pending group exists');
});

test('identical triples in different rounds still publish the newest active pending identity', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  h.setSidebar(pendingModel([pendingGroup('old-identical',1,firstIds),pendingGroup('latest-identical',2,firstIds,true)]));await h.tick();
  assert.equal(h.state.offerScope.pendingId,'latest-identical');
  assert.match(h.html(),/data-pending-id="old-identical"/);
  assert.doesNotMatch(h.html(),/data-pending-id="latest-identical"/,'the latest triple stays in the main comparison instead of the older list');
});

test('pending game, epoch and revision guards reject stale sidebar responses', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  const old=pendingGroup('old-round',1,firstIds,true);
  h.setSidebar(pendingModel([old]));await h.tick();
  h.setSidebar(pendingModel([],{sessionRevision:13}));await h.tick();
  h.setSidebar(pendingModel([old]));await h.tick();
  assert.deepEqual(h.state.currentOffers,[],'an older server revision cannot reopen a confirmed group');
  h.setSidebar(pendingModel([old],{gameEpoch:3,sessionRevision:14}));await h.tick();
  assert.deepEqual(h.state.currentOffers,[],'a previous game epoch cannot reopen a group');
  const resolve=h.deferSidebar();await h.tick();
  await h.click('pause');resolve(pendingModel([old],{sessionRevision:15}));await settle();
  assert.deepEqual(h.state.currentOffers,[],'an in-flight sidebar reply cannot change paused state');
  h.setSidebar(pendingModel([old],{sessionRevision:15}));await h.click('pause');
  assert.deepEqual(h.state.currentOffers,firstIds);
  await h.tick(snapshot({gameId:'game-two',gameTime:3}));
  assert.deepEqual(h.state.currentOffers,[],'a true game boundary clears the previous pending cache');
  assert.doesNotMatch(h.html(),/待确认，已保留/);
  assert.equal(h.state.resets,1);
});

test('a clock restart with the same game id requires a new server epoch before accepting pending choices', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  const group=pendingGroup('old-round',1,firstIds,true);
  h.setSidebar(pendingModel([group]));await h.tick();
  await h.tick(snapshot({gameTime:3}));
  assert.deepEqual(h.state.currentOffers,[]);
  h.setSidebar(pendingModel([pendingGroup('next-game-round',1,nextIds,true)],{gameEpoch:5,sessionRevision:13}));
  await h.tick(snapshot({gameTime:5}));
  assert.deepEqual(h.state.currentOffers,nextIds);
});

test('a sidebar read started before confirmation cannot restore its resolved pending group', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  const old=pendingGroup('old-round',1,firstIds),latest=pendingGroup('new-round',2,nextIds,true),before=pendingModel([old,latest]);
  h.setSidebar(before);await h.tick();
  const resolve=h.deferSidebar();await h.tick();
  h.setSidebar(pendingModel([{...old,active:true}],{sessionRevision:13,owned:[{id:nextIds[0]}]}));
  h.controller.confirmCandidate(nextIds[0],'new-round',{gameId:'game-one',revision:12});await settle();
  assert.deepEqual(h.state.currentOffers,firstIds);
  resolve(before);await settle();
  assert.deepEqual(h.state.currentOffers,firstIds,'the completed confirmation revision wins over the old in-flight read');
  assert.doesNotMatch(h.html(),/data-pending-id="new-round"/);
});

test('an older in-flight sidebar read cannot revert a reroll with the same selected-session revision', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]}),before=pendingModel([pendingGroup('before-reroll',1,firstIds,true)]);
  h.setSidebar(before);await h.tick();
  const resolve=h.deferSidebar();await h.tick();
  h.setSidebar(pendingModel([pendingGroup('after-reroll',1,nextIds,true)],{pendingRevision:13}));
  await h.click('ocr-auto');assert.deepEqual(h.state.currentOffers,nextIds);
  resolve(before);await settle();
  assert.deepEqual(h.state.currentOffers,nextIds,'pendingRevision advances independently of selected ownership');
  h.failLive();await h.tick();h.setSidebar(before);await h.tick();
  assert.deepEqual(h.state.currentOffers,nextIds,'temporary connection failure keeps the pending revision watermark');
});

test('overlapping owned candidates do not resolve a different pending round', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:['firebrand']});
  const group=pendingGroup('older-round',1,firstIds,true);
  h.setSidebar(pendingModel([group],{sessionRevision:13,owned:[{id:'firebrand'}]}));await h.tick();
  assert.deepEqual(h.state.currentOffers,firstIds,'the whole triple stays visible when only one candidate is already owned from another round');
  h.controller.confirmedSelection();await settle();
  assert.deepEqual(h.state.currentOffers,firstIds,'ownership reconciliation cannot infer which pending group was selected');
});

test('rendered pending identity and revision never retarget a stale same-name candidate click', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  h.setSidebar(pendingModel([pendingGroup('before-reroll',1,firstIds,true)]));await h.tick();
  h.setSidebar(pendingModel([pendingGroup('after-reroll',1,firstIds,true)],{sessionRevision:13}));await h.tick();
  assert.equal(h.controller.confirmCandidate(firstIds[0],'before-reroll',{gameId:'game-one',revision:12}),true);
  await settle();assert.deepEqual(h.state.confirmations,[],'the stale guarded click is consumed without using the new pending identity');
  h.controller.confirmCandidate(firstIds[0],'after-reroll',{gameId:'game-one',revision:12});await settle();
  assert.deepEqual(h.state.confirmations,[],'a stale rendered revision cannot inherit fresh guards');
  assert.match(h.html(),/本局选择已变化/);
  assert.equal(h.controller.confirmCandidate(firstIds[0],'',{gameId:null,revision:0}),true,'missing guards are consumed while authoritative pending state exists');
  await settle();assert.deepEqual(h.state.confirmations,[]);
});

test('explicit reset clears pending even when no selected augments or route delta exists', {concurrency:false}, async t=>{
  const h=await browserHarness(t,{owned:[]});
  h.setSidebar(pendingModel([pendingGroup('unconfirmed',1,firstIds,true)]));await h.tick();
  h.setSidebar(pendingModel([],{sessionRevision:13}));
  assert.equal(h.controller.resetSession(),true);await settle();
  assert.deepEqual(h.state.sessionResets,[{gameId:'game-one',revision:12}]);
  assert.equal(h.state.explicitReset,1);
  assert.deepEqual(h.state.currentOffers,[]);
  await h.tick();assert.deepEqual(h.state.currentOffers,[]);
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

  await t.test('loading with InProgress phase rejects old sidebar offers and delayed OCR without choosing or republishing them',async t=>{
    const h=await browserHarness(t);
    const resolve=h.deferOcr();
    await h.click('ocr-scan');await h.finishScanDelay();
    h.setSidebar({ocr:{enabled:true,status:'recognized',message:'OLD_LOADING_OFFERS',observedAt:new Date(Date.now()).toISOString(),proposals:[
      {id:'firebrand',name:'火上浇油'},{id:'goliath',name:'歌利亚巨人'},{id:'jeweled_gauntlet',name:'珠光护手'}
    ]}});
    await h.tick(snapshot({stage:'loading',championSource:'loading-screen',gameTime:null}));
    resolve({status:'recognized',message:'OLD_IN_FLIGHT_OFFERS',proposals:[
      {id:'firebrand',name:'火上浇油'},{id:'goliath',name:'歌利亚巨人'},{id:'jeweled_gauntlet',name:'珠光护手'}
    ]});
    await settle();
    await h.click('ocr-confirm');
    assert.deepEqual(h.state.offers,[]);
    assert.doesNotMatch(h.html(),/OLD_LOADING_OFFERS|OLD_IN_FLIGHT_OFFERS/);
    await h.click('ocr-scan');await h.finishScanDelay();
    assert.equal(h.state.ocrRequests,1,'loading never starts an extra scan');
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

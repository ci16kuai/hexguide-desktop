// Isolated collector/clock/OCR fixtures. No installed app, network or game input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar} from '../server/sidebar.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const ids = data.augments.filter(a => a.availability === 'current' && a.recommendable !== false && !a.retiredPatch && !a.isInternalTemplate).slice(0, 3).map(a => a.id);
const noCards = {status:'waiting', code:'title-name-unmatched', proposals:[]};
const capture = time => ({capturedAt:time, width:1920, height:1080, originX:0, originY:0, windowHandle:'12345',
  regions:[0, 1, 2].map(column => ({column, x:400 + column * 400, y:200, width:300, height:550, signature:Array(192).fill(80)})),
  identityAnchors:{version:1, algorithm:'luma-sobel-16x8-v1', frameId:'synthetic-event-window', pass:'card-titles-color',
    cards:[0, 1, 2].map(column => ({column, anchors:[{box:{x:430 + column * 400, y:350, width:180, height:24},
      feature:Array.from({length:128}, (_, index) => index % 2 ? 16 : 0)}]}))}});
const cards = time => ({status:'recognized', proposals:ids.map(id => ({id})), ...(time === undefined ? {} : {selectionCapture:capture(time)})});

function harness({scanner, dataDirectory, timers} = {}) {
  let now = Date.parse('2026-10-25T05:00:00Z'), scans = 0;
  let live = {connection:{status:'connected'}, phase:'InProgress', stage:'live', gameId:'isolated-schedule-one', championId:'Vi', level:3, gameTime:1,
    life:{status:'detected', isDead:false}, mode:{known:true, isMayhem:true}, items:[], stats:{}, observedAt:new Date(now).toISOString()};
  const advance = ms => { now += ms; live.observedAt = new Date(now).toISOString(); if (typeof live.gameTime === 'number') live.gameTime += ms / 1000; };
  const sidebar = new BackgroundSidebar({collector:{getSnapshot:() => structuredClone(live)}, data, dataDirectory, timers, now:() => now,
    scanner:() => { scans++; return scanner ? scanner({advance, scans, time:() => now}) : Promise.resolve(noCards); }});
  return {sidebar, advance, update:value => { live = {...live, ...value}; }, scans:() => scans, time:() => now};
}

test('loading remains zero OCR and entering live starts one window independently of the UI', async t => {
  const h = harness(); t.after(() => h.sidebar.stop());
  h.update({phase:'GameStart', stage:'loading', level:null, gameTime:null, connection:{status:'waiting'}, life:{status:'unavailable', isDead:null}});
  for (let n = 0; n < 12; n++) { await h.sidebar.pollOnce(); h.advance(2000); }
  assert.equal(h.scans(), 0); assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'loading');
  h.advance(1);
  h.update({phase:'InProgress', stage:'live', level:3, gameTime:1, connection:{status:'connected'}, life:{status:'detected', isDead:false}});
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 1); assert.equal(h.sidebar.getModel().ocr.schedule.trigger, 'game-start');
  assert.equal(h.sidebar.getModel().ocr.schedule.windowRemainingMs, 60000);
});

test('mid-game attachment starts scanning at verified death before the respawn refresh', async t => {
  const h = harness(); t.after(() => h.sidebar.stop()); h.update({gameTime:300, level:7});
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 0);
  h.advance(1000); h.update({life:{status:'detected', isDead:true}});
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'window'); assert.equal(h.sidebar.getModel().ocr.schedule.trigger,'death');
  h.advance(1000); h.update({life:{status:'detected', isDead:false}});
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 2); assert.equal(h.sidebar.getModel().ocr.schedule.trigger, 'respawn');
  assert.equal(h.sidebar.getModel().ocr.schedule.windowRemainingMs, 60000);
});

test('slow OCR is serial and rests one hundred milliseconds in the fast and follow-up phases', async t => {
  const h = harness({scanner:async ({advance}) => { advance(8000); return noCards; }});
  t.after(() => h.sidebar.stop());
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  h.advance(99); await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  h.advance(1); await h.sidebar.pollOnce(); assert.equal(h.scans(), 2);
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'window');
  h.advance(60000); await h.sidebar.pollOnce();
  assert.equal(h.scans(), 3); assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'follow-up');
  const windowId = h.sidebar.getModel().ocr.schedule.windowId;
  h.advance(99); await h.sidebar.pollOnce(); assert.equal(h.scans(), 3);
  h.advance(1); await h.sidebar.pollOnce(); assert.equal(h.scans(), 4);
  h.update({level:15}); h.advance(1); await h.sidebar.pollOnce();
  assert.equal(h.scans(), 4, 'a level cannot bypass post-completion rest or restart the fast phase');
  assert.equal(h.sidebar.getModel().ocr.schedule.windowId, windowId);
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'follow-up');
});

test('manual scans stay immediate outside windows and reuse the single capture while busy', async t => {
  let finish;
  const h = harness({scanner:() => new Promise(resolve => { finish = resolve; })});
  t.after(() => h.sidebar.stop()); h.update({gameTime:300});
  const first = h.sidebar.scan(), second = h.sidebar.scan();
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  finish(noCards); await Promise.all([first, second]);
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  const manual = h.sidebar.scan(); assert.equal(h.scans(), 2);
  finish(noCards); await manual;
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'idle');
});

test('automatic scan entry cannot bypass the closed window while manual scan remains available', async t => {
  const h = harness(); t.after(() => h.sidebar.stop()); h.update({gameTime:300});
  const automatic = await h.sidebar.scan({automatic:true});
  assert.equal(automatic.status, 'waiting'); assert.equal(h.scans(), 0);
  await h.sidebar.scan(); assert.equal(h.scans(), 1);
});

test('late old-game OCR releases busy state and cannot postpone the new game scan', async t => {
  let finish;
  const h = harness({scanner:({scans}) => scans === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(noCards)});
  t.after(() => h.sidebar.stop());
  const previousGame = h.sidebar.scan();
  h.advance(1000); h.update({gameId:'isolated-schedule-two', level:3, gameTime:1}); h.sidebar.getModel();
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  finish(noCards); await previousGame;
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 2);
  assert.deepEqual(h.sidebar.getSession().owned, []);
});

test('confirming current offers stops scanning until the next death opportunity regardless of new levels', async t => {
  const h = harness({scanner:async () => cards()}); t.after(() => h.sidebar.stop());
  await h.sidebar.pollOnce(); const offered = h.sidebar.getModel();
  assert.equal(offered.ocr.schedule.mode, 'window');
  const confirmed = await h.sidebar.confirmOffer({id:ids[0], gameId:offered.gameId, revision:offered.sessionRevision});
  assert.equal(confirmed.ocr.schedule.mode, 'idle'); assert.equal(confirmed.ocr.schedule.windowRemainingMs, 0);
  assert.deepEqual(confirmed.plan.ownedIds, [ids[0]]);
  h.update({level:16}); h.advance(1000); await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  h.advance(1000); h.update({life:{status:'detected', isDead:true}}); await h.sidebar.pollOnce();
  h.advance(1000); h.update({life:{status:'detected', isDead:false}}); await h.sidebar.pollOnce();
  assert.equal(h.scans(), 3); assert.equal(h.sidebar.getModel().ocr.schedule.trigger, 'respawn');
});

test('unconfirmed candidates continue every five seconds after the fast phase without renewing it', async t => {
  const h = harness({scanner:async () => cards()}); t.after(() => h.sidebar.stop());
  await h.sidebar.pollOnce(); const original = h.sidebar.getModel().ocr.schedule;
  h.advance(60000); await h.sidebar.pollOnce();
  const followUp = h.sidebar.getModel();
  assert.equal(h.scans(), 2); assert.equal(followUp.offers.length, 3);
  assert.equal(followUp.ocr.schedule.windowId, original.windowId);
  assert.equal(followUp.ocr.schedule.mode, 'follow-up');
  assert.equal(followUp.ocr.schedule.windowRemainingMs, 0);
  assert.equal(followUp.ocr.schedule.intervalMs, 5000);
  h.advance(4999); await h.sidebar.pollOnce(); assert.equal(h.scans(), 2);
  h.advance(1); await h.sidebar.pollOnce(); assert.equal(h.scans(), 3);
  h.advance(300000); await h.sidebar.pollOnce(); assert.equal(h.scans(), 4);
  assert.equal(h.sidebar.getModel().ocr.schedule.windowId, original.windowId);
  assert.equal(h.sidebar.getModel().ocr.schedule.windowRemainingMs, 0);
});

test('an automatic late completion from a previous respawn window cannot publish or arm its cards', async t => {
  let finish;
  const h = harness({scanner:({scans}) => scans === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(noCards)});
  t.after(() => h.sidebar.stop());
  const originalTime = h.time(), first = h.sidebar.scan({automatic:true});
  const originalWindow = h.sidebar.getModel().ocr.schedule.windowId;
  h.advance(1000); h.update({life:{status:'detected', isDead:true}}); h.sidebar.getModel();
  h.advance(1000); h.update({life:{status:'detected', isDead:false}});
  assert.notEqual(h.sidebar.getModel().ocr.schedule.windowId, originalWindow);
  finish(cards(originalTime)); const result = await first;
  assert.equal(result.status, 'waiting'); assert.equal(result.code, 'scan-context-changed');
  assert.equal(h.sidebar.getModel().offers.length, 0); assert.equal(h.sidebar.getSelectionObservation().status, 'waiting');
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 2, 'the late old result cannot impose a new-window cooldown');
});

test('an automatic capture completing across the fast boundary is accepted in the same follow-up cycle', async t => {
  let finish;
  const h = harness({scanner:({scans, time, advance}) => {
    if (scans === 3) return new Promise(resolve => { finish = resolve; });
    advance(1); return Promise.resolve(cards(time()));
  }});
  t.after(() => h.sidebar.stop());
  await h.sidebar.pollOnce(); h.advance(59000); await h.sidebar.pollOnce();
  const observation = h.sidebar.getSelectionObservation(), cycle = h.sidebar.getModel().ocr.schedule.windowId;
  assert.equal(observation.status, 'armed');
  h.advance(500); const lateTime = h.time(), late = h.sidebar.scan({automatic:true});
  h.advance(501); finish(cards(lateTime)); const result = await late;
  assert.equal(result.status, 'recognized');
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'follow-up');
  assert.equal(h.sidebar.getModel().ocr.schedule.windowId, cycle);
  assert.equal(h.sidebar.getModel().offers.length, 3);
  assert.equal(h.sidebar.getSelectionObservation().status, 'armed');
  assert.equal(h.sidebar.getSelectionObservation().capturedAt, lateTime);
  assert.equal(h.sidebar.getSelectionObservation().offerToken, observation.offerToken);
});

test('two same-offer captures spanning the fast boundary retain their evidence and permit confirmed selection', async t => {
  const h = harness({scanner:async ({advance, time}) => { advance(1); return cards(time()); }});
  t.after(() => h.sidebar.stop()); h.sidebar.getModel();
  h.advance(58000); await h.sidebar.pollOnce();
  const first = h.sidebar.getSelectionObservation(), cycle = h.sidebar.getModel().ocr.schedule.windowId;
  assert.equal(first.status, 'armed');
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'window');
  h.advance(5000); await h.sidebar.pollOnce();
  const second = h.sidebar.getSelectionObservation();
  assert.equal(second.status, 'armed');
  assert.ok(second.capturedAt > first.capturedAt);
  assert.equal(second.offerToken, first.offerToken);
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'follow-up');
  assert.equal(h.sidebar.getModel().ocr.schedule.windowId, cycle);
  // Synthetic provider evidence verifies retained capture history, not actual
  // visual accuracy. The earlier capture remains valid after the fresh rearm.
  const model = await h.sidebar.observeSelectionEvidence({provider:'screen', offerToken:first.offerToken,
    gameId:first.gameId, gameEpoch:first.gameEpoch, revision:first.revision, ids:[...first.ids], selectedIndex:1,
    capturedAt:first.capturedAt, clickedAt:h.time(), observedAt:h.time(),
    evidence:{click:true, uniqueFeedback:true, cardsDismissed:true, stableFrames:3, feedbackFrames:1}});
  assert.deepEqual(model.plan.ownedIds, [ids[1]]);
  assert.equal(model.ocr.schedule.mode, 'idle');
  assert.equal(model.offers.length, 0);
  h.advance(300000); await h.sidebar.pollOnce(); assert.equal(h.scans(), 2);
});

test('death rejects an in-flight follow-up capture and a real respawn starts a new fast cycle', async t => {
  let finish;
  const h = harness({scanner:({scans}) => scans === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(noCards)});
  t.after(() => h.sidebar.stop()); h.sidebar.getModel();
  h.advance(60000); const capturedAt = h.time(), pending = h.sidebar.scan({automatic:true});
  const previousCycle = h.sidebar.getModel().ocr.schedule.windowId;
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'follow-up');
  h.advance(1000); h.update({life:{status:'detected', isDead:true}});
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'window'); assert.equal(h.sidebar.getModel().ocr.schedule.trigger,'death');
  finish(cards(capturedAt)); const result = await pending;
  assert.equal(result.status, 'waiting'); assert.equal(result.code, 'scan-context-changed');
  assert.equal(h.sidebar.getModel().offers.length, 0);
  assert.equal(h.sidebar.getSelectionObservation().status, 'waiting');
  h.advance(5000); await h.sidebar.pollOnce(); assert.equal(h.scans(), 2);
  h.advance(1000); h.update({life:{status:'detected', isDead:false}});
  await h.sidebar.pollOnce();
  const resumed = h.sidebar.getModel().ocr.schedule;
  assert.equal(h.scans(), 3);
  assert.equal(resumed.mode, 'window'); assert.equal(resumed.trigger, 'respawn');
  assert.notEqual(resumed.windowId, previousCycle);
  assert.equal(resumed.windowRemainingMs, 60000);
});

test('confirmation during a follow-up OCR task prevents its late cards from publishing or rearming', async t => {
  let finish;
  const h = harness({scanner:({scans, advance, time}) => {
    if (scans === 3) return new Promise(resolve => { finish = resolve; });
    advance(1); return Promise.resolve(cards(time()));
  }});
  t.after(() => h.sidebar.stop());
  await h.sidebar.pollOnce(); h.advance(58000); await h.sidebar.pollOnce();
  const offered = h.sidebar.getModel();
  h.advance(5000); const capturedAt = h.time(), pending = h.sidebar.scan({automatic:true});
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'follow-up');
  let confirmed;
  try {
    confirmed = await h.sidebar.confirmOffer({id:ids[0], gameId:offered.gameId, revision:offered.sessionRevision});
    assert.equal(confirmed.ocr.schedule.mode, 'idle');
  } finally { h.advance(1); finish(cards(capturedAt)); }
  const result = await pending;
  assert.equal(result.status, 'waiting');
  const model = h.sidebar.getModel();
  assert.deepEqual(model.plan.ownedIds, [ids[0]]);
  assert.equal(model.offers.length, 0); assert.equal(model.selection.status, 'waiting');
  assert.equal(model.ocr.schedule.mode, 'idle');
  h.advance(300000); await h.sidebar.pollOnce(); assert.equal(h.scans(), 3);
});

test('stored schedule diagnostics describe current window and actual count/duration without identity', async t => {
  const root = 'H:\\Chatgpt\\work\\2026-10-25\\hexguide-scan-efficiency';
  await mkdir(root, {recursive:true}); const folder = await mkdtemp(path.join(root, 'integration-'));
  t.after(() => rm(folder, {recursive:true, force:true}));
  const h = harness({dataDirectory:folder, scanner:async ({advance}) => { advance(1500); return noCards; }});
  await h.sidebar.pollOnce(); await h.sidebar.stop();
  const storedText = await readFile(path.join(folder, 'diagnostics', 'ocr-schedule.json'), 'utf8'), stored = JSON.parse(storedText);
  assert.equal(stored.schemaVersion, 2); assert.equal(stored.appVersion, '1.17.12');
  assert.equal(stored.scanCount, 1); assert.equal(stored.lastDurationMs, 1500);
  assert.equal(stored.mode, 'window'); assert.equal(stored.trigger, 'game-start'); assert.equal(stored.windowId, 1);
  assert.ok(stored.windowRemainingMs > 0); assert.ok(Buffer.byteLength(storedText) < 2048);
  assert.doesNotMatch(storedText, /isolated-schedule|championId|player|token|screenshot/i);
});

test('explicit selected IDs arriving with a real respawn end that same window', async t => {
  const h = harness(); t.after(() => h.sidebar.stop()); h.update({gameTime:300}); h.sidebar.getModel();
  h.advance(1000); h.update({life:{status:'detected', isDead:true}}); h.sidebar.getModel();
  h.advance(1000); h.update({life:{status:'detected', isDead:false}, augments:{status:'detected', ids:[ids[0]]}});
  const model = h.sidebar.getModel();
  assert.deepEqual(model.plan.ownedIds, [ids[0]]);
  assert.equal(model.ocr.schedule.mode, 'idle'); assert.equal(model.ocr.schedule.windowRemainingMs, 0);
});

test('diagnostic filesystem latency cannot postpone a due automatic capture', async t => {
  const h = harness(); t.after(() => h.sidebar.stop());
  let finishPublication; const diskBlocked = new Promise(resolve => { finishPublication = resolve; });
  h.sidebar.scanDiagnostics.publish = () => diskBlocked; const poll = h.sidebar.pollOnce();
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(h.scans(), 1); }
  finally { finishPublication(); await poll; }
});

test('the real loop uses the remaining half second after a short scan', async t => {
  const queue = [], starts = [];
  const timers = {setTimeout:(fn, delay) => { const task = {fn, delay}; queue.push(task); return task; }, clearTimeout:task => { if (task) task.cancelled = true; }};
  const h = harness({timers, scanner:async ({advance}) => { starts.push(h.time()); advance(200); return noCards; }});
  t.after(() => h.sidebar.stop()); h.sidebar.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue[0].delay, 300);
  const next = queue.shift(); h.advance(next.delay); await next.fn(); assert.equal(starts[1] - starts[0], 500);
  h.sidebar.setOcr({enabled:false});
  const paused = queue.shift(); h.advance(paused.delay); await paused.fn();
  assert.equal(h.scans(), 2); assert.equal(queue[0].delay, 1000);
  await h.sidebar.stop(); assert.equal(queue[0].cancelled, true);
});

test('the real loop waits for a long task plus minimum rest with no catch-up queue', async t => {
  const queue = [], starts = [];
  const timers = {setTimeout:(fn, delay) => { const task = {fn, delay}; queue.push(task); return task; }, clearTimeout:task => { if (task) task.cancelled = true; }};
  const h = harness({timers, scanner:async ({advance}) => { starts.push(h.time()); advance(1500); return noCards; }});
  t.after(() => h.sidebar.stop()); h.sidebar.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.scans(), 1); assert.equal(queue.length, 1); assert.equal(queue[0].delay, 100);
  const next = queue.shift(); h.advance(next.delay); await next.fn();
  assert.equal(starts[1] - starts[0], 1600); assert.equal(h.scans(), 2); assert.equal(queue.length, 1);
});

test('the real loop keeps life polling responsive while text scans use five-second follow-up starts', async t => {
  const queue = [], starts = [];
  const timers = {setTimeout:(fn, delay) => { const task = {fn, delay}; queue.push(task); return task; }, clearTimeout:task => { if (task) task.cancelled = true; }};
  const h = harness({timers, scanner:async ({advance}) => { starts.push(h.time()); advance(200); return noCards; }});
  t.after(() => h.sidebar.stop()); h.sidebar.start(); await new Promise(resolve => setImmediate(resolve));
  h.advance(60000);
  let next = queue.shift(); h.advance(next.delay); await next.fn();
  assert.equal(h.scans(), 2); assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'follow-up');
  const secondStart = starts[1];
  while (h.scans() === 2) {
    next = queue.shift();
    assert.ok(next.delay >= 100 && next.delay <= 1000, 'life observation stays at most one second apart');
    h.advance(next.delay); await next.fn();
  }
  assert.equal(starts[2] - secondStart, 5000);
  assert.equal(queue.length, 1, 'the loop has one timer and no catch-up work queue');
  h.advance(1000); h.update({life:{status:'detected', isDead:true}});
  next = queue.shift(); h.advance(next.delay); await next.fn();
  assert.equal(h.scans(), 4); assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'window');
  assert.equal(h.sidebar.getModel().ocr.schedule.trigger,'death');
});

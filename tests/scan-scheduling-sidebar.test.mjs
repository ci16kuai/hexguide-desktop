// Isolated collector/clock/OCR fixtures. No installed app, network or game input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar} from '../server/sidebar.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const ids = data.augments.filter(a => a.availability === 'current' && a.recommendable !== false && !a.retiredPatch && !a.isInternalTemplate).slice(0, 3).map(a => a.id);
const noCards = {status:'waiting', code:'title-name-unmatched', proposals:[]};
function harness({scanner, dataDirectory, timers} = {}) {
  let now = Date.parse('2026-10-25T05:00:00Z'), scans = 0;
  let live = {connection:{status:'connected'}, phase:'InProgress', stage:'live', gameId:'isolated-schedule-one', championId:'Vi', level:9, gameTime:300,
    mode:{known:true, isMayhem:true}, items:[], stats:{}, observedAt:new Date(now).toISOString()};
  const advance = ms => { now += ms; live.observedAt = new Date(now).toISOString(); };
  const sidebar = new BackgroundSidebar({collector:{getSnapshot:() => structuredClone(live)}, data, dataDirectory, timers, now:() => now,
    scanner:() => { scans++; return scanner ? scanner({advance, scans}) : Promise.resolve(noCards); }});
  return {sidebar, advance, update:value => { live = {...live, ...value}; }, scans:() => scans, time:() => now};
}

test('loading remains zero OCR and entering live starts discovery independently of the UI', async t => {
  const h = harness(); t.after(() => h.sidebar.stop());
  h.update({phase:'GameStart', stage:'loading', level:null});
  for (let n = 0; n < 12; n++) { await h.sidebar.pollOnce(); h.advance(2000); }
  assert.equal(h.scans(), 0);
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'loading');
  h.update({phase:'InProgress', stage:'live', level:3});
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 1);
  assert.equal(h.sidebar.getModel().ocr.schedule.triggerLevel, 3);
});

test('slow battle OCR has a completion cooldown while a later level window stays faster', async t => {
  const h = harness({scanner:async ({advance}) => { advance(8000); return noCards; }});
  t.after(() => h.sidebar.stop());
  await h.sidebar.pollOnce();
  h.advance(61000);
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 2);
  assert.equal(h.sidebar.getModel().ocr.schedule.mode, 'battle');
  h.advance(999); await h.sidebar.pollOnce(); assert.equal(h.scans(), 2);
  h.advance(1); await h.sidebar.pollOnce(); assert.equal(h.scans(), 3);
  h.update({level:11}); h.advance(250);
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 4, 'new level uses fast mode after the completion rest, without waiting for battle interval');
  assert.equal(h.sidebar.getModel().ocr.schedule.triggerLevel, 11);
});

test('manual scans remain immediate and reuse the single capture while automatic scheduling is busy', async t => {
  let finish;
  const h = harness({scanner:() => new Promise(resolve => { finish = resolve; })});
  t.after(() => h.sidebar.stop());
  const first = h.sidebar.scan(), second = h.sidebar.scan();
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 1);
  finish(noCards); await Promise.all([first, second]);
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  const manual = h.sidebar.scan();
  assert.equal(h.scans(), 2, 'a deliberate manual scan can bypass automatic cooldown');
  finish(noCards); await manual;
});

test('late old-game OCR releases busy state and cannot postpone the new game scan', async t => {
  let finish;
  const h = harness({scanner:({scans}) => scans === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(noCards)});
  t.after(() => h.sidebar.stop());
  const previousGame = h.sidebar.scan();
  h.update({gameId:'isolated-schedule-two', level:3, gameTime:1});
  h.sidebar.getModel();
  await h.sidebar.pollOnce(); assert.equal(h.scans(), 1);
  finish(noCards); await previousGame;
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 2, 'old completion neither leaves internal busy nor assigns new-game backoff');
  assert.deepEqual(h.sidebar.getSession().owned, []);
});

test('confirming current offers leaves the level window and never shuts down later or unexpected discovery', async t => {
  const h = harness({scanner:async () => ({status:'recognized', proposals:ids.map(id => ({id}))})});
  t.after(() => h.sidebar.stop());
  await h.sidebar.pollOnce();
  const offered = h.sidebar.getModel();
  assert.equal(offered.ocr.schedule.mode, 'offers-acquiring');
  const confirmed = await h.sidebar.confirmOffer({id:ids[0], gameId:offered.gameId, revision:offered.sessionRevision});
  assert.equal(confirmed.ocr.schedule.mode, 'battle');
  assert.equal(confirmed.ocr.schedule.boostRemainingMs, 0);
  assert.deepEqual(confirmed.plan.ownedIds, [ids[0]]);
  h.update({level:16}); h.advance(1000);
  assert.equal(h.sidebar.getModel().ocr.schedule.triggerLevel, 15);
  h.advance(61000);
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), 2, 'ordinary-round thresholds are scheduling hints, never a permanent stop');
});

test('stored schedule diagnostics describe actual mode/count/duration without recording player or game identity', async t => {
  const root = 'H:\\Chatgpt\\work\\2026-10-25\\hexguide-scan-efficiency';
  await mkdir(root, {recursive:true});
  const folder = await mkdtemp(path.join(root, 'integration-'));
  t.after(() => rm(folder, {recursive:true, force:true}));
  const h = harness({dataDirectory:folder, scanner:async ({advance}) => { advance(1500); return noCards; }});
  await h.sidebar.pollOnce();
  await h.sidebar.stop();
  const storedText = await readFile(path.join(folder, 'diagnostics', 'ocr-schedule.json'), 'utf8');
  const stored = JSON.parse(storedText);
  assert.equal(stored.appVersion, '1.11.2');
  assert.equal(stored.scanCount, 1);
  assert.equal(stored.lastDurationMs, 1500);
  assert.equal(stored.mode, 'boost');
  assert.ok(Buffer.byteLength(storedText) < 2048);
  assert.doesNotMatch(storedText, /isolated-schedule|championId|player|token|screenshot/i);
});

test('a selected-ID snapshot arriving with a threshold level ends that same threshold window', async t => {
  const h = harness(); t.after(() => h.sidebar.stop());
  h.update({level:6}); h.sidebar.getModel();
  h.update({level:7, augments:{status:'detected', ids:[ids[0]]}});
  const model = h.sidebar.getModel();
  assert.deepEqual(model.plan.ownedIds, [ids[0]]);
  assert.equal(model.ocr.schedule.mode, 'battle');
  assert.equal(model.ocr.schedule.boostRemainingMs, 0);
});

test('diagnostic filesystem latency cannot postpone a due automatic capture', async t => {
  const h = harness(); t.after(() => h.sidebar.stop());
  let finishPublication;
  const diskBlocked = new Promise(resolve => { finishPublication = resolve; });
  h.sidebar.scanDiagnostics.publish = () => diskBlocked;
  const poll = h.sidebar.pollOnce();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.scans(), 1, 'OCR starts without waiting for observational disk IO');
  } finally { finishPublication(); await poll; }
});

test('the real background loop uses the remaining second rather than adding one second after a short scan', async t => {
  const queue = [], starts = [];
  const timers = {setTimeout:(fn, delay) => { const task = {fn, delay}; queue.push(task); return task; }, clearTimeout:task => { if (task) task.cancelled = true; }};
  const h = harness({timers, scanner:async ({advance}) => { starts.push(h.time()); advance(200); return noCards; }});
  t.after(() => h.sidebar.stop());
  h.sidebar.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue[0].delay, 800);
  const next = queue.shift(); h.advance(next.delay); await next.fn();
  assert.equal(starts[1] - starts[0], 1000);
  h.sidebar.setOcr({enabled:false});
  const paused = queue.shift(); h.advance(paused.delay); await paused.fn();
  assert.equal(h.scans(), 2);
  assert.equal(queue[0].delay, 1000);
  await h.sidebar.stop(); assert.equal(queue[0].cancelled, true);
});

test('the real background loop waits for a long task and its short rest without queuing catch-up captures', async t => {
  const queue = [], starts = [];
  const timers = {setTimeout:(fn, delay) => { const task = {fn, delay}; queue.push(task); return task; }, clearTimeout:task => { if (task) task.cancelled = true; }};
  const h = harness({timers, scanner:async ({advance}) => { starts.push(h.time()); advance(1500); return noCards; }});
  t.after(() => h.sidebar.stop());
  h.sidebar.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.scans(), 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].delay, 250);
  const next = queue.shift(); h.advance(next.delay); await next.fn();
  assert.equal(starts[1] - starts[0], 1750);
  assert.equal(h.scans(), 2);
  assert.equal(queue.length, 1);
});

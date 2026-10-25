import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {OcrScheduleDiagnostics} from '../server/ocr-schedule-diagnostics.mjs';
import {OCR_SCHEDULE_MODES} from '../server/ocr-schedule.mjs';

const WORK = 'H:/Chatgpt/work/2026-10-25/hexguide-ocr-scheduling/diagnostics-tests';
const TIME = Date.parse('2026-10-25T06:00:00Z');
const FILE = 'diagnostics/ocr-schedule.json';
const entry = (extra = {}) => ({mode:'window', due:true, intervalMs:500, nextInMs:0,
  windowRemainingMs:60000, trigger:'game-start', windowId:1, scanCount:1, failureCount:0, lastDurationMs:150, ...extra});

async function directory(t) {
  await mkdir(WORK, {recursive:true});
  const folder = await mkdtemp(path.join(WORK, 'test-'));
  t.after(async () => {
    assert.ok(path.resolve(folder).startsWith(path.resolve(WORK) + path.sep));
    await rm(folder, {recursive:true, force:true});
  });
  return folder;
}
const read = async folder => JSON.parse(await readFile(path.join(folder, FILE), 'utf8'));

test('writes only fixed diagnostic fields and imports the scheduler mode allowlist', async t => {
  const folder = await directory(t);
  const store = new OcrScheduleDiagnostics({dataDirectory:folder, now:() => TIME});
  await store.publish(entry({mode:'window', trigger:'respawn', windowId:7, windowRemainingMs:45000,
    gameId:'PRIVATE-GAME', championId:'PRIVATE-HERO', title:'PRIVATE-TITLE',
    screenshot:'PRIVATE-IMAGE', token:'PRIVATE-TOKEN', path:'PRIVATE-PATH',
    exception:new Error('PRIVATE-ERROR'), appVersion:'wrong', schemaVersion:99}));
  await store.close();
  const value = await read(folder);
  assert.deepEqual(Object.keys(value).sort(), ['schemaVersion','appVersion','updatedAtUtc','mode','due',
    'intervalMs','nextInMs','windowRemainingMs','trigger','windowId','scanCount','failureCount','lastDurationMs'].sort());
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.appVersion, '1.12.0');
  assert.equal(value.updatedAtUtc, new Date(TIME).toISOString());
  assert.equal(value.trigger, 'respawn');
  assert.equal(value.windowId, 7);
  assert.ok(OCR_SCHEDULE_MODES.includes(value.mode));
  const text = await readFile(path.join(folder, FILE), 'utf8');
  assert.ok(Buffer.byteLength(text) < 2048);
  assert.ok(!text.includes('PRIVATE'));
});

test('clamps finite numeric fields, rejects nonnumeric values and unknown mode text', async t => {
  const folder = await directory(t);
  const store = new OcrScheduleDiagnostics({dataDirectory:folder, now:() => Infinity});
  await store.publish(entry({mode:'PRIVATE-MODE', due:'true', intervalMs:1e99, nextInMs:-100,
    windowRemainingMs:Infinity, trigger:'PRIVATE-TRIGGER', windowId:1e20, scanCount:1e20, failureCount:2.9, lastDurationMs:'123'}));
  let value = await read(folder);
  assert.equal(value.mode, 'inactive');
  assert.equal(value.updatedAtUtc, '1970-01-01T00:00:00.000Z');
  assert.equal(value.due, false);
  assert.equal(value.intervalMs, 30000);
  assert.equal(value.nextInMs, 0);
  assert.equal(value.windowRemainingMs, 0);
  assert.equal(value.trigger, null);
  assert.equal(value.windowId, null);
  assert.equal(value.scanCount, 1000000);
  assert.equal(value.failureCount, 2);
  assert.equal(value.lastDurationMs, 0);
  await store.publish(entry({mode:'window', trigger:'respawn', windowId:2.5, windowRemainingMs:1e20, lastDurationMs:1e20}));
  await store.close();
  value = await read(folder);
  assert.equal(value.trigger, 'respawn');
  assert.equal(value.windowId, null);
  assert.equal(value.windowRemainingMs, 120000);
  assert.equal(value.lastDurationMs, 60000);
});

test('throttles unchanged mode/count for five seconds and preserves the newest pending snapshot', async t => {
  const folder = await directory(t);
  let clock = TIME;
  const store = new OcrScheduleDiagnostics({dataDirectory:folder, now:() => clock});
  await store.publish(entry());
  clock += 1000;
  await store.publish(entry({nextInMs:9000, lastDurationMs:200}));
  clock += 1000;
  await store.publish(entry({nextInMs:8000, lastDurationMs:300}));
  assert.equal((await read(folder)).lastDurationMs, 150);
  clock = TIME + 5000;
  await store.publish(entry({nextInMs:5000, lastDurationMs:400}));
  assert.equal((await read(folder)).lastDurationMs, 400);
  clock += 1;
  await store.publish(entry({nextInMs:4999, lastDurationMs:500}));
  assert.equal((await read(folder)).lastDurationMs, 400);
  await store.close();
  assert.equal((await read(folder)).lastDurationMs, 500);
});

test('mode, window or scan count changes bypass throttling; atomic serial writes coalesce concurrent publications', async t => {
  const folder = await directory(t);
  const store = new OcrScheduleDiagnostics({dataDirectory:folder, now:() => TIME});
  await store.publish(entry());
  await store.publish(entry({mode:'idle', windowRemainingMs:0}));
  assert.equal((await read(folder)).mode, 'idle');
  await store.publish(entry({mode:'window', trigger:'respawn', windowId:2}));
  assert.equal((await read(folder)).windowId, 2);
  await store.publish(entry({mode:'window', trigger:'respawn', windowId:2, scanCount:2}));
  assert.equal((await read(folder)).scanCount, 2);
  const tasks = [];
  for (let index = 3; index <= 300; index++) tasks.push(store.publish(entry({scanCount:index,
    failureCount:index % 9, lastDurationMs:index, mode:index % 2 ? 'idle' : 'window', trigger:'respawn', windowId:2})));
  await Promise.all(tasks);
  await store.close();
  const value = await read(folder);
  assert.equal(value.scanCount, 300);
  assert.equal(value.mode, 'window');
  assert.equal(value.lastDurationMs, 300);
  assert.deepEqual(await readdir(path.join(folder, 'diagnostics')), ['ocr-schedule.json']);
});

test('fast to follow-up transition is persisted immediately without changing the cycle identity', async t => {
  const folder = await directory(t);
  let clock = TIME;
  const store = new OcrScheduleDiagnostics({dataDirectory:folder, now:() => clock});
  await store.publish(entry({trigger:'respawn', windowId:7, windowRemainingMs:100}));
  clock += 100;
  await store.publish(entry({mode:'follow-up', trigger:'respawn', windowId:7, intervalMs:5000,
    nextInMs:4500, windowRemainingMs:0}));
  const value = await read(folder);
  assert.equal(value.mode, 'follow-up');
  assert.equal(value.windowId, 7);
  assert.equal(value.trigger, 'respawn');
  assert.equal(value.intervalMs, 5000);
  assert.equal(value.nextInMs, 4500);
  assert.equal(value.windowRemainingMs, 0);
  assert.equal(value.scanCount, 1);
  assert.equal(value.updatedAtUtc, new Date(clock).toISOString());
  await store.close();
});

test('the timer flushes the latest throttled state without another publication', async t => {
  const folder = await directory(t);
  const store = new OcrScheduleDiagnostics({dataDirectory:folder});
  t.after(() => store.close());
  await store.publish(entry());
  await store.publish(entry({lastDurationMs:700}));
  await store.publish(entry({lastDurationMs:800}));
  const deadline = Date.now() + 6500;
  while ((await read(folder)).lastDurationMs !== 800 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await read(folder)).lastDurationMs, 800);
});

test('unwritable diagnostics never reject publication or close and do not retain raw failures', async t => {
  const folder = await directory(t);
  const blocked = path.join(folder, 'regular-file');
  await writeFile(blocked, 'unchanged');
  const store = new OcrScheduleDiagnostics({dataDirectory:blocked, now:() => TIME});
  await assert.doesNotReject(store.publish(entry()));
  await assert.doesNotReject(store.publish(entry({scanCount:2})));
  await assert.doesNotReject(store.close());
  assert.equal(await readFile(blocked, 'utf8'), 'unchanged');
});

test('close is idempotent, publishes after close are ignored, and missing data directory is inert', async t => {
  const folder = await directory(t);
  const store = new OcrScheduleDiagnostics({dataDirectory:folder, now:() => TIME});
  await store.publish(entry());
  await Promise.all([store.close(), store.close()]);
  await store.publish(entry({scanCount:99}));
  assert.equal((await read(folder)).scanCount, 1);
  const inert = new OcrScheduleDiagnostics();
  await assert.doesNotReject(inert.publish(entry()));
  await assert.doesNotReject(inert.close());
});

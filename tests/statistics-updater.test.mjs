import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {StatisticsUpdater, STATISTICS_REFRESH_INTERVAL, validateStoredStatistics} from '../server/statistics-updater.mjs';

const day = 24 * 60 * 60 * 1000;
const initialTime = Date.parse('2026-10-29T00:00:00Z');
const gameData = {meta:{clientDataVersion:'16.21', patch:'26.21'}, champions:[{id:'Annie'}, {id:'Ahri'}], augments:[{id:'example', gameDataId:1030}]};
const championCatalog = {champions:[{id:'Annie', key:1}, {id:'Ahri', key:103}]};
function snapshot(date = '2026-10-28T00:00:00+08:00') {
  const cohortId = `aramhex-cn-16.21-normal-all-${date}`;
  return {schemaVersion:1, meta:{mode:'aram-mayhem', patch:'16.21', rulesPatch:'26.21', cohortId,
    statsUpdatedAt:date, observedFrom:'2026-10-24T00:00:00+08:00', observedTo:'2026-10-27T00:00:00+08:00',
    rank:'全分段', validGames:1, excludedAugments:{},
    source:{name:'AramHex', url:'https://github.com/czgreat/aramhex-data', license:'CC BY-NC 4.0', commit:'a'.repeat(40)},
    coverage:{championsWithStats:2, augmentRows:1, mappedAugmentRows:1, provisionalRows:0}},
  champions:[{championId:'Annie', sourceChampionId:'1', cohortId, games:5, wins:3, winRate:60,
    augments:[{augmentId:'example', sourceAugmentId:'1030', cohortId, games:2, wins:1, winRate:50, lowSample:true, provisional:false, builds:[]}]},
    {championId:'Ahri', sourceChampionId:'103', cohortId, games:5, wins:2, winRate:40, augments:[]}]};
}
async function directory(t) {
  const root = path.resolve(process.env.HEXGUIDE_TEST_WORK || 'H:/Chatgpt/work/2026-10-29/hexguide-statistics-update/tests');
  await mkdir(root, {recursive:true});
  const result = await mkdtemp(path.join(root, 'updater-'));
  t.after(() => rm(result, {recursive:true, force:true}));
  return result;
}
const config = extra => ({bundledSnapshot:snapshot(), gameData, championCatalog, now:() => initialTime, ...extra});

test('three-day schedule survives restart and an overdue closed app checks once on next use', async t => {
  const dataDirectory = await directory(t);
  let time = initialTime, requests = 0;
  const refresh = async () => { requests++; return null; };
  const first = await new StatisticsUpdater(config({dataDirectory, now:() => time, refresh})).load();
  await first.check();
  assert.equal(requests, 1);
  assert.equal(first.getStatus().nextCheckAt, initialTime + 3 * day);
  await first.close();
  const resumed = await new StatisticsUpdater(config({dataDirectory, now:() => time, refresh})).load();
  time += STATISTICS_REFRESH_INTERVAL - 1;
  await resumed.check(); assert.equal(requests, 1);
  time++;
  await resumed.check(); assert.equal(requests, 2);
  assert.equal(resumed.getStatus().lastCheckedAt, time);
  await resumed.close();
  time += 5 * day;
  const overdue = await new StatisticsUpdater(config({dataDirectory, now:() => time, refresh})).load();
  await overdue.check(); assert.equal(requests, 3);
  await overdue.close();
});

test('a validated update is persisted, published once and loaded on restart without touching the bundled file', async t => {
  const dataDirectory = await directory(t);
  const next = snapshot('2026-10-29T00:00:00+08:00');
  const published = [];
  const updater = await new StatisticsUpdater(config({dataDirectory, refresh:async () => next, onUpdate:value => published.push(value)})).load();
  const revision = updater.getStatus().revision;
  await updater.check();
  assert.equal(published.length, 1);
  assert.equal(updater.getSnapshot(), next);
  assert.notEqual(updater.getStatus().revision, revision);
  assert(Object.isFrozen(updater.getSnapshot().champions[0].augments));
  await updater.close();
  const reloaded = await new StatisticsUpdater(config({dataDirectory})).load();
  assert.deepEqual(reloaded.getSnapshot(), next);
  assert.equal(reloaded.getStatus().revision, updater.getStatus().revision);
  await reloaded.close();
});

test('download failure preserves good data and uses a persisted retry delay, then recovers', async t => {
  const dataDirectory = await directory(t);
  let time = initialTime, requests = 0;
  const updater = await new StatisticsUpdater(config({dataDirectory, now:() => time,
    refresh:async () => { requests++; if (requests === 1) throw Error('offline'); return null; }})).load();
  const before = updater.getSnapshot();
  await updater.check();
  assert.equal(updater.getSnapshot(), before);
  assert.equal(updater.getStatus().error, 'update-unavailable');
  time += 60 * 60000 - 1;
  await updater.check(); assert.equal(requests, 1);
  const restored = await new StatisticsUpdater(config({dataDirectory, now:() => time})).load();
  assert.equal(restored.getStatus().nextCheckAt, initialTime + 60 * 60000);
  await restored.close();
  time++;
  await updater.check(); assert.equal(requests, 2);
  assert.equal(updater.getStatus().error, null);
  assert.equal(updater.getStatus().nextCheckAt, time + 3 * day);
  await updater.close();
});

test('invalid counts, mixed patches, future and older snapshots never replace the current aggregate', async () => {
  const wrongCounts = snapshot(); wrongCounts.champions[0].augments[0].wins = 3;
  const wrongPatch = snapshot(); wrongPatch.meta.patch = '16.22';
  const future = snapshot('2027-01-01T00:00:00+08:00');
  const older = snapshot('2026-10-27T12:00:00+08:00');
  const wrongIds = snapshot(); wrongIds.champions[0].augments[0].sourceAugmentId = '999';
  for (const next of [wrongCounts, wrongPatch, future, older, wrongIds]) {
    let publications = 0;
    const updater = new StatisticsUpdater(config({refresh:async () => next, onUpdate:() => publications++}));
    const before = updater.getSnapshot();
    await updater.check();
    assert.equal(updater.getSnapshot(), before);
    assert.equal(publications, 0);
    assert.equal(updater.getStatus().error, 'update-unavailable');
    await updater.close();
  }
});

test('checks are single-flight and closing aborts the request without accepting a late result', async () => {
  let finish, requestSignal, requests = 0;
  const updater = new StatisticsUpdater(config({refresh:({signal}) => {
    requests++; requestSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  }}));
  const first = updater.check();
  assert.equal(updater.check({force:true}), first);
  assert.equal(requests, 1);
  const before = updater.getSnapshot();
  const closing = updater.close();
  assert.equal(requestSignal.aborted, true);
  finish(snapshot('2026-10-29T00:00:00+08:00'));
  await closing; await first;
  assert.equal(updater.getSnapshot(), before);
  await updater.check({force:true}); assert.equal(requests, 1);
});

test('broken cache and implausible schedule fall back to the bundle and allow a fresh check', async t => {
  const dataDirectory = await directory(t);
  await writeFile(path.join(dataDirectory, 'statistics-snapshot-v1.json'), '{broken');
  await writeFile(path.join(dataDirectory, 'statistics-refresh-v1.json'), JSON.stringify({schemaVersion:1, patch:'16.21',
    lastCheckedAt:initialTime, nextCheckAt:initialTime + 365 * day, failures:0, error:null}));
  let requests = 0;
  const updater = await new StatisticsUpdater(config({dataDirectory, refresh:async () => { requests++; return null; }})).load();
  assert.deepEqual(updater.getSnapshot(), snapshot());
  await updater.check(); assert.equal(requests, 1);
  await updater.close();
});

test('snapshot persistence failure does not publish a replacement', async t => {
  const dataDirectory = await directory(t);
  await mkdir(path.join(dataDirectory, 'statistics-snapshot-v1.json'));
  const updater = await new StatisticsUpdater(config({dataDirectory, refresh:async () => snapshot('2026-10-29T00:00:00+08:00')})).load();
  const before = updater.getSnapshot();
  await updater.check(); assert.equal(updater.getSnapshot(), before);
  assert.equal(updater.getStatus().error, 'update-unavailable');
  await updater.close();
});

test('the bundled full aggregate satisfies the same restore contract as downloaded data', async () => {
  const read = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
  const [bundled, data, champions] = await Promise.all([read('../dist/statistics.json'), read('../dist/data.json'), read('../server/resources/champions-16.21.1.json')]);
  assert.equal(validateStoredStatistics(bundled, {gameData:data, championCatalog:champions}), bundled);
});

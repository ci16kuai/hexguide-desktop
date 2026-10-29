import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SOURCE, transformStatistics, validateCounts, updateStatistics } from '../scripts/update-statistics.mjs';
import { fetchLatestStatistics } from '../server/statistics-source.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture() {
  return {
    meta: {
      schema_version: 1, patch: '16.21', mode: 'normal', bands: null, regions_combined: true,
      license: 'CC BY-NC 4.0', snapshot_at: '2026-10-23T11:13:05+08:00',
      window: { start: '2026-10-22T04:06:00+08:00', end_exclusive: '2026-10-23T11:00:00+08:00' },
      matches: { valid: 1, validity_rule: '10 players; 5 wins, 5 losses' },
      regions: ['一区', '二区', '三区', '四区', '五区', '六区', '七区'], heroes: 2,
      augment_exposure: '对局结束时持有', limitations: ['观察统计'], excluded_augments: {},
      provisional_augments: { '3039': { games: 3, wins: 2, win_rate: 0.666667 } },
    },
    heroes: {
      '1': { name: '安妮', games: 5, wins: 3, win_rate: 0.6 },
      '103': { name: '阿狸', games: 5, wins: 2, win_rate: 0.4 },
    },
    heroAugments: {
      '1': { '1030': { games: 2, wins: 2, win_rate: 1, low_sample: true } },
      '103': { '3039': { games: 3, wins: 2, win_rate: 0.666667, low_sample: true } },
    },
    sourceAugments: {
      '1030': { name: 'live', rarity: 'gold' },
      '3039': { name: 'PBE', rarity: 'prismatic' },
    },
    championCatalog: { champions: [{ key: 1, id: 'Annie' }, { key: 103, id: 'Ahri' }] },
    gameData: { meta: { clientDataVersion: '16.21', patch: '26.21' }, champions: [{ id: 'Annie' }, { id: 'Ahri' }], augments: [{ id: 'live-augment', gameDataId: 1030 }] },
    fetchedAt: '2026-10-23T09:00:00.000Z',
  };
}

test('statistics import maps numeric IDs and keeps PBE apart without fabricating equipment statistics', () => {
  const result = transformStatistics(fixture());
  const live = result.champions.find(c => c.championId === 'Annie');
  const pbe = result.champions.find(c => c.championId === 'Ahri').augments[0];
  assert.equal(live.winRate, 60);
  assert.equal(live.augments[0].augmentId, 'live-augment');
  assert.equal(live.augments[0].cohortId, live.cohortId);
  assert.equal(pbe.augmentId, null);
  assert.equal(pbe.provisional, true);
  assert.equal(pbe.cohortId, 'aramhex-pbe-16.21.828');
  assert.notEqual(pbe.cohortId, result.champions[1].cohortId);
  assert.deepEqual(pbe.builds, []);
  assert.deepEqual(result.meta.coverage.unmappedAugments, [{ sourceAugmentId: '3039', name: 'PBE' }]);
  assert.equal(result.meta.lowSampleThreshold, 3000);
  assert.equal(result.meta.statsUpdatedAt, '2026-10-23T11:13:05+08:00');
  assert.equal(result.meta.exposure, '对局结束时持有');
});

test('statistics importer rejects percentages mistaken for proportions and inconsistent counts/cohorts', () => {
  assert.throws(() => validateCounts({ games: 10, wins: 6, win_rate: 60 }, 'bad-rate'), /win_rate/);
  assert.throws(() => validateCounts({ games: 10, wins: 11, win_rate: 0.6 }, 'bad-wins'), /Wins exceed/);
  assert.throws(() => validateCounts({ games: 10, wins: 6, win_rate: 0.65 }, 'wrong-rate'), /disagrees/);
  const incorrect = fixture();
  incorrect.meta.patch = '16.20';
  assert.throws(() => transformStatistics(incorrect), /Unsupported source cohort/);
  const ambiguous = fixture();
  ambiguous.gameData.augments.push({ id: 'same-game-ID', gameDataId: 1030 });
  assert.throws(() => transformStatistics(ambiguous), /Ambiguous local augment/);
});

test('bundled post-hotfix seq10 snapshot covers all heroes and contains only live rows with coherent totals', async () => {
  const result = JSON.parse(await fs.readFile(path.join(project, 'dist/statistics.json'), 'utf8'));
  assert.equal(result.meta.source.commit, SOURCE.commit);
  assert.equal(result.meta.source.seq, 10);
  assert.deepEqual(result.meta.source.hashes, SOURCE.hashes);
  assert.equal(result.meta.statsUpdatedAt, '2026-10-28T12:28:35.908470+08:00');
  assert.equal(result.meta.observedFrom, '2026-10-24T00:00:00+08:00');
  assert.equal(result.meta.observedTo, '2026-10-28T11:00:00+08:00');
  assert.equal(result.meta.hotfix.effective_at, '2026-10-23T16:00:00+08:00');
  assert.equal(result.meta.hotfix.time_source, '用户确认');
  assert.equal(result.meta.bands.bands.top.alias_of, 'high');
  assert.equal(result.meta.validGames, 22_552_455);
  assert.equal(result.champions.length, 173);
  assert.equal(new Set(result.champions.map(c => c.championId)).size, 173);
  assert.equal(result.champions.reduce((sum, c) => sum + c.games, 0), result.meta.validGames * 10);
  assert.equal(result.champions.reduce((sum, c) => sum + c.wins, 0), result.meta.validGames * 5);
  const augments = result.champions.flatMap(c => c.augments);
  assert.equal(augments.length, 23_178);
  assert.equal(augments.filter(a => a.provisional).length, 0);
  assert.equal(result.meta.coverage.mappedAugmentRows, 23_178);
  assert.deepEqual(result.meta.coverage.unmappedAugments, []);
  assert(augments.every(a => a.augmentId !== null && a.lowSample === (a.games < 3000) && a.builds.length === 0));
  assert(augments.every(a => a.cohortId === (a.provisional ? 'aramhex-pbe-16.21.828' : result.meta.cohortId)));
  for (const hero of result.champions) {
    validateCounts({ games: hero.games, wins: hero.wins, win_rate: hero.winRate / 100 }, hero.championId);
    for (const row of hero.augments) {
      validateCounts({ games: row.games, wins: row.wins, win_rate: row.winRate / 100 }, row.augmentId);
      assert(row.games <= hero.games && row.wins <= hero.wins && row.games - row.wins <= hero.games - hero.wins);
      assert(!['1337', '3176'].includes(row.sourceAugmentId));
    }
  }
});

test('failed offline source verification preserves the previously published statistics file', async () => {
  const scratchRoot = path.resolve(process.env.HEXGUIDE_TEST_WORK || 'H:/Chatgpt/work/2026-10-29/hexguide-statistics-update/statistics-import-tests');
  await fs.mkdir(scratchRoot, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(scratchRoot, 'case-'));
  const output = path.join(scratch, 'statistics.json');
  const cache = path.join(scratch, 'cache');
  const sourceDirectory = path.join(cache, SOURCE.commit);
  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(output, 'existing verified statistics\n');
    // A JSON-valid file with an untrusted hash must never replace the old output.
    await Promise.all(Object.keys(SOURCE.hashes).map(filename => fs.writeFile(path.join(sourceDirectory, filename), '{}')));
    await assert.rejects(updateStatistics({ output, cache, offline: true }), /SHA-256 mismatch/);
    assert.equal(await fs.readFile(output, 'utf8'), 'existing verified statistics\n');
  } finally {
    const resolved = path.resolve(scratch);
    assert(resolved.startsWith(scratchRoot + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

function upstreamFixture({ provisional = false } = {}) {
  const input = fixture();
  if (!provisional) delete input.meta.provisional_augments;
  input.meta.snapshot_at = '2026-10-28T12:28:35.908470+08:00';
  input.meta.bands = { bands: { casual: {}, mid: {}, high: {}, top: { alias_of: 'high' } } };
  const commit = 'a'.repeat(40);
  const documents = {};
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const encode = value => Buffer.from(JSON.stringify(value) + '\n');
  let latest;
  function rebuild() {
    documents['heroes.json'] = encode(input.heroes);
    documents['hero_augments.json'] = encode(input.heroAugments);
    documents['augments.json'] = encode(input.sourceAugments);
    input.meta.files = Object.fromEntries(Object.entries(documents).filter(([name]) => !['meta.json', 'latest.json'].includes(name)).map(([name, bytes]) => [name, digest(bytes)]));
    documents['meta.json'] = encode(input.meta);
    latest = { schema_version: 1, patch: '16.21', mode: 'normal', path: 'patches/16.21/normal', seq: 11,
      matches: input.meta.matches.valid, snapshot_at: input.meta.snapshot_at, window: input.meta.window,
      files: Object.fromEntries(Object.entries(documents).filter(([name]) => name !== 'latest.json').map(([name, bytes]) => [name, { sha256: digest(bytes), size: bytes.length }])) };
    documents['latest.json'] = encode(latest);
    return latest;
  }
  rebuild();
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    if (url === 'https://api.github.com/repos/czgreat/aramhex-data/git/ref/heads/main') return new Response(encode({ object: { type: 'commit', sha: commit } }));
    const base = `https://raw.githubusercontent.com/czgreat/aramhex-data/${commit}/`;
    assert(url.startsWith(base), `Unexpected source URL: ${url}`);
    const name = url.slice(base.length).replace('patches/16.21/normal/', '');
    assert(Object.hasOwn(documents, name), `Unexpected source table: ${name}`);
    return new Response(documents[name]);
  };
  const options = { championCatalog: input.championCatalog, gameData: input.gameData, fetcher };
  return { input, commit, documents, calls, options, rebuild, get latest() { return latest; },
    changeManifest(change) { change(latest); documents['latest.json'] = encode(latest); } };
}

test('runtime follows pinned main revision, verifies a live whole-population manifest and retains source hashes', async () => {
  const upstream = upstreamFixture();
  const result = await fetchLatestStatistics(upstream.options);
  assert.equal(result.meta.source.commit, upstream.commit);
  assert.equal(result.meta.source.seq, 11);
  assert.equal(result.meta.patch, upstream.input.gameData.meta.clientDataVersion);
  assert.equal(result.meta.rulesPatch, '26.21');
  assert.equal(result.meta.statsUpdatedAt, upstream.input.meta.snapshot_at);
  assert.equal(result.meta.bands.bands.top.alias_of, 'high');
  assert.equal(result.meta.coverage.provisionalRows, 0);
  for (const [name, entry] of Object.entries(upstream.latest.files)) assert.equal(result.meta.source.hashes[name], entry.sha256);
  assert.equal(upstream.calls.length, 6);
  assert(upstream.calls.slice(1).every(call => call.url.includes(`/${upstream.commit}/`)));
});

test('unchanged snapshot and table hashes skip tables even after documentation-only revision or manifest reformatting', async () => {
  const upstream = upstreamFixture();
  const currentSnapshot = await fetchLatestStatistics(upstream.options);
  currentSnapshot.meta.source.commit = 'b'.repeat(40);
  upstream.documents['latest.json'] = Buffer.from(JSON.stringify(upstream.latest, null, 2));
  upstream.calls.length = 0;
  assert.equal(await fetchLatestStatistics({ ...upstream.options, currentSnapshot }), null);
  assert.equal(upstream.calls.length, 2);
});

test('same-time corrected table hashes trigger revalidation instead of skipping corrected observations', async () => {
  const upstream = upstreamFixture();
  const currentSnapshot = await fetchLatestStatistics(upstream.options);
  upstream.input.heroAugments['1']['1030'] = { games: 1, wins: 1, win_rate: 1, low_sample: true };
  upstream.rebuild();
  upstream.calls.length = 0;
  const result = await fetchLatestStatistics({ ...upstream.options, currentSnapshot });
  assert.equal(upstream.calls.length, 6);
  assert.equal(result.champions.find(c => c.championId === 'Annie').augments[0].games, 1);
  assert.notEqual(result.meta.source.hashes['hero_augments.json'], currentSnapshot.meta.source.hashes['hero_augments.json']);
});

test('runtime rejects incompatible client patches and PBE/activity/band source paths before requesting tables', async () => {
  for (const change of [
    latest => { latest.patch = '16.22'; latest.path = 'patches/16.22/normal'; },
    latest => { latest.mode = 'first-prismatic'; },
    latest => { latest.path = 'patches/16.21-pbe/normal'; },
    latest => { latest.path = 'patches/16.21/normal/bands/high'; },
  ]) {
    const upstream = upstreamFixture();
    upstream.changeManifest(change);
    await assert.rejects(fetchLatestStatistics(upstream.options), /Unsupported source cohort/);
    assert.equal(upstream.calls.length, 2);
  }
  const upstream = upstreamFixture({ provisional: true });
  await assert.rejects(fetchLatestStatistics(upstream.options), /PBE provisional/);
  assert.equal(upstream.calls.length, 3);
});

test('runtime rejects unsafe revisions, manifest hashes, oversized entries and source rollback', async () => {
  const upstream = upstreamFixture();
  await assert.rejects(fetchLatestStatistics({ ...upstream.options, fetcher: async () => new Response(JSON.stringify({ object: { type: 'commit', sha: '../../main' } })) }), /main revision/);
  upstream.changeManifest(latest => { latest.files['heroes.json'].sha256 = 'x'.repeat(64); });
  await assert.rejects(fetchLatestStatistics(upstream.options), /manifest hash/);
  upstream.rebuild();
  upstream.changeManifest(latest => { latest.files['heroes.json'].size = 4 * 1024 * 1024 + 1; });
  await assert.rejects(fetchLatestStatistics(upstream.options), /too large/);
  upstream.rebuild();
  await assert.rejects(fetchLatestStatistics({ ...upstream.options,
    currentSnapshot: { meta: { statsUpdatedAt: '2026-10-29T00:00:00+08:00' } } }), /older than current/);
});

test('runtime rejects changed bytes and whole-population metadata that contains band-only rows', async () => {
  const upstream = upstreamFixture();
  upstream.documents['heroes.json'] = Buffer.from('{}');
  await assert.rejects(fetchLatestStatistics(upstream.options), /SHA-256 or size mismatch/);
  upstream.input.meta.bands = { band: 'high' };
  upstream.rebuild();
  await assert.rejects(fetchLatestStatistics(upstream.options), /Unsupported source cohort/);
  upstream.input.meta.bands = null;
  upstream.input.heroes['1'].games = 4;
  upstream.input.heroes['1'].win_rate = 0.75;
  upstream.rebuild();
  await assert.rejects(fetchLatestStatistics(upstream.options), /Hero totals disagree/);
});

test('source streams enforce byte bounds without Content-Length and reject redirects', async () => {
  const upstream = upstreamFixture();
  let cancelled = false;
  const oversized = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(fetchLatestStatistics({ ...upstream.options, fetcher: async () => oversized() }), /too large/);
  assert.equal(cancelled, true);
  await assert.rejects(fetchLatestStatistics({ ...upstream.options, fetcher: async () => Response.redirect('https://example.invalid/redirect') }), /redirect or request failure/);
  await assert.rejects(fetchLatestStatistics({ ...upstream.options, fetcher: async () => new Response('{}', { headers: { 'content-length': String(64 * 1024 + 1) } }) }), /too large/);
  const bounded = upstreamFixture();
  let tableCancelled = false;
  const fetchTable = bounded.options.fetcher;
  await assert.rejects(fetchLatestStatistics({ ...bounded.options, fetcher: async (url, options) => {
    if (url.endsWith('/heroes.json')) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { tableCancelled = true; },
    }));
    return fetchTable(url, options);
  } }), /too large/);
  assert.equal(tableCancelled, true);
});

test('abort signal cancels a stalled source body and prevents further requests', async () => {
  const upstream = upstreamFixture();
  const controller = new AbortController();
  let cancelled = false;
  let reads = 0;
  const pending = fetchLatestStatistics({ ...upstream.options, signal: controller.signal,
    fetcher: async () => {
      reads++;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    } });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(reads, 1);
  await assert.rejects(fetchLatestStatistics({ ...upstream.options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(upstream.calls.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConditionalStatisticsClient,
  selectConditionalStatistics,
  ConditionalStatisticsError,
  CONDITIONAL_LOW_SAMPLE_THRESHOLD
} from '../dist/conditional-statistics.js';

const MANIFEST_URL = 'https://data.aramkit.com/data/versions.json';
const TIME = Date.parse('2026-10-24T08:00:00.000Z');
const clone = value => structuredClone(value);
const entry = (version = '16.21', suffix = 'fixture') => ({
  version, dataPath: `data/${version}-${suffix}`, dataDate: '2026-10-24', buildTimeUnixMs: TIME - 1000
});

// Deliberately tiny artificial aggregates; no provider dataset is shipped with these tests.
export function makeSnapshot(championId = 103) {
  return {
    championId,
    detail: {
      champion: { id: championId },
      augmentCombinations: [
        { augmentIds: [1030, 1156], sampleCount: 50, winRate: 0.6 },
        { augmentIds: [1390, 1030], sampleCount: 300, winRate: 0.55 },
        { augmentIds: [1156, 1390], sampleCount: 400, winRate: 0.58 },
        { augmentIds: [1030, 1200], sampleCount: 100, winRate: 0.65 },
        { augmentIds: [1300, 1030], sampleCount: 250, winRate: 0.57 }
      ]
    },
    single: {
      items: [
        { augmentId: 1030, sampleCount: 1000, all: [
          { id: 3100, sampleCount: 200, winRate: 0.7 },
          { id: 3089, sampleCount: 20, winRate: 0.6275 }
        ] },
        { augmentId: 1156, sampleCount: 500, all: [{ id: 3118, sampleCount: 300, winRate: 0.5 }] }
      ],
      builds: [
        { augmentId: 1030, sampleCount: 800, archetypes: [
          { key: 'ap', sampleCount: 600, winRate: 0.6, profiles: [
            { itemSet: [{ id: 3100 }, { id: 3089 }, { id: 4645 }], sampleCount: 50, winRate: 0.62, routes: [
              { purchaseOrder: [{ id: 3100 }, { id: 3089 }, { id: 4645 }], sampleCount: 10, winRate: 0.5 },
              { purchaseOrder: [{ id: 3089 }, { id: 3100 }, { id: 4645 }], sampleCount: 40, winRate: 0.65 }
            ] },
            { itemSet: [{ id: 3118 }, { id: 3089 }, { id: 4645 }], sampleCount: 300, winRate: 0.6, routes: [] },
            { itemSet: [{ id: 6655 }, { id: 3089 }, { id: 4645 }], sampleCount: 150, winRate: 0.64, routes: [] }
          ] },
          { key: 'support', sampleCount: 200, winRate: 0.55, profiles: [
            { itemSet: [{ id: 6617 }, { id: 6620 }, { id: 3107 }], sampleCount: 199, winRate: 0.56, routes: [] }
          ] }
        ] },
        { augmentId: 1156, sampleCount: 400, archetypes: [] }
      ]
    }
  };
}

function transport({ versions = [entry(), entry('16.20')], alter, intercept } = {}) {
  const state = { calls: [], versions, alter, intercept };
  state.fetcher = async (url, options) => {
    state.calls.push({ url, options });
    const intercepted = await state.intercept?.(url, options, state);
    if (intercepted !== undefined) return intercepted;
    let body;
    if (url === MANIFEST_URL) body = { latest: '16.21', versions: state.versions };
    else {
      const match = /\/champion-details\/([1-9]\d*)(-single-augments)?\.json$/.exec(url);
      assert.ok(match, `unexpected URL: ${url}`);
      const snapshot = makeSnapshot(Number(match[1]));
      body = match[2] ? snapshot.single : snapshot.detail;
    }
    body = clone(body);
    state.alter?.(body, url);
    return { ok: true, json: async () => body };
  };
  return state;
}

function clientFor(state, now = () => TIME) {
  return createConditionalStatisticsClient({ fetcher: state.fetcher, now });
}
function errorCode(code) {
  return error => error instanceof ConditionalStatisticsError && error.code === code;
}
const heroCalls = (state, id) => state.calls.filter(call => call.url.includes(`/champion-details/${id}`)).length;

test('loads only the exact champion two public JSONs and preserves source metadata', async () => {
  const state = transport();
  const snapshot = await clientFor(state).load({ championId: '103', patch: '16.21' });
  assert.equal(state.calls.length, 3);
  assert.equal(state.calls[0].url, MANIFEST_URL);
  assert.deepEqual(state.calls.slice(1).map(call => call.url).sort(), [
    'https://data.aramkit.com/data/16.21-fixture/stats/all/champion-details/103-single-augments.json',
    'https://data.aramkit.com/data/16.21-fixture/stats/all/champion-details/103.json'
  ]);
  assert.deepEqual(snapshot.meta, {
    sourceName: 'ARAMKit', sourceUrl: 'https://aramkit.com/', patch: '16.21', dataDate: '2026-10-24',
    buildTimeUnixMs: TIME - 1000, fetchedAt: new Date(TIME).toISOString(),
    dataPath: 'data/16.21-fixture', scope: 'all', pairCoverage: 'published-top-10'
  });
  assert.equal(snapshot.championId, 103);
  assert.equal(snapshot.single.items[0].all[0].winRate, 0.7);
  assert.ok(Object.isFrozen(snapshot.single.items[0].all));
});

test('every fetch omits credentials/referrer and has bounded cancellation; no local match data is sent', async () => {
  const state = transport();
  await clientFor(state).load({ championId: 103, patch: '16.21', localPlayer: 'must-not-send', token: 'not-sent' });
  for (const { url, options } of state.calls) {
    assert.equal(new URL(url).origin, 'https://data.aramkit.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    assert.ok(!url.includes('must-not-send') && !url.includes('not-sent'));
  }
});

test('selects exact gameDataId, keeps separate item/build denominators, converts fractions to percentage', () => {
  const snapshot = makeSnapshot();
  const selected = selectConditionalStatistics(snapshot, { augmentId: '1030' });
  assert.equal(selected.augmentId, 1030);
  assert.equal(selected.items.sampleCount, 1000);
  assert.equal(selected.builds.sampleCount, 800);
  assert.deepEqual(selected.items.rows, [
    { id: 3100, sampleCount: 200, winRate: 70, lowSample: false },
    { id: 3089, sampleCount: 20, winRate: 62.75, lowSample: true }
  ]);
  assert.deepEqual(selected.pairs.map(row => row.otherAugmentId), [1390, 1300, 1200]);
  assert.equal(selected.pairs[0].winRate, 55);
  assert.ok(!JSON.stringify(selected).includes('pickRate'));
  assert.ok(!JSON.stringify(selected).includes('wins'));
  assert.ok(!JSON.stringify(selected).includes('uplift'));
  const other = selectConditionalStatistics(snapshot, { augmentId: 1156 });
  assert.deepEqual(other.items.rows.map(row => row.id), [3118]);
  assert.deepEqual(other.pairs.map(row => row.otherAugmentId), [1390, 1030]);
});

test('profiles are globally sample-sorted top three and one best route is retained per profile', () => {
  const snapshot = makeSnapshot();
  let result = selectConditionalStatistics(snapshot, { augmentId: 1030 });
  assert.deepEqual(result.builds.profiles.map(row => row.sampleCount), [300, 199, 150]);
  assert.equal(result.builds.profiles[1].archetype, 'support');
  snapshot.single.builds[0].archetypes[0].profiles[0].sampleCount = 400;
  result = selectConditionalStatistics(snapshot, { augmentId: 1030 });
  assert.equal(result.builds.profiles[0].routes.length, 1);
  assert.deepEqual(result.builds.profiles[0].routes[0], {
    items: [3089, 3100, 4645], sampleCount: 40, winRate: 65, lowSample: true
  });
  assert.deepEqual(result.builds.profiles[0].items, [3100, 3089, 4645]);
});

test('unknown sample counts/rates remain null, while actual zero remains zero', () => {
  const snapshot = makeSnapshot();
  const item = snapshot.single.items[0];
  item.sampleCount = null;
  item.all = [{ id: 3100, sampleCount: null, winRate: null }, { id: 3089, sampleCount: 0, winRate: 0 }];
  const profile = snapshot.single.builds[0].archetypes[0].profiles[0];
  profile.sampleCount = 900;
  profile.winRate = null;
  profile.routes[0].sampleCount = null;
  profile.routes[1].sampleCount = null;
  profile.routes[0].winRate = null;
  snapshot.detail.augmentCombinations[1].sampleCount = null;
  snapshot.detail.augmentCombinations[1].winRate = null;
  const result = selectConditionalStatistics(snapshot, { augmentId: 1030 });
  assert.equal(result.items.sampleCount, null);
  assert.deepEqual(result.items.rows[0], { id: 3100, sampleCount: null, winRate: null, lowSample: false });
  assert.deepEqual(result.items.rows[1], { id: 3089, sampleCount: 0, winRate: 0, lowSample: true });
  assert.equal(result.builds.profiles[0].winRate, null);
  assert.equal(result.builds.profiles[0].routes[0].sampleCount, null);
  assert.equal(result.builds.profiles[0].routes[0].winRate, null);
  assert.ok(result.warnings.some(message => message.includes('未知')));
});

test('low samples are flagged at local threshold 200 but never discarded', () => {
  assert.equal(CONDITIONAL_LOW_SAMPLE_THRESHOLD, 200);
  const snapshot = makeSnapshot();
  snapshot.single.items[0].all = [
    { id: 3100, sampleCount: 199, winRate: 1 },
    { id: 3089, sampleCount: 200, winRate: 0 }
  ];
  const result = selectConditionalStatistics(snapshot, { augmentId: 1030 });
  assert.equal(result.items.rows.length, 2);
  assert.equal(result.items.rows[0].winRate, 100);
  assert.equal(result.items.rows[0].lowSample, true);
  assert.equal(result.items.rows[1].lowSample, false);
  assert.ok(result.warnings.some(message => message.includes('本地提醒')));
});

test('missing A is genuinely empty, with no generic items or global pairs fallback', () => {
  const result = selectConditionalStatistics(makeSnapshot(), { augmentId: 9999 });
  assert.deepEqual(result.items, { sampleCount: null, rows: [] });
  assert.deepEqual(result.builds, { sampleCount: null, profiles: [] });
  assert.deepEqual(result.pairs, []);
  assert.ok(result.warnings.some(message => message.includes('前10')));
  assert.ok(result.warnings.some(message => message.includes('无法判断')));
});

test('pairs and equipment remain independently available and never invent triple conditioning', () => {
  const snapshot = makeSnapshot();
  snapshot.single.items = [];
  snapshot.single.builds = [];
  const result = selectConditionalStatistics(snapshot, { augmentId: 1030 });
  assert.deepEqual(result.items, { sampleCount: null, rows: [] });
  assert.equal(result.pairs.length, 3);
  assert.equal(result.pairs[0].sampleCount, 300);
  assert.ok(result.warnings.some(message => message.includes('不表示同时选择')));
});

test('route-only nested metadata is not treated as an additional validated/elected equipment list', () => {
  const snapshot = makeSnapshot();
  snapshot.single.builds[0].archetypes[0].profiles[0].routes[0].boots = [{ item: { id: 0 }, sampleCount: 10 }];
  assert.doesNotThrow(() => selectConditionalStatistics(snapshot, { augmentId: 1030 }));
});

test('published-top-10 source shape cannot silently grow beyond ten combinations', () => {
  const snapshot = makeSnapshot();
  snapshot.detail.augmentCombinations = Array.from({ length: 10 }, (_, index) => ({
    augmentIds: [1030, 2000 + index], sampleCount: 20, winRate: 0.5
  }));
  assert.doesNotThrow(() => selectConditionalStatistics(snapshot, { augmentId: 1030 }));
  snapshot.detail.augmentCombinations.push({ augmentIds: [1030, 2010], sampleCount: 10, winRate: 0.4 });
  assert.throws(() => selectConditionalStatistics(snapshot, { augmentId: 1030 }), errorCode('invalid-data'));
});

test('three-item profiles and purchase routes must contain the same three unique equipment IDs', () => {
  const mutations = [
    profile => { profile.itemSet.pop(); },
    profile => { profile.itemSet.push({ id: 3118 }); },
    profile => { profile.routes[0].purchaseOrder.pop(); },
    profile => { profile.routes[0].purchaseOrder.push({ id: 3118 }); },
    profile => { profile.routes[0].purchaseOrder[2].id = 3118; }
  ];
  for (const mutate of mutations) {
    const snapshot = makeSnapshot();
    mutate(snapshot.single.builds[0].archetypes[0].profiles[0]);
    assert.throws(() => selectConditionalStatistics(snapshot, { augmentId: 1030 }), errorCode('invalid-data'));
  }
  assert.doesNotThrow(() => selectConditionalStatistics(makeSnapshot(), { augmentId: 1030 }));
});

test('rejects responses belonging to a different champion', async () => {
  const state = transport({ alter(body) { if (body.champion) body.champion.id = 104; } });
  await assert.rejects(clientFor(state).load({ championId: 103, patch: '16.21' }), errorCode('invalid-data'));
  const snapshot = makeSnapshot();
  snapshot.championId = 104;
  assert.throws(() => selectConditionalStatistics(snapshot, { augmentId: 1030 }), errorCode('invalid-data'));
});

test('rejects malformed numbers, duplicate IDs and self pairs instead of silently constructing records', () => {
  const mutations = [
    s => { s.single.items[0].all[0].id = null; },
    s => { s.single.items[0].all[0].id = 'bad'; },
    s => { s.single.items[0].all[0].sampleCount = -1; },
    s => { s.single.items[0].all[0].sampleCount = 2.5; },
    s => { s.single.items[0].all[0].sampleCount = '20'; },
    s => { s.single.items[0].all[0].winRate = 65; },
    s => { s.single.items[0].all[0].winRate = NaN; },
    s => { s.single.items[0].all[0].winRate = -0.1; },
    s => { s.single.items[0].all[0].winRate = Infinity; },
    s => { s.single.items[0].all.push(clone(s.single.items[0].all[0])); },
    s => { s.single.items.push(clone(s.single.items[0])); },
    s => { s.single.builds.push(clone(s.single.builds[0])); },
    s => { s.detail.augmentCombinations[0].augmentIds = [1030, 1030]; },
    s => { s.detail.augmentCombinations[0].augmentIds.push(1390); },
    s => { s.detail.augmentCombinations.push({ augmentIds: [1156, 1030], sampleCount: 2, winRate: 0.5 }); },
    s => { s.single.builds[0].archetypes[0].profiles[0].itemSet.push({ id: 3100 }); },
    s => { s.single.builds[0].archetypes[0].profiles[0].routes[0].purchaseOrder.push({ id: 3100 }); }
  ];
  for (const mutate of mutations) {
    const snapshot = makeSnapshot();
    mutate(snapshot);
    assert.throws(() => selectConditionalStatistics(snapshot, { augmentId: 1030 }), errorCode('invalid-data'));
  }
});

test('only exact numeric identifiers and exact patch names are accepted, with no implicit patch mapping', async () => {
  const state = transport();
  const client = clientFor(state);
  for (const championId of [null, 0, -1, 103.5, '01', ' 103', 'Ahri', true, {}, '103/../104']) {
    await assert.rejects(client.load({ championId, patch: '16.21' }), errorCode('invalid-input'));
  }
  for (const patch of [undefined, null, 16.21, 'latest', '16.21 ', '../16.21', 'https://evil.example']) {
    await assert.rejects(client.load({ championId: 103, patch }), errorCode('invalid-input'));
  }
  assert.equal(state.calls.length, 0);
  await assert.rejects(client.load({ championId: 103, patch: '26.21' }), errorCode('unavailable-version'));
  assert.equal(state.calls.length, 1);
  assert.throws(() => selectConditionalStatistics(makeSnapshot(), { augmentId: null }), errorCode('invalid-input'));
  assert.throws(() => selectConditionalStatistics(makeSnapshot(), { augmentId: 'Eureka' }), errorCode('invalid-input'));
});

test('manifest rejects unsafe data paths and patch/path disagreement before any champion fetch', async () => {
  for (const dataPath of [
    'https://evil.example/data/16.21', '//evil.example/data', 'data/../16.21', 'data/16.21/x',
    'data/16.21%2f..', 'data\\16.21', 'data/16.20-fixture', 'data/16.21-foo..bar', 'data/16.21?x=1'
  ]) {
    const state = transport({ versions: [{ ...entry(), dataPath }] });
    await assert.rejects(clientFor(state).load({ championId: 103, patch: '16.21' }), errorCode('invalid-manifest'));
    assert.equal(state.calls.length, 1);
  }
});

test('manifest rejects duplicate versions and invalid dates/build timestamps', async () => {
  for (const versions of [
    [entry(), entry()], [{ ...entry(), dataDate: '2026-02-30' }],
    [{ ...entry(), buildTimeUnixMs: null }], [{ ...entry(), buildTimeUnixMs: '1792820649085' }]
  ]) {
    const state = transport({ versions });
    await assert.rejects(clientFor(state).load({ championId: 103, patch: '16.21' }), errorCode('invalid-manifest'));
  }
});

test('manifest/champion concurrent requests are deduplicated; selectors do not issue requests', async () => {
  const state = transport();
  const client = clientFor(state);
  const [a, b, c] = await Promise.all([
    client.load({ championId: 103, patch: '16.21' }),
    client.load({ championId: '103', patch: '16.21' }),
    client.load({ championId: 104, patch: '16.21' })
  ]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(state.calls.filter(call => call.url === MANIFEST_URL).length, 1);
  assert.equal(heroCalls(state, 103), 2);
  selectConditionalStatistics(a, { augmentId: 1030 });
  selectConditionalStatistics(a, { augmentId: 1156 });
  assert.equal(state.calls.length, 5);
});

test('LRU is capped at three entries across both patches and heroes, including cache touches', async () => {
  const state = transport();
  const client = clientFor(state);
  await client.load({ championId: 103, patch: '16.21' });
  await client.load({ championId: 104, patch: '16.21' });
  await client.load({ championId: 103, patch: '16.20' });
  await client.load({ championId: 103, patch: '16.21' }); // touch: the 104 entry becomes oldest
  await client.load({ championId: 105, patch: '16.21' });
  assert.equal(state.calls.length, 9);
  await client.load({ championId: 103, patch: '16.21' });
  await client.load({ championId: 103, patch: '16.20' });
  assert.equal(state.calls.length, 9);
  await client.load({ championId: 104, patch: '16.21' });
  assert.equal(state.calls.length, 11);
  await client.load({ championId: 105, patch: '16.21' }); // evicted by the last request
  assert.equal(state.calls.length, 13);
});

test('manifest refresh revisions share the same bounded LRU instead of retaining historical artifact caches', async () => {
  let time = TIME;
  const state = transport();
  const client = clientFor(state, () => time);
  for (let revision = 0; revision < 4; revision++) {
    state.versions = [entry('16.21', `revision${revision}`)];
    time = TIME + revision * 300001;
    await client.load({ championId: 103, patch: '16.21' });
  }
  assert.equal(state.calls.length, 12);
  state.versions = [entry('16.21', 'revision0')];
  time += 300001;
  await client.load({ championId: 103, patch: '16.21' });
  assert.equal(state.calls.length, 15); // old revision was evicted, not preserved in another map
});

test('failed hero loads are not cached and explicit retry succeeds', async () => {
  let failOnce = true;
  const state = transport({ intercept(url) {
    if (failOnce && url.endsWith('/103.json')) { failOnce = false; return { ok: false, status: 503 }; }
  } });
  const client = clientFor(state);
  await assert.rejects(client.load({ championId: 103, patch: '16.21' }), errorCode('fetch-failed'));
  assert.equal((await client.load({ championId: 103, patch: '16.21' })).championId, 103);
  assert.equal(state.calls.filter(call => call.url === MANIFEST_URL).length, 1);
  assert.equal(heroCalls(state, 103), 4);
});

test('failed/invalid manifest may be retried and malformed JSON is explicitly reported', async () => {
  let failOnce = true;
  const state = transport({ intercept(url) {
    if (url === MANIFEST_URL && failOnce) {
      failOnce = false;
      return { ok: true, json: async () => { throw new SyntaxError('bad JSON'); } };
    }
  } });
  const client = clientFor(state);
  await assert.rejects(client.load({ championId: 103, patch: '16.21' }), errorCode('invalid-manifest'));
  assert.equal((await client.load({ championId: 103, patch: '16.21' })).championId, 103);
  assert.equal(state.calls.filter(call => call.url === MANIFEST_URL).length, 2);
  const bad = transport({ intercept(url) {
    if (url.endsWith('/103.json')) return { ok: true, json: async () => { throw new SyntaxError('bad JSON'); } };
  } });
  await assert.rejects(clientFor(bad).load({ championId: 103, patch: '16.21' }), errorCode('invalid-data'));
});

test('a stalled fetch times out even when its fetch implementation ignores cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const client = createConditionalStatisticsClient({ now: () => TIME, fetcher: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const pending = client.load({ championId: 103, patch: '16.21' });
  const assertion = assert.rejects(pending, errorCode('timeout'));
  context.mock.timers.tick(15000);
  await assertion;
  assert.equal(signal.aborted, true);
});

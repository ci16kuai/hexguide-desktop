import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE, transformStatistics, validateCounts, updateStatistics } from '../scripts/update-statistics.mjs';

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
    gameData: { champions: [{ id: 'Annie' }, { id: 'Ahri' }], augments: [{ id: 'live-augment', gameDataId: 1030 }] },
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

test('bundled snapshot covers all heroes with coherent totals and 303 separately labelled provisional rows', async () => {
  const result = JSON.parse(await fs.readFile(path.join(project, 'dist/statistics.json'), 'utf8'));
  assert.equal(result.meta.source.commit, SOURCE.commit);
  assert.equal(result.meta.validGames, 5_141_715);
  assert.equal(result.champions.length, 173);
  assert.equal(new Set(result.champions.map(c => c.championId)).size, 173);
  assert.equal(result.champions.reduce((sum, c) => sum + c.games, 0), result.meta.validGames * 10);
  assert.equal(result.champions.reduce((sum, c) => sum + c.wins, 0), result.meta.validGames * 5);
  const augments = result.champions.flatMap(c => c.augments);
  assert.equal(augments.length, 23_193);
  assert.equal(augments.filter(a => a.provisional).length, 303);
  assert.deepEqual([...new Set(augments.filter(a => a.provisional).map(a => a.sourceAugmentId))].sort(), ['3025', '3039', '3048', '3058']);
  assert(augments.every(a => a.augmentId !== null && a.lowSample === (a.games < 3000) && a.builds.length === 0));
  assert(augments.every(a => a.cohortId === (a.provisional ? 'aramhex-pbe-16.21.828' : result.meta.cohortId)));
});

test('failed offline source verification preserves the previously published statistics file', async () => {
  const scratchRoot = path.resolve('H:/Chatgpt/work/2026-10-23/hexguide-desktop/statistics-import-tests');
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

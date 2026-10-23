#!/usr/bin/env node
/** Import one fixed, attributable AramHex snapshot. Never combines live and PBE cohorts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const SOURCE = Object.freeze({
  commit: '5e6770a1550d2eb40f4da83e31f142e4588524b0',
  patch: '16.21',
  rulesPatch: '26.21',
  path: 'patches/16.21/normal',
  hashes: Object.freeze({
    'latest.json': '6d0750fb559df0458a52e630ea05e1885dec22cf66bceb147719d793d78ed552',
    'meta.json': '3c63e3bad6b78847a9736ec3bcd21fa325afadc6cdb07b6d55ff8e0c40baf2f1',
    'heroes.json': 'c101701e44585bda7d3f3f6fabd4bd3ec446d217eaac83dd70d9871e72f274f9',
    'hero_augments.json': '7aafc8dae79fa850356acc3369c512aea065553eca5c5e76bc45a489f1c30941',
    'augments.json': '302740c60e441e11ed24614c6971d535429a9214ea742cd066a8fce7dc2d5d97',
  }),
});
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawBase = `https://raw.githubusercontent.com/czgreat/aramhex-data/${SOURCE.commit}/`;
const numericId = /^[1-9]\d*$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value, label, positive = false) => assert(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), `Invalid ${label}`);
const timestamp = (value, label) => assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value) && Number.isFinite(Date.parse(value)), `Invalid ${label}`);

export function validateCounts(row, label) {
  assert(isRecord(row), `Missing ${label}`);
  count(row.games, `${label}.games`, true);
  count(row.wins, `${label}.wins`);
  assert(row.wins <= row.games, `Wins exceed games for ${label}`);
  assert(typeof row.win_rate === 'number' && Number.isFinite(row.win_rate) && row.win_rate >= 0 && row.win_rate <= 1, `Invalid win_rate for ${label}`);
  // The upstream publishes proportions rounded to six decimal places.
  assert(Math.abs(row.win_rate - row.wins / row.games) <= 0.000000500001, `win_rate disagrees with wins/games for ${label}`);
}

export function transformStatistics({ meta, heroes, heroAugments, sourceAugments, championCatalog, gameData, fetchedAt = new Date().toISOString() }) {
  assert(isRecord(meta) && meta.schema_version === 1 && meta.patch === SOURCE.patch && meta.mode === 'normal' && meta.bands === null && meta.regions_combined === true, 'Unsupported source cohort');
  assert(meta.license === 'CC BY-NC 4.0', 'Unexpected data license');
  timestamp(meta.snapshot_at, 'snapshot_at');
  timestamp(meta.window?.start, 'window.start');
  timestamp(meta.window?.end_exclusive, 'window.end_exclusive');
  assert(Date.parse(meta.window.start) < Date.parse(meta.window.end_exclusive) && Date.parse(meta.window.end_exclusive) <= Date.parse(meta.snapshot_at), 'Invalid observation window');
  count(meta.matches?.valid, 'valid matches', true);
  assert(Array.isArray(meta.regions) && meta.regions.length === 7 && new Set(meta.regions).size === 7, 'Expected seven merged CN regions');
  assert(isRecord(heroes) && isRecord(heroAugments) && isRecord(sourceAugments), 'Missing source tables');
  assert(Array.isArray(championCatalog?.champions) && Array.isArray(gameData?.champions) && Array.isArray(gameData?.augments), 'Missing local ID catalog');
  assert(Object.keys(heroes).length === meta.heroes && Object.keys(heroAugments).length === meta.heroes, 'Hero coverage disagrees with source metadata');
  const localChampionIds = new Set(gameData.champions.map(c => c.id));
  const championBySource = new Map();
  for (const champion of championCatalog.champions) {
    const key = String(champion.key);
    assert(numericId.test(key) && typeof champion.id === 'string' && localChampionIds.has(champion.id) && !championBySource.has(key), `Invalid champion mapping: ${key}`);
    championBySource.set(key, champion.id);
  }
  const augmentBySource = new Map();
  for (const augment of gameData.augments) {
    if (augment.gameDataId === undefined || augment.gameDataId === null) continue;
    const key = String(augment.gameDataId);
    assert(numericId.test(key) && typeof augment.id === 'string' && !augmentBySource.has(key), `Ambiguous local augment mapping: ${key}`);
    augmentBySource.set(key, augment.id);
  }
  for (const [id, augment] of Object.entries(sourceAugments)) {
    assert(numericId.test(id) && isRecord(augment) && typeof augment.name === 'string' && augment.name.trim() && ['silver', 'gold', 'prismatic'].includes(augment.rarity), `Invalid source augment: ${id}`);
  }
  const provisionalIds = new Set(Object.keys(meta.provisional_augments ?? {}));
  for (const [id, row] of Object.entries(meta.provisional_augments ?? {})) {
    assert(sourceAugments[id], `Missing provisional augment metadata: ${id}`);
    validateCounts(row, `provisional.${id}`);
  }
  const cohortId = `aramhex-cn-${SOURCE.patch}-normal-all-${meta.snapshot_at}`;
  const unmapped = new Map();
  let augmentRows = 0;
  let mappedAugmentRows = 0;
  let provisionalRows = 0;
  let heroGames = 0;
  let heroWins = 0;
  const provisionalTotals = new Map([...provisionalIds].map(id => [id, { games: 0, wins: 0 }]));
  const champions = Object.entries(heroes).map(([sourceChampionId, hero]) => {
    assert(numericId.test(sourceChampionId) && championBySource.has(sourceChampionId), `Unknown source champion ID: ${sourceChampionId}`);
    validateCounts(hero, `heroes.${sourceChampionId}`);
    assert(typeof hero.name === 'string' && hero.name.trim(), `Missing hero name: ${sourceChampionId}`);
    heroGames += hero.games;
    heroWins += hero.wins;
    const sourceUrl = `https://aramhex.com/data/hero/${encodeURIComponent(hero.name)}/`;
    const rows = heroAugments[sourceChampionId];
    assert(isRecord(rows), `Missing augment table for hero ${sourceChampionId}`);
    const augments = Object.entries(rows).map(([sourceAugmentId, row]) => {
      assert(numericId.test(sourceAugmentId) && sourceAugments[sourceAugmentId], `Unknown source augment ID: ${sourceAugmentId}`);
      assert(!Object.hasOwn(meta.excluded_augments ?? {}, sourceAugmentId), `Excluded augment present in statistics: ${sourceAugmentId}`);
      validateCounts(row, `hero_augments.${sourceChampionId}.${sourceAugmentId}`);
      assert(typeof row.low_sample === 'boolean' && row.low_sample === (row.games < 3000), `Invalid low_sample flag: ${sourceChampionId}.${sourceAugmentId}`);
      const provisional = provisionalIds.has(sourceAugmentId);
      if (!provisional) assert(row.games <= hero.games && row.wins <= hero.wins && row.games - row.wins <= hero.games - hero.wins, `Augment counts exceed hero baseline: ${sourceChampionId}.${sourceAugmentId}`);
      if (provisional) {
        provisionalRows++;
        const total = provisionalTotals.get(sourceAugmentId);
        total.games += row.games;
        total.wins += row.wins;
      }
      const augmentId = augmentBySource.get(sourceAugmentId) ?? null;
      if (augmentId) mappedAugmentRows++;
      else unmapped.set(sourceAugmentId, { sourceAugmentId, name: sourceAugments[sourceAugmentId].name });
      augmentRows++;
      return {
        augmentId, sourceAugmentId, name: sourceAugments[sourceAugmentId].name,
        rarity: sourceAugments[sourceAugmentId].rarity,
        cohortId: provisional ? 'aramhex-pbe-16.21.828' : cohortId,
        winRate: Number((row.win_rate * 100).toFixed(4)), games: row.games, wins: row.wins,
        lowSample: row.low_sample, provisional, sourceUrl, builds: [],
      };
    });
    return {
      championId: championBySource.get(sourceChampionId), sourceChampionId, cohortId,
      winRate: Number((hero.win_rate * 100).toFixed(4)), games: hero.games, wins: hero.wins,
      sourceUrl, augments,
    };
  });
  assert(heroGames === meta.matches.valid * 10 && heroWins === meta.matches.valid * 5, 'Hero totals disagree with the valid 5v5 cohort');
  for (const [id, total] of provisionalTotals) {
    assert(total.games === meta.provisional_augments[id].games && total.wins === meta.provisional_augments[id].wins, `Provisional totals disagree for ${id}`);
  }
  return {
    schemaVersion: 1,
    meta: {
      mode: 'aram-mayhem', patch: SOURCE.patch, rulesPatch: SOURCE.rulesPatch, cohortId,
      observedFrom: meta.window.start, observedTo: meta.window.end_exclusive,
      statsUpdatedAt: meta.snapshot_at, fetchedAt,
      region: '国服7区合并', rank: '全分段', validGames: meta.matches.valid, lowSampleThreshold: 3000,
      exposure: meta.augment_exposure,
      validityRule: meta.matches.validity_rule,
      limitations: [...(meta.limitations ?? [])],
      excludedAugments: structuredClone(meta.excluded_augments ?? {}),
      source: {
        name: 'AramHex', url: 'https://github.com/czgreat/aramhex-data',
        dataUrl: `${rawBase}${SOURCE.path}/`, license: 'CC BY-NC 4.0',
        licenseUrl: `https://github.com/czgreat/aramhex-data/blob/${SOURCE.commit}/LICENSE`,
        commit: SOURCE.commit,
        attribution: '海克斯大乱斗统计数据（github.com/czgreat/aramhex-data），CC BY-NC 4.0',
        modifications: '按官方数值 ID 映射本地英雄及海克斯；比例转为百分比；保留正式服与测试服独立口径，未导入出装统计。',
      },
      coverage: {
        championsWithStats: champions.length, championsTotal: gameData.champions.length,
        augmentRows, mappedAugmentRows, provisionalRows,
        unmappedAugments: [...unmapped.values()].sort((a, b) => Number(a.sourceAugmentId) - Number(b.sourceAugmentId)),
      },
    },
    champions,
  };
}

async function verifiedSource(filename, { cache, refresh, offline }) {
  const cacheFile = path.join(cache, SOURCE.commit, filename);
  let bytes;
  if (!refresh || offline) {
    try { bytes = await fs.readFile(cacheFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!bytes) {
    assert(!offline, `No cached source file: ${filename}`);
    const suffix = filename === 'latest.json' ? filename : `${SOURCE.path}/${filename}`;
    const response = await fetch(rawBase + suffix, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'HexGuide/1.5 (noncommercial statistics importer)' } });
    assert(response.ok, `Source HTTP ${response.status}: ${filename}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  assert(bytes.length <= 4 * 1024 * 1024, `Source file too large: ${filename}`);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert(actualHash === SOURCE.hashes[filename], `SHA-256 mismatch: ${filename}; previous statistics file preserved`);
  const json = JSON.parse(bytes.toString('utf8'));
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, bytes);
  return json;
}

export async function updateStatistics({ output = path.join(project, 'dist/statistics.json'), cache = 'H:/Chatgpt/work/2026-10-23/hexguide-desktop/statistics-source-cache', refresh = false, offline = false } = {}) {
  const config = { cache, refresh, offline };
  const [latest, meta, heroes, heroAugments, sourceAugments, championCatalog, gameData] = await Promise.all([
    verifiedSource('latest.json', config), verifiedSource('meta.json', config),
    verifiedSource('heroes.json', config), verifiedSource('hero_augments.json', config), verifiedSource('augments.json', config),
    fs.readFile(path.join(project, 'server/resources/champions-16.21.1.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(project, 'dist/data.json'), 'utf8').then(JSON.parse),
  ]);
  assert(latest.patch === SOURCE.patch && latest.path === SOURCE.path && latest.mode === 'normal' && latest.seq === 8 && latest.snapshot_at === meta.snapshot_at && latest.matches === meta.matches.valid, 'Source manifest and cohort metadata disagree');
  for (const filename of ['meta.json', 'heroes.json', 'hero_augments.json', 'augments.json']) {
    assert(latest.files?.[filename]?.sha256 === SOURCE.hashes[filename], `Manifest hash mismatch: ${filename}`);
    if (filename !== 'meta.json') assert(meta.files?.[filename] === SOURCE.hashes[filename], `Metadata hash mismatch: ${filename}`);
  }
  const result = transformStatistics({ meta, heroes, heroAugments, sourceAugments, championCatalog, gameData });
  const destination = path.resolve(output);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(result) + '\n', { flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    assert(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${name}`);
    return args[index + 1];
  };
  try {
    const result = await updateStatistics({ output: option('--out', undefined), cache: option('--cache', undefined), refresh: args.includes('--refresh'), offline: args.includes('--offline') });
    console.log(JSON.stringify({ patch: result.meta.patch, snapshot: result.meta.statsUpdatedAt, validGames: result.meta.validGames, ...result.meta.coverage }));
  } catch (error) {
    console.error(`Statistics import failed: ${error.message}`);
    process.exitCode = 1;
  }
}

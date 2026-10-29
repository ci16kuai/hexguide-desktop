import { createHash } from 'node:crypto';

export const SOURCE = Object.freeze({
  commit: '899b65acd4474878a82d86bad365a4ecbbcf04d8',
  seq: 10,
  patch: '16.21',
  rulesPatch: '26.21',
  path: 'patches/16.21/normal',
  hashes: Object.freeze({
    'latest.json': '491abc75a232ebae3f5958012685c0d7fa9b5a343ce5c6b131e5094b8f61de9a',
    'meta.json': 'c4af3ba0d69fc19963c16b4c40a5d95ec44c6bd7debcebfcc7549e6d079fe88a',
    'heroes.json': '6b86817788db334f4608f1a7e265472b467fb6b2d09f232f7728a17f81a776b8',
    'hero_augments.json': '27a1bf02c5e44f538292ec1fa7df01996f0f086cfa2777d2620aac9222cbcb24',
    'augments.json': '69b7bf4f2f3e87598ad664d31d582009df357dde1432678bfd7aa3ecbbafa48b',
  }),
});
const numericId = /^[1-9]\d*$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value, label, positive = false) => assert(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), `Invalid ${label}`);
const timestamp = (value, label) => assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?\+08:00$/.test(value) && Number.isFinite(Date.parse(value)), `Invalid ${label}`);

const tableNames = Object.freeze(['meta.json', 'heroes.json', 'hero_augments.json', 'augments.json']);
const manifestLimit = 64 * 1024;
const tableLimit = 4 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const patchPattern = /^\d+\.\d+$/;
const commitPattern = /^[a-f0-9]{40}$/;

async function boundedJson(url, { maxBytes, fetcher = fetch, signal } = {}) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  requestSignal.throwIfAborted();
  const response = await fetcher(url, {
    signal: requestSignal, redirect: 'error',
    headers: { 'User-Agent': 'HexGuide (noncommercial statistics updater)', Accept: 'application/json' },
  });
  const rejectResponse = async message => {
    await response.body?.cancel().catch(() => {});
    throw new Error(message);
  };
  if (!response.ok || response.redirected || (response.url && response.url !== url)) {
    await rejectResponse(`Source HTTP ${response.status}: redirect or request failure`);
  }
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await rejectResponse('Source file too large');
  }
  assert(response.body && typeof response.body.getReader === 'function', 'Missing source stream');
  const reader = response.body.getReader();
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  requestSignal.addEventListener('abort', abortRead, { once: true });
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      requestSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      requestSignal.throwIfAborted();
      size += value.byteLength;
      assert(size <= maxBytes, 'Source file too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    requestSignal.removeEventListener('abort', abortRead);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  requestSignal.throwIfAborted();
  const bytes = Buffer.concat(chunks, size);
  return { bytes, json: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

/** Only a pinned commit and the four whole-population tables can form a source URL. */
export async function fetchSourceFile(commit, filename, { patch = SOURCE.patch, fetcher = fetch, signal } = {}) {
  assert(commitPattern.test(commit) && patchPattern.test(patch), 'Invalid source revision');
  assert(filename === 'latest.json' || tableNames.includes(filename), 'Unsupported source file');
  const suffix = filename === 'latest.json' ? filename : `patches/${patch}/normal/${filename}`;
  return boundedJson(`https://raw.githubusercontent.com/czgreat/aramhex-data/${commit}/${suffix}`, {
    maxBytes: filename === 'latest.json' ? manifestLimit : tableLimit, fetcher, signal,
  });
}

export function validateSourceManifest(latest, { patch = SOURCE.patch } = {}) {
  assert(isRecord(latest) && latest.schema_version === 1 && latest.patch === patch && latest.mode === 'normal'
    && latest.path === `patches/${patch}/normal`, 'Unsupported source cohort');
  count(latest.seq, 'source sequence', true);
  count(latest.matches, 'source matches', true);
  timestamp(latest.snapshot_at, 'snapshot_at');
  assert(isRecord(latest.files), 'Missing source file manifest');
  for (const filename of tableNames) {
    const entry = latest.files[filename];
    assert(isRecord(entry) && /^[a-f0-9]{64}$/.test(entry.sha256), `Invalid manifest hash: ${filename}`);
    count(entry.size, `manifest size: ${filename}`, true);
    assert(entry.size <= tableLimit, `Source file too large: ${filename}`);
  }
}

export function validateSourceDocuments({ latest, meta, source = SOURCE }) {
  validateSourceManifest(latest, source);
  assert(latest.seq === source.seq && latest.snapshot_at === meta.snapshot_at && latest.matches === meta.matches?.valid,
    'Source manifest and cohort metadata disagree');
  for (const filename of tableNames) {
    assert(latest.files[filename].sha256 === source.hashes[filename], `Manifest hash mismatch: ${filename}`);
    if (filename !== 'meta.json') assert(meta.files?.[filename] === source.hashes[filename], `Metadata hash mismatch: ${filename}`);
  }
}

/** Fetch one current live cohort; never merge snapshots, bands, or PBE observations. */
export async function fetchLatestStatistics({ championCatalog, gameData, currentSnapshot, fetcher = fetch, signal } = {}) {
  const version = gameData?.meta?.clientDataVersion;
  const match = typeof version === 'string' && /^(\d+\.\d+)(?:\.\d+)?$/.exec(version);
  assert(match, 'Missing compatible client data version');
  const patch = match[1];
  const ref = await boundedJson('https://api.github.com/repos/czgreat/aramhex-data/git/ref/heads/main', { maxBytes: manifestLimit, fetcher, signal });
  assert(ref.json?.object?.type === 'commit' && commitPattern.test(ref.json.object.sha), 'Invalid upstream main revision');
  const commit = ref.json.object.sha;
  const manifest = await fetchSourceFile(commit, 'latest.json', { patch, fetcher, signal });
  const latest = manifest.json;
  validateSourceManifest(latest, { patch });
  const current = currentSnapshot?.meta;
  assert(!current || Date.parse(latest.snapshot_at) >= Date.parse(current.statsUpdatedAt), 'Source snapshot is older than current statistics');
  const hashes = Object.fromEntries(tableNames.map(filename => [filename, latest.files[filename].sha256]));
  // A documentation-only upstream commit can retain the exact same data manifest.
  if (current?.mode === 'aram-mayhem' && current.patch === patch && current.statsUpdatedAt === latest.snapshot_at && current.source?.hashes
    && tableNames.every(filename => current.source.hashes[filename] === hashes[filename])) return null;
  const source = { commit, seq: latest.seq, patch, rulesPatch: gameData.meta.patch, path: latest.path,
    hashes: { 'latest.json': manifest.sha256, ...hashes } };
  const readVerified = async filename => {
    const document = await fetchSourceFile(commit, filename, { patch, fetcher, signal });
    assert(document.bytes.length === latest.files[filename].size && document.sha256 === hashes[filename], `SHA-256 or size mismatch: ${filename}`);
    return document.json;
  };
  const meta = await readVerified('meta.json');
  validateSourceDocuments({ latest, meta, source });
  assert(!Object.keys(meta.provisional_augments ?? {}).length, 'Runtime statistics cannot include PBE provisional data');
  const [heroes, heroAugments, sourceAugments] = await Promise.all([
    readVerified('heroes.json'), readVerified('hero_augments.json'), readVerified('augments.json'),
  ]);
  signal?.throwIfAborted();
  return transformStatistics({ meta, heroes, heroAugments, sourceAugments, championCatalog, gameData, source });
}

export function validateCounts(row, label) {
  assert(isRecord(row), `Missing ${label}`);
  count(row.games, `${label}.games`, true);
  count(row.wins, `${label}.wins`);
  assert(row.wins <= row.games, `Wins exceed games for ${label}`);
  assert(typeof row.win_rate === 'number' && Number.isFinite(row.win_rate) && row.win_rate >= 0 && row.win_rate <= 1, `Invalid win_rate for ${label}`);
  // The upstream publishes proportions rounded to six decimal places.
  assert(Math.abs(row.win_rate - row.wins / row.games) <= 0.000000500001, `win_rate disagrees with wins/games for ${label}`);
}

export function transformStatistics({ meta, heroes, heroAugments, sourceAugments, championCatalog, gameData, fetchedAt = new Date().toISOString(), source = SOURCE }) {
  const wholePopulationBands = meta?.bands === null || (isRecord(meta?.bands) && isRecord(meta.bands.bands)
    && ['casual', 'mid', 'high', 'top'].every(id => isRecord(meta.bands.bands[id])));
  assert(isRecord(meta) && meta.schema_version === 1 && meta.patch === source.patch && meta.mode === 'normal'
    && wholePopulationBands && meta.regions_combined === true, 'Unsupported source cohort');
  assert(meta.license === 'CC BY-NC 4.0', 'Unexpected data license');
  timestamp(meta.snapshot_at, 'snapshot_at');
  timestamp(meta.window?.start, 'window.start');
  timestamp(meta.window?.end_exclusive, 'window.end_exclusive');
  assert(Date.parse(meta.window.start) < Date.parse(meta.window.end_exclusive) && Date.parse(meta.window.end_exclusive) <= Date.parse(meta.snapshot_at), 'Invalid observation window');
  count(meta.matches?.valid, 'valid matches', true);
  assert(meta.low_sample_threshold === undefined || meta.low_sample_threshold === 3000, 'Unsupported low-sample threshold');
  assert(meta.hero_participations === undefined || meta.hero_participations === meta.matches.valid * 10, 'Invalid whole-population participation count');
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
  const cohortId = `aramhex-cn-${source.patch}-normal-all-${meta.snapshot_at}`;
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
      mode: 'aram-mayhem', patch: source.patch, rulesPatch: source.rulesPatch, cohortId,
      observedFrom: meta.window.start, observedTo: meta.window.end_exclusive,
      statsUpdatedAt: meta.snapshot_at, fetchedAt,
      region: '国服7区合并', rank: '全分段', validGames: meta.matches.valid, lowSampleThreshold: 3000,
      exposure: meta.augment_exposure,
      hotfix: structuredClone(meta.hotfix ?? null),
      bands: structuredClone(meta.bands ?? null),
      validityRule: meta.matches.validity_rule,
      limitations: [...(meta.limitations ?? [])],
      excludedAugments: structuredClone(meta.excluded_augments ?? {}),
      source: {
        name: 'AramHex', url: 'https://github.com/czgreat/aramhex-data',
        dataUrl: `https://raw.githubusercontent.com/czgreat/aramhex-data/${source.commit}/${source.path}/`, license: 'CC BY-NC 4.0',
        licenseUrl: `https://github.com/czgreat/aramhex-data/blob/${source.commit}/LICENSE`,
        commit: source.commit, seq: source.seq, hashes: structuredClone(source.hashes),
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

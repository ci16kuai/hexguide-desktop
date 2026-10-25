// Only public, selected-champion aggregates are requested. Match/session state is never sent.
const ORIGIN = 'https://data.aramkit.com';
const MANIFEST_URL = `${ORIGIN}/data/versions.json`;
const MANIFEST_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const CACHE_LIMIT = 3;
export const CONDITIONAL_LOW_SAMPLE_THRESHOLD = 200;

export class ConditionalStatisticsError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ConditionalStatisticsError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, message) {
  throw new ConditionalStatisticsError(code, message);
}

function object(value, label, code = 'invalid-data') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${label}结构无效。`);
  return value;
}

function identifier(value, label, code = 'invalid-data') {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    fail(code, `${label}必须为正整数ID。`);
  }
  return number;
}

function patchName(value, code = 'invalid-input') {
  if (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}[a-z]?$/.test(value)) {
    fail(code, '请提供精确的数据版本，例如16.21。');
  }
  return value;
}

function list(value, label) {
  if (!Array.isArray(value)) fail('invalid-data', `${label}必须为数组。`);
  return value;
}

function nullableCount(value, label) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid-data', `${label}样本数无效。`);
  }
  return value;
}

function nullableRate(value, label) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail('invalid-data', `${label}胜率须为0到1的小数。`);
  }
  return value;
}

function statistics(row, label) {
  object(row, label);
  nullableCount(row.sampleCount, label);
  nullableRate(row.winRate, label);
}

function unique(value, seen, label) {
  if (seen.has(value)) fail('invalid-data', `${label}出现重复ID或组合。`);
  seen.add(value);
}

function itemIds(rows, label) {
  const seen = new Set();
  return list(rows, label).map(row => {
    const id = identifier(object(row, label).id, label);
    unique(id, seen, label);
    return id;
  });
}

function validatePayload(championId, detail, single) {
  object(detail, '英雄详情');
  const actualChampion = identifier(object(detail.champion, '英雄').id, '英雄');
  if (actualChampion !== championId) fail('invalid-data', '来源英雄ID与当前请求不一致。');
  const pairIds = new Set();
  const pairs = list(detail.augmentCombinations, '英雄海克斯组合');
  if (pairs.length > 10) fail('invalid-data', '来源公开组合超过前10组，数据格式已变化。');
  for (const pair of pairs) {
    statistics(pair, '海克斯组合');
    const ids = list(pair.augmentIds, '组合ID');
    if (ids.length !== 2) fail('invalid-data', '海克斯组合必须包含两个ID。');
    const a = identifier(ids[0], '海克斯');
    const b = identifier(ids[1], '海克斯');
    if (a === b) fail('invalid-data', '海克斯不能与自身组成组合。');
    unique([a, b].sort((x, y) => x - y).join(':'), pairIds, '海克斯组合');
  }

  object(single, '单海克斯装备');
  const itemAugments = new Set();
  for (const row of list(single.items, '单海克斯装备')) {
    statistics(row, '单海克斯装备');
    unique(identifier(row.augmentId, '海克斯'), itemAugments, '单海克斯装备');
    const ids = new Set();
    for (const item of list(row.all, '装备列表')) {
      statistics(item, '装备');
      unique(identifier(item.id, '装备'), ids, '装备列表');
    }
  }
  const buildAugments = new Set();
  for (const row of list(single.builds, '单海克斯成装')) {
    statistics(row, '单海克斯成装');
    unique(identifier(row.augmentId, '海克斯'), buildAugments, '单海克斯成装');
    const archetypes = new Set();
    for (const archetype of list(row.archetypes, '成装类型')) {
      statistics(archetype, '成装类型');
      if (typeof archetype.key !== 'string' || !archetype.key || archetype.key.length > 100) {
        fail('invalid-data', '成装类型名称无效。');
      }
      unique(archetype.key, archetypes, '成装类型');
      const profiles = new Set();
      for (const profile of list(archetype.profiles, '成装组合')) {
        statistics(profile, '成装组合');
        const ids = itemIds(profile.itemSet, '成装装备');
        if (ids.length !== 3) fail('invalid-data', '成装组合必须包含三个唯一装备ID。');
        unique([...ids].sort((a, b) => a - b).join(':'), profiles, '成装组合');
        const routes = new Set();
        for (const route of list(profile.routes, '出装顺序')) {
          statistics(route, '出装顺序');
          const routeIds = itemIds(route.purchaseOrder, '顺序装备');
          if (routeIds.length !== 3 || routeIds.some(id => !ids.includes(id))) {
            fail('invalid-data', '出装顺序必须与成装组合包含相同的三个唯一装备ID。');
          }
          unique(routeIds.join(':'), routes, '出装顺序');
        }
      }
    }
  }
}

// Shared with the desktop's bounded, local recommendation cache. Exporting the
// existing validator does not change the browser client's request or validation.
export { validatePayload as validateConditionalStatisticsPayload };

function validateManifest(value) {
  object(value, '版本清单', 'invalid-manifest');
  if (!Array.isArray(value.versions)) fail('invalid-manifest', '来源版本清单无效。');
  const versions = new Map();
  for (const entry of value.versions) {
    object(entry, '版本条目', 'invalid-manifest');
    const version = patchName(entry.version, 'invalid-manifest');
    const path = entry.dataPath;
    if (typeof path !== 'string' || !/^data\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(path)
      || path.includes('..') || !(path === `data/${version}` || path.startsWith(`data/${version}-`))) {
      fail('invalid-manifest', '来源数据路径无效，无法安全读取。');
    }
    if (versions.has(version)) fail('invalid-manifest', '来源版本清单有重复版本。');
    if (typeof entry.dataDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.dataDate)
      || !Number.isFinite(Date.parse(`${entry.dataDate}T00:00:00.000Z`))
      || new Date(`${entry.dataDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== entry.dataDate) {
      fail('invalid-manifest', '来源数据日期无效。');
    }
    if (!Number.isSafeInteger(entry.buildTimeUnixMs) || entry.buildTimeUnixMs <= 0) {
      fail('invalid-manifest', '来源构建时间无效。');
    }
    versions.set(version, { version, dataPath: path, dataDate: entry.dataDate, buildTimeUnixMs: entry.buildTimeUnixMs });
  }
  return versions;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createConditionalStatisticsClient({ fetcher = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetcher !== 'function' || typeof now !== 'function') fail('invalid-input', '统计读取器配置无效。');
  let manifestCache = null;
  let manifestPending = null;
  const cache = new Map();
  const pending = new Map();
  const timestamp = () => {
    const time = Number(now());
    if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) fail('invalid-input', '当前时间无效。');
    return time;
  };

  async function requestJson(url, manifest = false) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ConditionalStatisticsError('timeout', '来源数据读取超时，请稍后重试。'));
        }, FETCH_TIMEOUT_MS);
      });
      const request = (async () => {
        const response = await fetcher(url, {
          method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', redirect: 'error',
          signal: controller.signal
        });
        if (!response || !response.ok) fail('fetch-failed', '来源暂时无法读取，请稍后重试。');
        try { return await response.json(); }
        catch (error) {
          throw new ConditionalStatisticsError(manifest ? 'invalid-manifest' : 'invalid-data', '来源返回了无效JSON。', error);
        }
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof ConditionalStatisticsError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new ConditionalStatisticsError('timeout', '来源数据读取超时，请稍后重试。', error);
      }
      throw new ConditionalStatisticsError('fetch-failed', '来源暂时无法读取，请稍后重试。', error);
    } finally { clearTimeout(timer); }
  }

  async function versions() {
    const time = timestamp();
    if (manifestCache && time >= manifestCache.at && time - manifestCache.at < MANIFEST_TTL_MS) return manifestCache.value;
    if (manifestPending) return manifestPending;
    manifestPending = (async () => {
      const value = validateManifest(await requestJson(MANIFEST_URL, true));
      manifestCache = { at: timestamp(), value };
      return value;
    })();
    try { return await manifestPending; }
    finally { manifestPending = null; }
  }

  async function load({ championId, patch } = {}) {
    const id = identifier(championId, '英雄', 'invalid-input');
    const version = patchName(patch);
    const entry = (await versions()).get(version);
    if (!entry) fail('unavailable-version', `来源未提供${version}版本的数据，不能使用其他版本替代。`);
    const key = `${version}:${entry.dataPath}:${id}`;
    if (cache.has(key)) {
      const snapshot = cache.get(key);
      cache.delete(key);
      cache.set(key, snapshot);
      return snapshot;
    }
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const base = `${ORIGIN}/${entry.dataPath}/stats/all/champion-details/${id}`;
      const [detail, single] = await Promise.all([requestJson(`${base}.json`), requestJson(`${base}-single-augments.json`)]);
      validatePayload(id, detail, single);
      const snapshot = deepFreeze({
        meta: {
          sourceName: 'ARAMKit', sourceUrl: 'https://aramkit.com/', patch: version,
          dataDate: entry.dataDate, buildTimeUnixMs: entry.buildTimeUnixMs,
          fetchedAt: new Date(timestamp()).toISOString(), dataPath: entry.dataPath,
          scope: 'all', pairCoverage: 'published-top-10'
        },
        championId: id, detail, single
      });
      cache.set(key, snapshot);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return snapshot;
    })();
    pending.set(key, work);
    try { return await work; }
    finally { pending.delete(key); }
  }
  return Object.freeze({ load });
}

const percent = value => value == null ? null : Number((value * 100).toFixed(8));
const lowSample = value => value != null && value < CONDITIONAL_LOW_SAMPLE_THRESHOLD;
const sampleOrder = (a, b) => (b.sampleCount ?? -1) - (a.sampleCount ?? -1);
function outputStatistics(row) {
  return { sampleCount: nullableCount(row.sampleCount, '统计'), winRate: percent(row.winRate), lowSample: lowSample(row.sampleCount) };
}

export function selectConditionalStatistics(snapshot, { augmentId } = {}) {
  const selectedId = identifier(augmentId, '海克斯', 'invalid-input');
  object(snapshot, '统计快照');
  const championId = identifier(snapshot.championId, '英雄');
  validatePayload(championId, snapshot.detail, snapshot.single);
  const itemSource = snapshot.single.items.find(row => identifier(row.augmentId, '海克斯') === selectedId);
  const buildSource = snapshot.single.builds.find(row => identifier(row.augmentId, '海克斯') === selectedId);
  const items = {
    sampleCount: itemSource ? nullableCount(itemSource.sampleCount, '装备覆盖') : null,
    rows: itemSource ? itemSource.all.map(row => ({ id: identifier(row.id, '装备'), ...outputStatistics(row) })) : []
  };
  const profiles = buildSource ? buildSource.archetypes.flatMap(archetype => archetype.profiles.map(profile => ({
    archetype: archetype.key,
    items: itemIds(profile.itemSet, '成装装备'),
    ...outputStatistics(profile),
    routes: [...profile.routes].sort(sampleOrder).slice(0, 1).map(route => ({
      items: itemIds(route.purchaseOrder, '顺序装备'), ...outputStatistics(route)
    }))
  }))).sort(sampleOrder).slice(0, 3) : [];
  const builds = { sampleCount: buildSource ? nullableCount(buildSource.sampleCount, '成装覆盖') : null, profiles };
  const pairs = snapshot.detail.augmentCombinations.filter(pair => pair.augmentIds.some(id => identifier(id, '海克斯') === selectedId))
    .map(pair => ({
      otherAugmentId: identifier(pair.augmentIds.find(id => identifier(id, '海克斯') !== selectedId), '搭配海克斯'),
      ...outputStatistics(pair)
    })).sort(sampleOrder).slice(0, 3);
  const warnings = [
    '共同海克斯仅覆盖来源公开排名前10的组合，未列出不代表从未共同出现。',
    '装备和成装只按当前英雄与单个海克斯统计，不表示同时选择共同海克斯后的出装；各表样本范围不同。'
  ];
  if (!itemSource) warnings.push('来源没有当前英雄与这个海克斯的装备样本。');
  if (!buildSource) warnings.push('来源没有当前英雄与这个海克斯的成装样本。');
  if (!pairs.length) warnings.push('公开组合中没有当前海克斯的共同样本，无法判断最常见搭配。');
  const rows = [...items.rows, ...profiles, ...profiles.flatMap(profile => profile.routes), ...pairs];
  if (rows.some(row => row.lowSample)) warnings.push('样本少于200的记录已标记；这是本地提醒，记录仍保留。');
  if (rows.some(row => row.sampleCount == null || row.winRate == null)) warnings.push('部分样本数或胜率未知，显示为未知，不按0计算。');
  return { augmentId: selectedId, items, builds, pairs, warnings };
}

import {open, lstat, mkdir, rename, writeFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createConditionalStatisticsClient, validateConditionalStatisticsPayload} from '../dist/conditional-statistics.js';

const require = createRequire(import.meta.url);
const CHAMPION_KEYS = require('./resources/champions-16.21.1.json').champions;
export const RECOMMENDATION_CACHE_LIMITS = Object.freeze({
  champions:3, ttlMs:24 * 60 * 60 * 1000, snapshotBytes:4 * 1024 * 1024,
  fileBytes:13 * 1024 * 1024, retryMs:60000, maxRetryMs:15 * 60000
});
const LIMITS = RECOMMENDATION_CACHE_LIMITS;
const WEIGHTS = Object.freeze({mayhem:0.8, aram:0.2});
const FILE_NAME = 'recommendation-cache-v1.json';
const SOURCE_URL = 'https://aramkit.com/';
const PATCH = /^\d{1,3}\.\d{1,3}[a-z]?$/;
const SLUG = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const error = () => {
  const failure = new TypeError('Invalid recommendation aggregate.');
  failure.code = 'invalid-data';
  throw failure;
};
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : error();
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max ? value : error();
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : error();
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : error();
const array = (value, max) => Array.isArray(value) && value.length <= max ? value : error();
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const boundedJson = (value, max) => {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) > max) error();
  return json;
};
function metrics(value) {
  record(value);
  const result = {};
  for (const key of ['sampleCount', 'rank']) if (key in value) result[key] = value[key] == null ? null : integer(value[key]);
  for (const key of ['winRate', 'pickRate', 'routeCoverageRate', 'blueWinRate', 'redWinRate', 'augmentWinRate']) {
    if (key in value) result[key] = value[key] == null ? null : rate(value[key]);
  }
  return result;
}
const item = (value, allowZero = false) => ({id:integer(record(value).id, allowZero ? 0 : 1)});
function itemRow(value) { return {id:integer(record(value).id, 1), ...metrics(value)}; }
function itemGroup(value) {
  const result = {...metrics(value), all:array(value.all, 512).map(itemRow)};
  if ('slots' in value) {
    record(value.slots);
    if (Object.keys(value.slots).some(key => !/^[1-6]$/.test(key))) error();
    result.slots = Object.fromEntries(Object.entries(value.slots).map(([key, rows]) => [key, array(rows, 512).map(itemRow)]));
  }
  return result;
}
function route(value) {
  const result = {...metrics(value), purchaseOrder:array(value.purchaseOrder, 3).map(row => item(row))};
  if ('starters' in value) result.starters = array(value.starters, 64).map(row => ({
    ...metrics(row), items:array(row.items, 12).map(entry => item(entry))
  }));
  for (const [key, kind] of [['boots', 'boots'], ['laterItems', 'later']]) {
    if (key in value) result[key] = array(value[key], 128).map(row => {
      if (row.kind !== kind) error();
      return {...metrics(row), item:item(row.item, kind === 'boots'), kind};
    });
  }
  return result;
}
function buildGroup(value) {
  return {...metrics(value), archetypes:array(value.archetypes, 64).map(archetype => {
    record(archetype);
    if (typeof archetype.key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(archetype.key)) error();
    return {key:archetype.key, ...metrics(archetype), profiles:array(archetype.profiles, 128).map(profile => ({
      ...metrics(profile), itemSet:array(profile.itemSet, 3).map(row => item(row)),
      routes:array(profile.routes, 12).map(route)
    }))};
  })};
}
function augmentRow(value) {
  const result = {id:integer(record(value).id, 1), ...metrics(value)};
  for (const key of ['tier', 'augmentTier']) {
    if (key in value) {
      if (typeof value[key] !== 'string' || !/^[A-Za-z+-]{1,8}$/.test(value[key])) error();
      result[key] = value[key];
    }
  }
  if ('augmentRank' in value) result.augmentRank = integer(value.augmentRank);
  if ('stageAgnostic' in value) {
    if (typeof value.stageAgnostic !== 'boolean') error();
    result.stageAgnostic = value.stageAgnostic;
  }
  if ('availableStages' in value) result.availableStages = array(value.availableStages, 4).map(stage => integer(stage, 1, 4));
  return result;
}
function augmentRows(value) {
  const rows = array(value, 1024).map(augmentRow);
  if (new Set(rows.map(row => row.id)).size !== rows.length) error();
  return rows;
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) error();
  return value;
}

/** Retains the provider's raw aggregate shape, never arbitrary text or identities. */
export function validateRecommendationSnapshot(value, {championId, patch, now = Date.now()} = {}) {
  // Parse a bounded copy before examining fields, so caller mutation cannot race
  // validation or later change an accepted in-memory/persisted snapshot.
  const raw = JSON.parse(boundedJson(value, LIMITS.snapshotBytes));
  record(raw); record(raw.meta); record(raw.detail); record(raw.single);
  if (integer(raw.championId, 1) !== championId || raw.meta.patch !== patch
    || raw.meta.sourceName !== 'ARAMKit' || raw.meta.sourceUrl !== SOURCE_URL
    || raw.meta.scope !== 'all' || raw.meta.pairCoverage !== 'published-top-10') error();
  const dataPath = raw.meta.dataPath;
  if (typeof dataPath !== 'string' || !/^data\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(dataPath)
    || dataPath.includes('..') || !(dataPath === `data/${patch}` || dataPath.startsWith(`data/${patch}-`))) error();
  const buildTimeUnixMs = integer(raw.meta.buildTimeUnixMs, 1, now + 5 * 60000);
  const fetchedAt = raw.meta.fetchedAt;
  if (typeof fetchedAt !== 'string' || fetchedAt.length > 40 || !Number.isFinite(Date.parse(fetchedAt)) || Date.parse(fetchedAt) > now + 5 * 60000) error();
  const detail = {champion:{id:integer(record(raw.detail.champion).id, 1)},
    augmentCombinations:array(raw.detail.augmentCombinations, 10).map(row => ({
      ...metrics(row), augmentIds:array(row.augmentIds, 2).map(id => integer(id, 1))
    }))};
  if (detail.champion.id !== championId) error();
  if ('stats' in raw.detail.champion) {
    const source = record(raw.detail.champion.stats);
    detail.champion.stats = metrics(source);
    for (const key of ['kda','kills','deaths','assists','damageToChampions','physicalDamageToChampions',
      'magicDamageToChampions','trueDamageToChampions','damageDealtToTurrets','damageTaken',
      'damageSelfMitigated','healsOnTeammates','damageShieldedOnTeammates','timeCcingOthers',
      'goldEarned','cs','killParticipation','damageShare','gameDuration','multikills','damageGoldEfficiency']) {
      if (key in source) detail.champion.stats[key] = source[key] == null ? null : finite(source[key]);
    }
  }
  for (const [key, project] of [['items', itemGroup], ['builds', buildGroup]]) {
    if (key in raw.detail) {
      record(raw.detail[key]);
      detail[key] = {};
      for (const scope of ['filtered', 'unfiltered']) if (scope in raw.detail[key]) detail[key][scope] = project(raw.detail[key][scope]);
    }
  }
  if ('augments' in raw.detail) {
    const augments = record(raw.detail.augments);
    detail.augments = {all:augmentRows(augments.all)};
    if ('stages' in augments) {
      record(augments.stages);
      if (Object.keys(augments.stages).some(key => !/^[1-4]$/.test(key))) error();
      detail.augments.stages = Object.fromEntries(Object.entries(augments.stages).map(([stage, rows]) => [stage, augmentRows(rows)]));
    }
  }
  const single = {
    items:array(raw.single.items, 1024).map(row => ({augmentId:integer(row.augmentId, 1), ...itemGroup(row)})),
    builds:array(raw.single.builds, 1024).map(row => ({augmentId:integer(row.augmentId, 1), ...buildGroup(row)}))
  };
  validateConditionalStatisticsPayload(championId, detail, single);
  // The shared conditional validator also checks generic profile/set invariants.
  for (const scope of ['filtered', 'unfiltered']) {
    if (detail.items?.[scope] || detail.builds?.[scope]) validateConditionalStatisticsPayload(championId, detail, {
      items:detail.items?.[scope] ? [{augmentId:1, ...detail.items[scope]}] : [],
      builds:detail.builds?.[scope] ? [{augmentId:1, ...detail.builds[scope]}] : []
    });
  }
  return freeze({championId, meta:{sourceName:'ARAMKit', sourceUrl:SOURCE_URL, patch,
    dataDate:date(raw.meta.dataDate), buildTimeUnixMs, fetchedAt, dataPath,
    scope:'all', pairCoverage:'published-top-10'}, detail, single});
}

/** A reference mode never masquerades as Mayhem or as the other fallback mode. */
export function validateReferenceBuildSnapshot(value, {championId, patch, now = Date.now()} = {}) {
  const raw = JSON.parse(boundedJson(value, 256 * 1024));
  record(raw);
  if (raw.championId !== championId || raw.patch !== patch || raw.source !== 'OP.GG' || raw.comparable !== true
    || !['aram', 'summoners-rift'].includes(raw.mode)) error();
  if (typeof raw.sourceUrl !== 'string' || raw.sourceUrl.length > 256) error();
  const url = new URL(raw.sourceUrl);
  const expectedPath = raw.mode === 'aram'
    ? `/lol/modes/aram/${championId.toLowerCase()}/` : `/lol/champions/${championId.toLowerCase()}/`;
  if (url.protocol !== 'https:' || !['op.gg','www.op.gg'].includes(url.hostname) || url.port || url.username || url.password || url.hash
    || !['items','build'].some(suffix => url.pathname === expectedPath + suffix)
    || [...url.searchParams].some(([key, entry]) => key === 'patch' ? entry !== patch
      : key !== 'type' || raw.mode !== 'summoners-rift' || entry !== 'ranked')) error();
  const observed = typeof raw.observedAt === 'number' ? integer(raw.observedAt, 1) : typeof raw.observedAt === 'string' && raw.observedAt.length <= 40 ? Date.parse(raw.observedAt) : NaN;
  if (!Number.isFinite(observed) || observed <= 0 || observed > now + 5 * 60000) error();
  const seen = new Set();
  const items = array(raw.items, 512).map(row => {
    record(row);
    if (!['single-item','boots'].includes(row.scope)) error();
    const id = integer(row.id, 1);
    const key = `${id}:${row.scope}`;
    if (seen.has(key)) error();
    seen.add(key);
    return {id, winRate:rate(row.winRate), sampleCount:integer(row.sampleCount, 1), scope:row.scope,
      ...('pickRate' in row && row.pickRate != null ? {pickRate:rate(row.pickRate)} : {})};
  });
  if (!items.length) error();
  const cohort = {};
  if ('sourceChampionId' in raw) {
    const expected = CHAMPION_KEYS.find(row => row.id === championId)?.key;
    if (integer(raw.sourceChampionId, 1) !== expected) error();
    cohort.sourceChampionId = raw.sourceChampionId;
  }
  for (const key of ['region', 'tier', 'position']) if (key in raw) {
    if (raw[key] !== null && (typeof raw[key] !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(raw[key]))) error();
    cohort[key] = raw[key];
  }
  return freeze({mode:raw.mode, championId, patch, comparable:true, source:'OP.GG', sourceUrl:url.href,
    observedAt:new Date(observed).toISOString(), ...cohort, items});
}

function localStatistics(snapshot, championIds, augmentCatalog, patch) {
  const result = new Map();
  const meta = snapshot?.meta;
  if (snapshot?.schemaVersion !== 1 || meta?.mode !== 'aram-mayhem' || meta?.patch !== patch
    || typeof meta.cohortId !== 'string' || !meta.cohortId || meta.source?.name !== 'AramHex'
    || meta.source?.url !== 'https://github.com/czgreat/aramhex-data' || !Array.isArray(snapshot.champions)) return result;
  const seen = new Set();
  for (const hero of snapshot.champions) {
    const id = hero?.championId;
    if (!championIds.has(id)) continue;
    if (seen.has(id)) { result.delete(id); continue; }
    seen.add(id);
    if (Number(hero.sourceChampionId) !== championIds.get(id) || hero.cohortId !== meta.cohortId || !Number.isSafeInteger(hero.games) || hero.games < 1
      || !Number.isSafeInteger(hero.wins) || hero.wins < 0 || hero.wins > hero.games || !Array.isArray(hero.augments)) continue;
    const stats = Object.create(null);
    const duplicates = new Set();
    for (const row of hero.augments) {
      const augment = augmentCatalog.get(row?.augmentId);
      if (!augment || row.provisional !== false || row.cohortId !== meta.cohortId
        || Object.hasOwn(meta.excludedAugments ?? {}, String(row.sourceAugmentId))
        || augment.gameDataId != null && Number(row.sourceAugmentId) !== Number(augment.gameDataId)
        || !Number.isSafeInteger(row.games) || row.games < 1 || row.games > hero.games
        || !Number.isSafeInteger(row.wins) || row.wins < 0 || row.wins > row.games || row.wins > hero.wins
        || row.games - row.wins > hero.games - hero.wins) continue;
      if (duplicates.has(row.augmentId)) { delete stats[row.augmentId]; continue; }
      duplicates.add(row.augmentId);
      stats[row.augmentId] = {winRate:row.wins / row.games, sampleCount:row.games,
        comparable:row.games >= Math.max(3000, Number.isSafeInteger(meta.lowSampleThreshold) ? meta.lowSampleThreshold : 3000) && row.lowSample === false,
        patch, source:'AramHex', pickRate:null};
    }
    result.set(id, freeze(stats));
  }
  return result;
}

async function boundedFetch(url, options) {
  const response = await globalThis.fetch(url, options);
  if (!response.ok) return response;
  const header = response.headers?.get?.('content-length');
  if (header && /^\d+$/.test(header) && Number(header) > LIMITS.snapshotBytes) { await response.body?.cancel?.(); error(); }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > LIMITS.snapshotBytes) error();
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return {ok:true, json:async () => value};
}

/** No background refresh: only ensure(currentChampion) can make a request. */
export class RecommendationRepository {
  #entries = new Map(); #failures = new Map(); #referenceFailures = new Map(); #pending = new Map(); #static;
  #mayhemPending = new Set(); #referencePending = new Set();
  #ids = new Map(); #numbers = new Map(); #loadPromise; #writeTail = Promise.resolve();
  #client; #referenceClient; #now; #patch; #file; #closed = false; #storageStatus;
  constructor({dataDirectory, statisticsSnapshot, champions = [], augments = [], client, referenceClient, now = Date.now, patch = '16.21'} = {}) {
    if (typeof patch !== 'string' || !PATCH.test(patch) || typeof now !== 'function' || client != null && typeof client.load !== 'function'
      || referenceClient != null && typeof referenceClient.load !== 'function'
      || dataDirectory != null && (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory))) throw new TypeError('Invalid recommendation repository configuration.');
    this.#client = client; this.#referenceClient = referenceClient; this.#now = now; this.#patch = patch;
    this.#file = dataDirectory ? path.join(dataDirectory, FILE_NAME) : null;
    this.#storageStatus = this.#file ? 'not-loaded' : 'memory-only';
    const known = new Map(CHAMPION_KEYS.map(row => [row.id, row.key]));
    for (const champion of champions) {
      if (!SLUG.test(champion?.id) || !known.has(champion.id)) continue;
      const numeric = known.get(champion.id);
      if (champion.key != null && Number(champion.key) !== numeric) continue;
      this.#ids.set(champion.id, numeric); this.#numbers.set(String(numeric), champion.id);
    }
    const catalog = new Map(augments.filter(row => SLUG.test(row?.id) && row.recommendable !== false
      && !row.isInternalTemplate && !row.retiredPatch && (!row.availability || row.availability === 'current')).map(row => [row.id, row]));
    this.#static = localStatistics(statisticsSnapshot, this.#ids, catalog, patch);
  }
  #time() { return integer(this.#now(), 1); }
  #resolve(value) { return typeof value === 'string' && this.#ids.has(value) ? value : this.#numbers.get(String(value)) ?? null; }
  #touch(map, id, value) {
    map.delete(id); map.set(id, value);
    while (map.size > LIMITS.champions) map.delete(map.keys().next().value);
  }
  async load() {
    if (!this.#loadPromise) this.#loadPromise = this.#read();
    await this.#loadPromise;
    return this;
  }
  async #read() {
    if (!this.#file) return;
    let handle;
    try {
      const info = await lstat(this.#file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > LIMITS.fileBytes) error();
      handle = await open(this.#file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > LIMITS.fileBytes) error();
      // Bounded reads even if another process grows the file after stat().
      const buffer = Buffer.alloc(stat.size + 1);
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) error();
      const saved = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (saved?.schemaVersion !== 1 || saved.patch !== this.#patch) error();
      const entries = array(saved.entries, LIMITS.champions);
      const accepted = new Map();
      const time = this.#time();
      for (const row of entries) {
        if (!this.#ids.has(row.championId) || accepted.has(row.championId)) error();
        const snapshot = row.snapshot == null ? null : validateRecommendationSnapshot(row.snapshot, {championId:this.#ids.get(row.championId), patch:this.#patch, now:time});
        const storedAt = snapshot ? integer(row.storedAt, 1, time + 5 * 60000) : null;
        const reference = row.reference == null ? null : validateReferenceBuildSnapshot(row.reference, {championId:row.championId, patch:this.#patch, now:time});
        const referenceStoredAt = reference ? integer(row.referenceStoredAt, 1, time + 5 * 60000) : null;
        if (!snapshot && !reference) error();
        accepted.set(row.championId, {storedAt, snapshot, reference, referenceStoredAt});
      }
      this.#entries = accepted;
      this.#storageStatus = 'ready';
    } catch (failure) { this.#storageStatus = failure?.code === 'ENOENT' ? 'ready' : 'invalid-cache'; }
    finally { await handle?.close().catch(() => {}); }
  }
  get(championId) {
    const id = this.#resolve(championId);
    const time = this.#time();
    const entry = id && this.#entries.get(id);
    if (entry) this.#touch(this.#entries, id, entry);
    const failure = id && this.#failures.get(id);
    const referenceFailure = id && this.#referenceFailures.get(id);
    const fresh = this.#fresh(entry?.snapshot, entry?.storedAt, time);
    const referenceFresh = this.#fresh(entry?.reference, entry?.referenceStoredAt, time, true);
    const mayhemStatus = !id ? 'unknown-champion' : fresh ? 'ready' : this.#mayhemPending.has(id) ? 'loading' : entry?.snapshot ? 'stale' : failure ? 'error' : 'missing';
    const referenceStatus = !id ? 'unknown-champion' : referenceFresh ? 'ready' : this.#referencePending.has(id) ? 'loading' : entry?.reference ? 'stale' : referenceFailure ? 'error' : 'missing';
    const status = !id ? 'unknown-champion' : fresh || referenceFresh ? 'ready' : this.#pending.has(id) ? 'loading'
      : entry?.snapshot || entry?.reference ? 'stale' : failure || referenceFailure ? 'error' : 'missing';
    return freeze({status, championId:id, sourceChampionId:id ? this.#ids.get(id) : null, patch:this.#patch, snapshot:entry?.snapshot ?? null,
      augmentStatistics:this.#static.get(id) ?? freeze({}),
      ordinaryAram:entry?.reference?.mode === 'aram' ? entry.reference : null,
      summonersRift:entry?.reference?.mode === 'summoners-rift' ? entry.reference : null,
      configuredWeights:WEIGHTS, mayhemStatus, referenceStatus,
      storageStatus:this.#storageStatus, ...(failure ? {errorCode:failure.code, retryAt:failure.retryAt} : {}),
      ...(referenceFailure ? {referenceErrorCode:referenceFailure.code, referenceRetryAt:referenceFailure.retryAt} : {})});
  }
  #fresh(snapshot, storedAt, time, reference = false) {
    if (!snapshot) return false;
    const at = Math.min(storedAt, Date.parse(reference ? snapshot.observedAt : snapshot.meta.fetchedAt));
    return time >= at && time - at < LIMITS.ttlMs;
  }
  async ensure(championId) {
    await this.load();
    const id = this.#resolve(championId);
    if (!id || this.#closed) return this.get(championId);
    if (this.#pending.has(id)) return this.#pending.get(id);
    const current = this.get(id);
    const time = this.#time();
    const mayhem = current.mayhemStatus !== 'ready' && time >= (this.#failures.get(id)?.retryAt ?? 0);
    const reference = current.referenceStatus !== 'ready' && time >= (this.#referenceFailures.get(id)?.retryAt ?? 0);
    if (!mayhem && !reference) return current;
    if (this.#pending.size >= LIMITS.champions) return freeze({...current, errorCode:'busy'});
    const jobs = [];
    if (mayhem) { this.#mayhemPending.add(id); jobs.push(this.#refresh(id)); }
    if (reference) { this.#referencePending.add(id); jobs.push(this.#refreshReference(id)); }
    const work = Promise.allSettled(jobs).then(() => { this.#pending.delete(id); return this.get(id); });
    this.#pending.set(id, work);
    try { return await work; }
    finally { this.#pending.delete(id); }
  }
  async #refresh(id) {
    try {
      // Recreate the default client's memory cache after our 24-hour TTL;
      // otherwise its champion LRU would keep returning the same stale object.
      const client = this.#client ?? createConditionalStatisticsClient({fetcher:boundedFetch, now:this.#now});
      const raw = await client.load({championId:this.#ids.get(id), patch:this.#patch});
      const time = this.#time();
      const snapshot = validateRecommendationSnapshot(raw, {championId:this.#ids.get(id), patch:this.#patch, now:time});
      // A reused provider client may itself serve an old in-memory snapshot.
      // Reading it again is not a new fetch and must not reset the 24-hour TTL.
      if (time - Date.parse(snapshot.meta.fetchedAt) >= LIMITS.ttlMs) error();
      this.#touch(this.#entries, id, {...this.#entries.get(id), storedAt:time, snapshot});
      this.#failures.delete(id);
      this.#persist();
    } catch (failure) {
      this.#failed(this.#failures, id, failure);
    }
    this.#mayhemPending.delete(id);
    return this.get(id);
  }
  #failed(map, id, failure) {
    const attempts = Math.min(8, (map.get(id)?.attempts ?? 0) + 1);
    const code = ['timeout','fetch-failed','invalid-data','invalid-manifest','unavailable-version','unavailable'].includes(failure?.code) ? failure.code : 'fetch-failed';
    this.#touch(map, id, {attempts, code, retryAt:this.#time() + Math.min(LIMITS.maxRetryMs, LIMITS.retryMs * 2 ** (attempts - 1))});
  }
  async #refreshReference(id) {
    try {
      // Loading this module is deferred too: load()/get() never start network
      // work, and Mayhem stays usable independently of the reference provider.
      const client = this.#referenceClient ?? (await import('./reference-build-source.mjs')).createReferenceBuildSource({now:this.#now});
      const raw = await client.load({championId:id, championSlug:id.toLowerCase(), patch:this.#patch});
      if (raw == null) throw Object.assign(new Error('Reference data unavailable.'), {code:'unavailable'});
      const time = this.#time();
      const reference = validateReferenceBuildSnapshot(raw, {championId:id, patch:this.#patch, now:time});
      if (time - Date.parse(reference.observedAt) >= LIMITS.ttlMs) error();
      this.#touch(this.#entries, id, {...this.#entries.get(id), referenceStoredAt:time, reference});
      this.#referenceFailures.delete(id);
      this.#persist();
    } catch (failure) { this.#failed(this.#referenceFailures, id, failure); }
    this.#referencePending.delete(id);
    return this.get(id);
  }
  #persist() {
    if (!this.#file) return;
    this.#writeTail = this.#writeTail.catch(() => {}).then(async () => {
      const payload = boundedJson({schemaVersion:1, patch:this.#patch,
        entries:[...this.#entries].map(([championId, entry]) => ({championId, ...entry}))}, LIMITS.fileBytes - 1);
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(this.#file), {recursive:true});
        await writeFile(temporary, payload + '\n', {encoding:'utf8', mode:0o600, flag:'wx'});
        await rename(temporary, this.#file);
        this.#storageStatus = 'ready';
      } catch (failure) {
        this.#storageStatus = 'write-failed';
        await unlink(temporary).catch(() => {});
        throw failure;
      }
    });
    this.#writeTail.catch(() => {});
  }
  async close() {
    this.#closed = true;
    await this.#loadPromise;
    await Promise.allSettled([...this.#pending.values()]);
    await this.#writeTail.catch(() => {});
  }
}

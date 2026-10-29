import {open, lstat, mkdir, rename, writeFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fetchLatestStatistics} from './statistics-source.mjs';

export const STATISTICS_REFRESH_INTERVAL = 3 * 24 * 60 * 60 * 1000;
const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const SNAPSHOT_FILE = 'statistics-snapshot-v1.json';
const STATE_FILE = 'statistics-refresh-v1.json';
const validCount = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const invalid = () => { throw new TypeError('Invalid stored statistics.'); };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// Cache files are optional input, not authority to bypass the import contract.
// Check every mapped row before a cached snapshot can replace the bundled one.
export function validateStoredStatistics(snapshot, {gameData, championCatalog, now = Date.now()} = {}) {
  const meta = snapshot?.meta;
  const patch = gameData?.meta?.clientDataVersion;
  if (snapshot?.schemaVersion !== 1 || meta?.mode !== 'aram-mayhem' || meta.patch !== patch
    || meta.rulesPatch !== gameData.meta.patch || meta.source?.name !== 'AramHex'
    || meta.source.url !== 'https://github.com/czgreat/aramhex-data' || meta.source.license !== 'CC BY-NC 4.0'
    || !/^[a-f0-9]{40}$/.test(meta.source.commit) || !validCount(meta.validGames, 1)
    || !timestamp(meta.statsUpdatedAt) || !timestamp(meta.observedFrom) || !timestamp(meta.observedTo)
    || Date.parse(meta.statsUpdatedAt) > now + 5 * 60000
    || Date.parse(meta.observedFrom) >= Date.parse(meta.observedTo)
    || Date.parse(meta.observedTo) > Date.parse(meta.statsUpdatedAt)
    || meta.cohortId !== `aramhex-cn-${patch}-normal-all-${meta.statsUpdatedAt}`
    || meta.rank !== '全分段' || !Array.isArray(snapshot.champions) || !snapshot.champions.length
    || snapshot.champions.length > gameData.champions.length) invalid();
  const champions = new Map(championCatalog.champions.map(row => [row.id, String(row.key)]));
  const augments = new Map(gameData.augments.filter(row => row.gameDataId != null).map(row => [row.id, String(row.gameDataId)]));
  const seen = new Set();
  let games = 0, wins = 0, rows = 0, mapped = 0, provisional = 0;
  const check = row => {
    if (!validCount(row.games, 1) || !validCount(row.wins) || row.wins > row.games
      || typeof row.winRate !== 'number' || !Number.isFinite(row.winRate)
      || Math.abs(row.winRate - row.wins / row.games * 100) > 0.000051) invalid();
  };
  for (const hero of snapshot.champions) {
    if (seen.has(hero.championId) || champions.get(hero.championId) !== hero.sourceChampionId
      || hero.cohortId !== meta.cohortId || !Array.isArray(hero.augments) || hero.augments.length > 1024) invalid();
    seen.add(hero.championId); check(hero); games += hero.games; wins += hero.wins;
    const ids = new Set();
    for (const row of hero.augments) {
      if (!/^[1-9]\d*$/.test(row.sourceAugmentId) || ids.has(row.sourceAugmentId)
        || row.augmentId !== null && augments.get(row.augmentId) !== row.sourceAugmentId
        || Object.hasOwn(meta.excludedAugments ?? {}, row.sourceAugmentId)
        || typeof row.provisional !== 'boolean' || row.lowSample !== (row.games < 3000)
        || !Array.isArray(row.builds) || row.builds.length) invalid();
      ids.add(row.sourceAugmentId); check(row); rows++; if (row.augmentId !== null) mapped++;
      if (row.provisional) {
        if (row.cohortId !== 'aramhex-pbe-16.21.828') invalid();
        provisional++;
      } else if (row.cohortId !== meta.cohortId || row.games > hero.games || row.wins > hero.wins
        || row.games - row.wins > hero.games - hero.wins) invalid();
    }
  }
  if (games !== meta.validGames * 10 || wins !== meta.validGames * 5
    || meta.coverage?.championsWithStats !== seen.size || meta.coverage.augmentRows !== rows
    || meta.coverage.mappedAugmentRows !== mapped || meta.coverage.provisionalRows !== provisional) invalid();
  return snapshot;
}

async function readBounded(file, limit) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) invalid();
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) invalid();
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), {recursive:true});
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', {flag:'wx'});
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** App-owned schedule: no Windows task, browser, or Codex chat is required. */
export class StatisticsUpdater {
  #snapshot; #revision; #state = {lastCheckedAt:0, nextCheckAt:0, failures:0, error:null};
  #options; #directory; #now; #onUpdate; #refresh; #pending; #timer; #closed = false; #controller;
  constructor({dataDirectory, bundledSnapshot, gameData, championCatalog, now = Date.now,
    onUpdate = () => {}, refresh = fetchLatestStatistics} = {}) {
    if (dataDirectory != null && (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory))) throw new TypeError('Invalid statistics data directory.');
    this.#directory = dataDirectory;
    this.#now = now; this.#onUpdate = onUpdate; this.#refresh = refresh;
    this.#options = {gameData, championCatalog};
    this.#accept(validateStoredStatistics(bundledSnapshot, {...this.#options, now:now()}));
  }
  #accept(snapshot) {
    this.#snapshot = freeze(snapshot);
    this.#revision = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  }
  async load() {
    if (!this.#directory) return this;
    try {
      const snapshot = validateStoredStatistics(await readBounded(path.join(this.#directory, SNAPSHOT_FILE), SNAPSHOT_LIMIT), {...this.#options, now:this.#now()});
      if (Date.parse(snapshot.meta.statsUpdatedAt) >= Date.parse(this.#snapshot.meta.statsUpdatedAt)) this.#accept(snapshot);
    } catch { /* Missing, corrupt, incompatible, or older caches keep the bundled data. */ }
    try {
      const state = await readBounded(path.join(this.#directory, STATE_FILE), 4096);
      const time = this.#now();
      if (state.schemaVersion !== 1 || state.patch !== this.#snapshot.meta.patch || state.revision !== this.#revision
        || !validCount(state.lastCheckedAt) || state.lastCheckedAt > time
        || !validCount(state.nextCheckAt) || state.nextCheckAt > time + STATISTICS_REFRESH_INTERVAL
        || !validCount(state.failures) || state.failures > 8
        || state.error !== null && state.error !== 'update-unavailable') invalid();
      this.#state = {lastCheckedAt:state.lastCheckedAt, nextCheckAt:state.nextCheckAt, failures:state.failures, error:state.error};
    } catch { /* Invalid schedule state means one bounded check at next startup. */ }
    return this;
  }
  getSnapshot() { return this.#snapshot; }
  getStatus() {
    return {revision:this.#revision, patch:this.#snapshot.meta.patch, statsUpdatedAt:this.#snapshot.meta.statsUpdatedAt,
      intervalDays:3, lastCheckedAt:this.#state.lastCheckedAt || null, nextCheckAt:this.#state.nextCheckAt || null,
      updating:Boolean(this.#pending), error:this.#state.error};
  }
  async #saveState() {
    if (this.#directory) await atomicJson(path.join(this.#directory, STATE_FILE), {schemaVersion:1, patch:this.#snapshot.meta.patch, revision:this.#revision, ...this.#state});
  }
  check({force = false} = {}) {
    if (this.#closed) return Promise.resolve(this.getStatus());
    if (this.#pending) return this.#pending;
    if (!force && this.#now() < this.#state.nextCheckAt) return Promise.resolve(this.getStatus());
    this.#controller = new AbortController();
    this.#pending = this.#update(this.#controller.signal).finally(() => { this.#pending = null; this.#controller = null; });
    return this.#pending;
  }
  async #update(signal) {
    try {
      const snapshot = await this.#refresh({...this.#options, currentSnapshot:this.#snapshot, signal});
      if (this.#closed) return this.getStatus();
      if (snapshot) {
        validateStoredStatistics(snapshot, {...this.#options, now:this.#now()});
        if (Date.parse(snapshot.meta.statsUpdatedAt) < Date.parse(this.#snapshot.meta.statsUpdatedAt)) invalid();
        if (Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_LIMIT) invalid();
        if (this.#directory) await atomicJson(path.join(this.#directory, SNAPSHOT_FILE), snapshot);
        if (this.#closed) return this.getStatus();
        this.#onUpdate(snapshot);
        this.#accept(snapshot);
      }
      const time = this.#now();
      this.#state = {lastCheckedAt:time, nextCheckAt:time + STATISTICS_REFRESH_INTERVAL, failures:0, error:null};
      await this.#saveState();
    } catch {
      if (!this.#closed) {
        const failures = Math.min(8, this.#state.failures + 1);
        this.#state = {...this.#state, failures, error:'update-unavailable', nextCheckAt:this.#now() + Math.min(6, 2 ** (failures - 1)) * 60 * 60 * 1000};
        await this.#saveState().catch(() => {});
      }
    }
    return this.getStatus();
  }
  start() {
    if (this.#timer || this.#closed) return;
    void this.check();
    this.#timer = setInterval(() => { void this.check(); }, 15 * 60000);
    this.#timer.unref?.();
  }
  async close() {
    this.#closed = true;
    clearInterval(this.#timer); this.#timer = null;
    this.#controller?.abort();
    await this.#pending;
  }
}

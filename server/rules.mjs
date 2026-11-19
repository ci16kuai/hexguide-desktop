import {createHash, randomUUID} from 'node:crypto';
import {readFile, stat, writeFile, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {comparePatches} from '../dist/version.js';

const feed = 'https://raw.githubusercontent.com/ci16kuai/hexguide-desktop/codex/announcements-feed/rules/';
const byteLimit = 4 * 1024 * 1024;
const manifestLimit = 4096;
const rulesCacheFile = 'rules-v1.json';
const checkIntervalMs = 60 * 1000;
const officialNoticeUrl = /^https:\/\/lol\.qq\.com\/(?:gicp\/news\/\d+\/\d+\.html|news\/detail\.shtml\?docid=\d+)$/;
const riotPatchNotesUrl = /^https:\/\/www\.leagueoflegends\.com\/[a-z]{2}-[a-z]{2}\/news\/game-updates\/(?:league-of-legends-)?patch-\d+-\d+-notes\/?$/;
const sha256 = body => createHash('sha256').update(body).digest('hex');

function validateManifest(value) {
  if (value?.schemaVersion !== 1 || typeof value.clientPatch !== 'string'
      || !Number.isFinite(comparePatches(value.clientPatch, value.clientPatch))
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw Error('Invalid rules manifest.');
  return value;
}

function displayPatch(clientPatch) {
  const [major, minor] = clientPatch.split('.');
  return (Number(major) + 10) + '.' + minor;
}

export function applyRules(catalog, manifest, bytes, {knownAugments = catalog.augments} = {}) {
  validateManifest(manifest);
  if (bytes.length > byteLimit || sha256(bytes) !== manifest.sha256) throw Error('Invalid rules digest.');
  const pack = JSON.parse(bytes), patch = manifest.clientPatch;
  if (pack.schemaVersion !== 1 || pack.clientPatch !== patch || !Array.isArray(pack.augments)
      || pack.augments.length < 100 || pack.augments.length > 1024) throw Error('Incomplete rules pack.');
  const official = pack.officialAnnouncement;
  if (official !== undefined && (typeof official?.version !== 'string' || typeof official.url !== 'string'
      || !/^(?:\d+\.){2}(?:0|[1-9]\d*)$/.test(official.version) || official.version.split('.').slice(0, 2).join('.') !== patch
      || !officialNoticeUrl.test(official.url) || official.url !== official.url.trim())) throw Error('Invalid official rules announcement.');
  const rulesPatch = displayPatch(patch);
  if (comparePatches(rulesPatch, catalog.meta.augmentPatch) < 0) throw Error('Older rules pack.');
  const base = 'https://raw.communitydragon.org/' + patch + '/game/';
  const sourceLabel = manifest.origin==='installed-riot-client' ? '本机英雄联盟客户端 ' + patch : 'CommunityDragon ' + patch;
  const priorById = new Map(), priorByKey = new Map();
  for (const augment of knownAugments) {
    if (augment.gameDataId == null) continue;
    priorById.set(augment.gameDataId, augment);
    if (augment.sourceGameId) priorByKey.set(augment.sourceGameId.toLowerCase(), augment.gameDataId);
  }
  const ids = new Set(), keys = new Set(), localIds = new Set();
  const augments = pack.augments.map(row => {
    const {gameDataId, sourceGameId, sourcePath, name, enName, rarity, description, iconPath, unresolvedValues} = row;
    const sourceKey = typeof sourceGameId === 'string' ? sourceGameId.toLowerCase() : '';
    const internal = sourceGameId === 'GoH_PentakillAug_Generic';
    if (!Number.isSafeInteger(gameDataId) || gameDataId <= 0 || ids.has(gameDataId)
        || typeof sourceGameId !== 'string' || !/^[A-Za-z0-9_]+$/.test(sourceGameId) || keys.has(sourceKey)
        || typeof sourcePath !== 'string' || sourcePath.split('/').at(-1)?.toLowerCase() !== sourceKey
        || typeof name !== 'string' || (!internal && !name.trim()) || typeof enName !== 'string'
        || typeof description !== 'string' || description.length > 16000
        || !['silver','gold','prismatic'].includes(rarity) || !/^assets\/[\w./-]+\.png$/.test(iconPath) || iconPath.includes('..')
        || !Array.isArray(unresolvedValues) || unresolvedValues.some(v=>typeof v!=='string')) throw Error('Invalid rules entry.');
    ids.add(gameDataId); keys.add(sourceKey);
    const old = priorById.get(gameDataId);
    const priorId = priorByKey.get(sourceKey);
    if ((old && old.sourceGameId !== sourceGameId) || (priorId != null && priorId !== gameDataId)) {
      throw Error('Augment ID was reassigned.');
    }
    const event = sourceGameId.startsWith('GoH_');
    const id = old?.id ?? 'game_' + gameDataId;
    if (localIds.has(id)) throw Error('Duplicate local augment ID.');
    localIds.add(id);
    return {...old, id, gameDataId, sourceGameId, sourcePath, name, enName, rarity, description, summary:description,
      descriptionOriginal:description, descriptionTemplate:null, tooltipOriginal:null, unresolvedValues,
      tags:old?.tags ?? [], aliases:[...new Set([...(old?.aliases??[]),name,enName].filter(Boolean))],
      patch:rulesPatch, descriptionPatch:rulesPatch, icon:base + iconPath, availability:'current',
      sourceUrl:base + 'maps/modespecificdata/kiwi.bin.json', localizationSourceUrl:base + 'zh_cn/data/menu/en_us/lol.stringtable.json',
      descriptionSource:sourceLabel + ' KIWI 定义及官方简体中文字符串表',
      retiredPatch:null, acquisition:event?'headliner-only':'regular', recommendable:!event, isInternalTemplate:internal};
  });
  for (const old of knownAugments) {
    if (ids.has(old.gameDataId)) continue;
    if (localIds.has(old.id)) throw Error('Duplicate local augment ID.');
    augments.push(old.availability==='current'
      ? {...old, availability:'retired-in-source', recommendable:false, retiredPatch:rulesPatch} : old);
  }
  const current = pack.augments.length;
  const counts = {...catalog.meta.counts, augments:augments.length, current,
    regular:augments.filter(row=>row.availability==='current'&&row.recommendable).length,
    internalTemplates:augments.filter(row=>row.availability==='current'&&row.isInternalTemplate).length};
  counts.headliner=current-counts.regular-counts.internalTemplates;
  counts.retired=augments.filter(row=>row.retiredPatch).length;
  counts.catalogOnly=augments.filter(row=>row.availability!=='current'&&!row.retiredPatch).length;
  counts.unresolvedDescriptionValues=augments.filter(row=>row.availability==='current'&&row.unresolvedValues?.length).length;
  delete counts.officialAdded;
  delete counts.officialRemoved;
  const sourceUrl=base + 'maps/modespecificdata/kiwi.bin.json';
  const sources = [{name:sourceLabel+' 强化规则（同补丁公开资源）', url:sourceUrl}];
  if (official) sources.push({name:`英雄联盟国服 ${rulesPatch} 正式版本公告`, url:official.url, version:official.version});
  sources.push(...catalog.meta.sources.filter(source => !source.url?.includes('raw.communitydragon.org/')
    && (!official || !officialNoticeUrl.test(source.url) && !riotPatchNotesUrl.test(source.url))));
  return {...catalog, augments, meta:{...catalog.meta, augmentPatch:rulesPatch, patch:rulesPatch,
    gameVersion:'', rulesetName:'海克斯大乱斗', updatedAt:manifest.updatedAt, rulesRevision:manifest.sha256, counts, officialChanges:null,
    rulesSource:sourceUrl, notes:[`强化符文名单和效果取自 ${patch} 正式客户端。选择率、英雄及装备保留各自来源版本。`],
    sources}};
}

async function readResponse(response, maximum) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw Error('Rules feed unavailable.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw Error('Rules response too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeRulesCache(filename, manifest, bytes, signal) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({manifest, payload:bytes.toString('base64')}), {flag:'wx', signal});
    signal.throwIfAborted();
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export class RulesUpdater {
  #catalog; #snapshot; #filename; #fetcher; #onUpdate; #intervalMs; #timers;
  #etag; #pending; #controller; #timer = null; #closed = false;

  constructor({catalog, dataDirectory, fetcher = fetch, onUpdate = () => {},
      intervalMs = checkIntervalMs, timers = {setInterval, clearInterval}}) {
    this.#catalog = catalog;
    this.#snapshot = catalog;
    this.#filename = dataDirectory ? path.join(dataDirectory, rulesCacheFile) : null;
    this.#fetcher = fetcher;
    this.#onUpdate = onUpdate;
    this.#intervalMs = intervalMs;
    this.#timers = timers;
  }

  async load() {
    if (!this.#filename) return this;
    try {
      const info = await stat(this.#filename);
      if (info.isFile() && info.size <= byteLimit * 2) {
        const {manifest, payload} = JSON.parse(await readFile(this.#filename, 'utf8'));
        if (this.#isNewer(validateManifest(manifest))) {
          this.#snapshot = applyRules(this.#catalog, manifest, Buffer.from(payload, 'base64'));
        }
      }
    } catch { /* An unreadable cache leaves the verified bundled catalog active. */ }
    return this;
  }

  getSnapshot() { return this.#snapshot; }

  #isNewer(manifest) {
    const comparison = comparePatches(displayPatch(manifest.clientPatch), this.#snapshot.meta.augmentPatch);
    if (comparison !== 0) return comparison > 0;
    if (manifest.sha256 === this.#snapshot.meta.rulesRevision) return false;
    const acceptedTime = Date.parse(this.#snapshot.meta.updatedAt ?? this.#snapshot.meta.fetchedAt);
    return !Number.isFinite(acceptedTime) || Date.parse(manifest.updatedAt) > acceptedTime;
  }

  check() {
    if (!this.#filename || this.#closed) return Promise.resolve(this.#snapshot);
    if (this.#pending) return this.#pending;
    const controller = new AbortController();
    this.#controller = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    timeout.unref?.();
    this.#pending = this.#refresh(controller.signal).catch(() => this.#snapshot).finally(() => {
      clearTimeout(timeout);
      this.#controller = null;
      this.#pending = null;
    });
    return this.#pending;
  }

  async #refresh(signal) {
    const headers = this.#etag ? {'If-None-Match':this.#etag} : undefined;
    const index = await this.#fetcher(feed + 'index.json', {signal, redirect:'error', cache:'no-cache', headers});
    if (index.status === 304) return this.#snapshot;
    const manifest = validateManifest(JSON.parse(await readResponse(index, manifestLimit)));
    if (this.#isNewer(manifest)) {
      const response = await this.#fetcher(feed + manifest.sha256 + '.json', {signal, redirect:'error'});
      const bytes = await readResponse(response, byteLimit);
      const next = applyRules(this.#catalog, manifest, bytes, {knownAugments:this.#snapshot.augments});
      signal.throwIfAborted();
      await writeRulesCache(this.#filename, manifest, bytes, signal);
      if (this.#closed) return this.#snapshot;
      this.#snapshot = next;
      this.#etag = index.headers.get('etag');
      await this.#onUpdate(next);
    } else {
      this.#etag = index.headers.get('etag');
    }
    return this.#snapshot;
  }

  start() {
    if (!this.#filename || this.#closed || this.#timer !== null) return;
    this.#timer = this.#timers.setInterval(() => { void this.check(); }, this.#intervalMs);
    this.#timer?.unref?.();
    void this.check();
  }

  async close() {
    this.#closed = true;
    if (this.#timer !== null) this.#timers.clearInterval(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
    await this.#pending;
  }
}

export async function loadRules(catalog, directory, {fetcher = fetch, startupMs = 1200} = {}) {
  const updater = await new RulesUpdater({catalog, dataDirectory:directory, fetcher}).load();
  let timer;
  try {
    return await Promise.race([updater.check(), new Promise(resolve => {
      timer = setTimeout(() => resolve(updater.getSnapshot()), startupMs);
    })]);
  } finally { clearTimeout(timer); }
}

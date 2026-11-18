import {createHash, randomUUID} from 'node:crypto';
import {readFile, stat, writeFile, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {comparePatches} from '../dist/version.js';

const feed = 'https://raw.githubusercontent.com/ci16kuai/hexguide-desktop/codex/announcements-feed/rules/';
const byteLimit = 4 * 1024 * 1024;
const sha256 = body => createHash('sha256').update(body).digest('hex');

function validateManifest(value) {
  if (value?.schemaVersion !== 1 || !Number.isFinite(comparePatches(value.clientPatch, value.clientPatch))
      || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isFinite(Date.parse(value.updatedAt))) throw Error('Invalid rules manifest.');
  return value;
}

export function applyRules(catalog, manifest, bytes) {
  validateManifest(manifest);
  if (bytes.length > byteLimit || sha256(bytes) !== manifest.sha256) throw Error('Invalid rules digest.');
  const pack = JSON.parse(bytes), patch = manifest.clientPatch;
  if (pack.schemaVersion !== 1 || pack.clientPatch !== patch || !Array.isArray(pack.augments)
      || pack.augments.length < 100 || pack.augments.length > 1024) throw Error('Incomplete rules pack.');
  const [major, minor] = patch.split('.');
  const rulesPatch = (Number(major) + 10) + '.' + minor;
  if (comparePatches(rulesPatch, catalog.meta.augmentPatch) < 0) throw Error('Older rules pack.');
  const base = 'https://raw.communitydragon.org/' + patch + '/game/';
  const prior = new Map(catalog.augments.filter(a=>a.gameDataId!=null).map(a=>[a.gameDataId,a]));
  const ids = new Set(), keys = new Set(), localIds = new Set();
  const augments = pack.augments.map(row => {
    const {gameDataId, sourceGameId, sourcePath, name, enName, rarity, description, iconPath, unresolvedValues} = row;
    const internal = sourceGameId === 'GoH_PentakillAug_Generic';
    if (!Number.isSafeInteger(gameDataId) || gameDataId <= 0 || ids.has(gameDataId)
        || !/^[A-Za-z0-9_]+$/.test(sourceGameId) || keys.has(sourceGameId)
        || typeof sourcePath !== 'string' || sourcePath.split('/').at(-1)?.toLowerCase() !== sourceGameId.toLowerCase()
        || typeof name !== 'string' || (!internal && !name.trim()) || typeof enName !== 'string'
        || typeof description !== 'string' || description.length > 16000
        || !['silver','gold','prismatic'].includes(rarity) || !/^assets\/[\w./-]+\.png$/.test(iconPath) || iconPath.includes('..')
        || !Array.isArray(unresolvedValues) || unresolvedValues.some(v=>typeof v!=='string')) throw Error('Invalid rules entry.');
    ids.add(gameDataId); keys.add(sourceGameId);
    const old = prior.get(gameDataId);
    if (old && old.sourceGameId !== sourceGameId) throw Error('Augment ID was reassigned.');
    const event = sourceGameId.startsWith('GoH_');
    const id = old?.id ?? 'game_' + gameDataId;
    localIds.add(id);
    return {...old, id, gameDataId, sourceGameId, sourcePath, name, enName, rarity, description, summary:description,
      descriptionOriginal:description, descriptionTemplate:null, tooltipOriginal:null, unresolvedValues,
      tags:old?.tags ?? [], aliases:[...new Set([...(old?.aliases??[]),name,enName].filter(Boolean))],
      patch:rulesPatch, descriptionPatch:rulesPatch, icon:base + iconPath, availability:'current',
      sourceUrl:base + 'maps/modespecificdata/kiwi.bin.json', localizationSourceUrl:base + 'zh_cn/data/menu/en_us/lol.stringtable.json',
      descriptionSource:'CommunityDragon ' + patch + ' 正式客户端 KIWI 定义及简体中文字符串表',
      retiredPatch:null, acquisition:event?'headliner-only':'regular', recommendable:!event, isInternalTemplate:internal};
  });
  for (const old of catalog.augments) {
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
  return {...catalog, augments, meta:{...catalog.meta, augmentPatch:rulesPatch, patch:rulesPatch,
    gameVersion:'', rulesetName:'海克斯大乱斗', updatedAt:manifest.updatedAt, counts, officialChanges:null,
    rulesSource:sourceUrl, notes:[`强化符文名单和效果取自 ${patch} 正式客户端。选择率、英雄及装备保留各自来源版本。`],
    sources:[{name:'当前 KIWI 强化规则',url:sourceUrl},...catalog.meta.sources.filter(s=>!s.url?.includes('raw.communitydragon.org/'))]}};
}

async function download(filename, maximum, fetcher, signal) {
  const response = await fetcher(feed+filename,{signal,redirect:'error'});
  if (!response.ok || !response.body) throw Error('Rules feed unavailable.');
  let size=0;
  const chunks=[];
  for await (const chunk of response.body) {
    size+=chunk.length;
    if (size>maximum) throw Error('Rules response too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Every consumer in a game uses the same catalog. If the download outlasts
// startup, its validated cache becomes active when the assistant next opens.
export async function loadRules(catalog, directory, {fetcher=fetch, startupMs=1200}={}) {
  if (!directory) return catalog;
  const filename=path.join(directory,'rules-v1.json');
  let current=catalog;
  try {
    if ((await stat(filename)).size <= byteLimit*2) {
      const cached=JSON.parse(await readFile(filename,'utf8'));
      current=applyRules(catalog,cached.manifest,Buffer.from(cached.payload,'base64'));
    }
  } catch { /* An unreadable cache leaves the verified bundled catalog active. */ }
  const refresh=async()=>{
    const signal=AbortSignal.timeout(12000);
    const manifest=validateManifest(JSON.parse(await download('index.json',4096,fetcher,signal)));
    const [major, minor]=manifest.clientPatch.split('.');
    if (comparePatches((Number(major)+10)+'.'+minor,current.meta.augmentPatch)<=0) return current;
    const bytes=await download(manifest.sha256+'.json',byteLimit,fetcher,signal);
    const next=applyRules(catalog,manifest,bytes);
    const temporary=filename+'.'+randomUUID()+'.tmp';
    try {
      await writeFile(temporary,JSON.stringify({manifest,payload:bytes.toString('base64')}),{flag:'wx'});
      await rename(temporary,filename);
    } finally { await unlink(temporary).catch(()=>{}); }
    return next;
  };
  let timer;
  try {
    return await Promise.race([refresh().catch(()=>current),new Promise(resolve=>{timer=setTimeout(()=>resolve(current),startupMs);})]);
  } finally { clearTimeout(timer); }
}

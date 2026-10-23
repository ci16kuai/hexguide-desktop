#!/usr/bin/env node
/** Public-source updater. Node 20+ and Python 3; xxhash is cached on H:. No credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const output = path.resolve(option('--out', path.join(project, 'dist', 'data.json')));
const cache = path.resolve(option('--cache', 'H:/Chatgpt/work/2026-10-23/hexguide/update-4/source-cache'));
const base = 'https://arammayhem.com';
const patch = '26.21';
const gameVersion = '4.0';
const clientVersion = '16.21';
const cdragonBase = `https://raw.communitydragon.org/${clientVersion}`;
const officialPatchUrl = 'https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-21-notes/';
const warnings = [];
await fs.mkdir(cache, { recursive: true });

async function getText(url, filename, { reuse = false } = {}) {
  const destination = path.join(cache, filename);
  if (reuse) {
    try { return await fs.readFile(destination, 'utf8'); } catch {}
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(25000),
        headers: { 'User-Agent': 'HexGuide/1.0 (public-data refresh; no account access)' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const body = await response.text();
      if (!body.trim()) throw new Error(`Empty response: ${url}`);
      await fs.writeFile(destination, body, 'utf8');
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getJson(url, filename) {
  const data = JSON.parse(await getText(url, filename));
  return data;
}

function plain(html = '') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
  return html.replace(/<br\s*\/?\s*>|\[br\/?\]/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/\[(?:\/?stat(?::[^\]]+)?|\/?b|\/?i)\]/gi, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, value) => {
      if (value[0] === '#') {
        const code = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : original;
      }
      return entities[value.toLowerCase()] ?? original;
    }).replace(/[ \t\r]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}

function assert(condition, message) { if (!condition) throw new Error(message); }

const normalizeName = value => String(value ?? '').toLowerCase().replace(/^quest\s*:?\s*/, '').replace(/[^a-z0-9\u3400-\u9fff]/g, '');
function resolveDirectTokens(text, rootSpell) {
  const constants = new Map((rootSpell?.mSpell?.DataValues ?? [])
    .filter(v => Array.isArray(v.values) && v.values.length && v.values.every(n => n === v.values[0]))
    .map(v => [v.name.toLowerCase(), v.values[0]]));
  return String(text ?? '').replace(/@([^@]+)@/g, (original, token) => {
    const match = /^([a-z0-9_]+)(?:\*([0-9.]+))?$/i.exec(token);
    if (!match || !constants.has(match[1].toLowerCase())) return original;
    return String(Math.round(constants.get(match[1].toLowerCase()) * (match[2] ? Number(match[2]) : 1) * 1e4) / 1e4);
  });
}

// The Riot stringtable uses XXH3, truncated to 38 bits. Keep its small optional
// dependency under the H: task cache, never in a global Python installation.
async function readGameStrings(keys, stringtableFilename) {
  const candidates = [option('--python', process.env.HEXGUIDE_PYTHON ?? ''), 'python', path.resolve(path.dirname(process.execPath), '../../python/python.exe')].filter(Boolean);
  let python;
  for (const candidate of candidates) {
    try { execFileSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }); python = candidate; break; } catch {}
  }
  assert(python, 'Python 3 is needed for Riot stringtable hashing. Pass --python <python executable>; output preserved.');
  const pythonDeps = path.join(cache, 'pydeps');
  const importProbe = 'import sys;sys.path.insert(0,sys.argv[1]);import xxhash';
  try { execFileSync(python, ['-c', importProbe, pythonDeps], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch {
    console.log('Installing pinned xxhash into the H: task cache for Riot stringtable hashing...');
    execFileSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '--target', pythonDeps, 'xxhash==3.6.0'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const script = `import sys,json,re\nsys.path.insert(0,sys.argv[1])\nimport xxhash\nwith open(sys.argv[2],encoding='utf-8-sig') as f: entries=json.load(f)['entries']\ndef lookup(k):\n v=entries.get(k.lower())\n return v if v is not None else entries.get('{%010x}'%(xxhash.xxh3_64_intdigest(k.lower().encode('utf-8'))&((1<<38)-1)))\ndef expand(text,seen=(),depth=0):\n if text is None or depth>8:return text\n def sub(m):\n  k=m.group(1)\n  if k in seen:return m.group(0)\n  value=lookup(k)\n  return expand(value,seen+(k,),depth+1) if value is not None else m.group(0)\n return re.sub(r'\{\{([^{}]+)\}\}',sub,text)\nprint(json.dumps({k:{'raw':lookup(k),'expanded':expand(lookup(k))} for k in json.load(sys.stdin)},ensure_ascii=True))`;
  return JSON.parse(execFileSync(python, ['-c', script, pythonDeps, path.join(cache, stringtableFilename)], { input: JSON.stringify(keys), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 }));
}

const [index, sourceAugments, sourceCombos, searchIndex, versions, gameLists, gameDefinitions, gameEnglish, gameChinese, , officialPatchHtml] = await Promise.all([
  getJson(`${base}/data/v1/index.json`, 'index.json'),
  getJson(`${base}/data/v1/latest/augments.json`, 'augments.json'),
  getJson(`${base}/data/v1/latest/combos.json`, 'combos.json'),
  getJson(`${base}/search-index.json`, 'search-index.json'),
  getJson('https://ddragon.leagueoflegends.com/api/versions.json', 'ddragon-versions.json'),
  getJson(`${cdragonBase}/plugins/rcp-be-lol-game-data/global/default/v1/augment-lists.json`, 'augment-lists-16.21.json'),
  getJson(`${cdragonBase}/game/maps/modespecificdata/kiwi.bin.json`, 'kiwi.bin.json'),
  getJson(`${cdragonBase}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json`, 'augments-en-16.21.json'),
  getJson(`${cdragonBase}/plugins/rcp-be-lol-game-data/global/zh_cn/v1/cherry-augments.json`, 'augments-zh-16.21.json'),
  getText(`${cdragonBase}/game/zh_cn/data/menu/en_us/lol.stringtable.json`, 'zh_cn-lol.stringtable.json'),
  getText(officialPatchUrl, 'riot-26.21.html'),
]);
assert(Array.isArray(sourceAugments.rows) && sourceAugments.rows.length >= 100, 'Augment source shape/coverage changed; existing output preserved.');
assert(Array.isArray(sourceCombos.rows), 'Combo source shape changed; existing output preserved.');
assert(Array.isArray(searchIndex.augments) && searchIndex.augments.length >= sourceAugments.rows.length, 'Public Mayhem search catalogue shape/coverage changed.');
assert(sourceAugments.meta?.patch, 'Missing augment patch.');
assert(index.license?.scope?.includes('Pick rates only'), 'Source licence scope changed; review before publishing.');
const statsPatch = sourceAugments.meta.patch;
const statsVersionNumbers = statsPatch.split('.').map(Number);
const rulesVersionNumbers = patch.split('.').map(Number);
assert(statsVersionNumbers[0] < rulesVersionNumbers[0] || (statsVersionNumbers[0] === rulesVersionNumbers[0] && statsVersionNumbers[1] <= rulesVersionNumbers[1]), 'Statistics are newer than this pinned rules snapshot; review the updater before publishing.');
assert(!sourceCombos.meta?.releaseId || sourceCombos.meta.releaseId === sourceAugments.meta.releaseId, 'Combo/statistics releases differ; retry later without replacing output.');
// Riot's public patch label is 26.x, while its 2026 Data Dragon version is 16.x.
// Prefer the matching Data Dragon patch, and record its actual version separately.
const patchParts = patch.split('.');
const matchingPrefix = `${Number(patchParts[0]) - 10}.${patchParts[1]}.`;
const dragonVersion = versions.find(v => v.startsWith(matchingPrefix));
assert(dragonVersion, `Data Dragon is missing rules patch ${patch}; existing output preserved.`);
const dragonBase = `https://ddragon.leagueoflegends.com/cdn/${dragonVersion}`;
const [zhChampions, enChampions] = await Promise.all([
  getJson(`${dragonBase}/data/zh_CN/champion.json`, `champion-${dragonVersion}-zh_CN.json`),
  getJson(`${dragonBase}/data/en_US/champion.json`, `champion-${dragonVersion}-en_US.json`),
]);
const roleNames = { Fighter: '战士', Tank: '坦克', Mage: '法师', Assassin: '刺客', Support: '辅助', Marksman: '射手' };
const nicknames = {
  AurelionSol: ['龙王'], Ahri: ['狐狸'], Alistar: ['牛头'], Blitzcrank: ['机器人'], Brand: ['火男'],
  Caitlyn: ['女警'], DrMundo: ['蒙多'], Ezreal: ['EZ', 'ez'], Gangplank: ['船长'], Gragas: ['酒桶'],
  Hecarim: ['人马'], JarvanIV: ['皇子'], Jinx: ['金克丝'], LeeSin: ['盲僧', '瞎子'], Malphite: ['石头人'],
  MasterYi: ['剑圣'], MissFortune: ['女枪'], Nasus: ['狗头'], Nautilus: ['泰坦'], Renekton: ['鳄鱼'],
  Riven: ['锐雯'], Sett: ['腕豪'], TahmKench: ['塔姆'], Thresh: ['锤石'], TwistedFate: ['卡牌'],
  Twitch: ['老鼠'], Vayne: ['薇恩', 'VN'], Vladimir: ['吸血鬼'], Warwick: ['狼人'], Wukong: ['猴子'],
  MonkeyKing: ['猴子'], Yasuo: ['亚索'], Yuumi: ['猫咪'], Zed: ['劫'], Ziggs: ['炸弹人'],
};
const champions = Object.values(zhChampions.data).map(champion => {
  const en = enChampions.data[champion.id];
  return {
    id: champion.id, name: champion.name, title: champion.title, enName: en?.name ?? '',
    aliases: [...new Set([champion.id, champion.name, champion.title, en?.name, ...(nicknames[champion.id] ?? [])].filter(Boolean))],
    roles: champion.tags.map(tag => roleNames[tag] ?? tag), tags: champion.tags,
    resource: champion.partype ?? en?.partype ?? '',
    icon: `${dragonBase}/img/champion/${champion.image.full}`,
    sourceUrl: `${dragonBase}/data/zh_CN/champion.json`, dataVersion: dragonVersion,
  };
});
assert(champions.length >= 160, 'Champion source shape/coverage changed; existing output preserved.');

console.log(`Building ARAM Mayhem ${gameVersion} / ${patch}; keeping statistics labelled ${statsPatch}...`);
const detailFailures = [];
const statsById = new Map(sourceAugments.rows.map(row => [row.augmentId, row]));
const catalogById = new Map(searchIndex.augments.map(row => [row.id, row]));
const catalogRows = [...sourceAugments.rows.map(row => catalogById.get(row.augmentId) ?? {
  id: row.augmentId, name: row.name, rarity: row.rarity,
}), ...searchIndex.augments.filter(row => !statsById.has(row.id))];
const augments = catalogRows.map(catalog => {
  const row = statsById.get(catalog.id);
  const sourceUrl = `${base}/search-index.json`;
  const descriptionOriginal = plain(catalog.description?.['zh-CN'] ?? '');
  const unresolvedValues = [...new Set(descriptionOriginal.match(/@[^@\n]+@/g) ?? [])];
  const description = descriptionOriginal.replace(/@[^@\n]+@/g, '〔数值待核实〕');
  return {
    id: catalog.id, name: catalog.name?.['zh-CN'] ?? '', enName: catalog.name?.en ?? '', rarity: catalog.rarity,
    description, summary: description, icon: catalog.icon ? new URL(catalog.icon, base).href : '', tags: [], sourceUrl, patch: searchIndex.patch,
    descriptionOriginal, unresolvedValues,
    pickRate: Number.isFinite(row?.pickRate) ? row.pickRate : null,
    statsPatch: row ? statsPatch : null, statsDate: row ? sourceAugments.meta.statsDate : null,
    introducedPatch: row?.introducedPatch ?? null, retiredPatch: row?.retiredPatch ?? null,
    availability: row?.retiredPatch ? 'retired-in-source' : 'catalog-only',
    descriptionPatch: searchIndex.patch ?? null,
    descriptionSource: 'arammayhem.com Mayhem 搜索目录原文；历史/参考项，未确认本版本可选。',
    statsSourceUrl: row?.url ?? null,
  };
});

const modeList = gameLists.find(row => row.modeName === 'KIWI')?.augmentList;
assert(Array.isArray(modeList) && modeList.length === 249, 'Pinned 16.21 KIWI pool changed; review upstream before publishing.');
const gameRows = Object.entries(gameDefinitions).filter(([, row]) => row?.__type === 'AugmentData');
assert(gameRows.length === modeList.length, 'KIWI definition/list coverage mismatch.');
const translations = await readGameStrings([...new Set(gameRows.flatMap(([, row]) => [row.NameTra, row.DescriptionTra, row.AugmentTooltipTra]).filter(Boolean))], 'zh_cn-lol.stringtable.json');
const englishById = new Map(gameEnglish.map(row => [row.id, row]));
const chineseById = new Map(gameChinese.map(row => [row.id, row]));
const newStart = officialPatchHtml.indexOf('New Augments');
const removedStart = officialPatchHtml.indexOf('Removed Augments', newStart);
assert(newStart > 0 && removedStart > newStart, 'Official 26.21 changelog sections not found.');
const newNames = [...officialPatchHtml.slice(newStart, removedStart).matchAll(/<p>([\s\S]*?)<\/p>/g)].map(match => plain(match[1]).replace(/^(Silver|Gold|Prismatic)\s+/, ''));
const removedNames = [...officialPatchHtml.slice(removedStart, officialPatchHtml.indexOf('patch-classic', removedStart)).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => plain(match[1]));
assert(newNames.length === 35 && removedNames.length === 13, 'Official 26.21 added/removed counts changed; review upstream.');
const newNameSet = new Set(newNames.map(normalizeName));
const removedNameSet = new Set(removedNames.map(normalizeName));
const officialAdded = [];
const gameMatchedIds = new Set();
for (const [definitionKey, definition] of gameRows) {
  const gameDataId = definition.AugmentPlatformId;
  const en = englishById.get(gameDataId), zh = chineseById.get(gameDataId);
  assert(en?.augmentNameId === definition.AugmentNameId, `Missing official English metadata for ${definition.AugmentNameId}.`);
  const sourcePath = modeList.find(source => source.split('/').at(-1).toLowerCase() === definition.AugmentNameId.toLowerCase());
  assert(sourcePath, `Definition outside KIWI pool: ${definition.AugmentNameId}`);
  const isInternalTemplate = definition.AugmentNameId === 'GoH_PentakillAug_Generic';
  const headlinerOnly = definition.AugmentNameId.startsWith('GoH_');
  const translatedName = translations[definition.NameTra]?.expanded;
  const name = isInternalTemplate ? '' : translatedName || zh?.nameTRA || '';
  assert(isInternalTemplate || name, `Missing Chinese game name for ${definition.AugmentNameId}.`);
  assert(!name.includes('\uFFFD'), `Invalid Unicode in game name: ${definition.AugmentNameId}.`);
  let local = augments.find(row => normalizeName(row.enName) === normalizeName(en.nameTRA));
  if (!local && normalizeName(name)) local = augments.find(row => normalizeName(row.name) === normalizeName(name));
  if (!local) {
    const canonicalId = normalizeName(definition.AugmentNameId.replace(/^ARAM_/, ''));
    local = augments.find(row => normalizeName(row.id) === canonicalId);
  }
  if (local && gameMatchedIds.has(local.id)) {
    warnings.push(`同名条目分开保留：${definition.AugmentNameId} 与 ${local.sourceGameId}，未合并为同一强化。`);
    local = null;
  }
  if (!local) {
    local = { id: `game_${gameDataId}`, tags: [], pickRate: null, statsPatch: null, statsDate: null, statsSourceUrl: null, introducedPatch: null, retiredPatch: null };
    augments.push(local);
  }
  gameMatchedIds.add(local.id);
  const originalDescription = translations[definition.DescriptionTra]?.expanded;
  assert(originalDescription !== null && originalDescription !== undefined, `Missing current description: ${definition.AugmentNameId}`);
  assert(!originalDescription.includes('\uFFFD'), `Invalid Unicode in game description: ${definition.AugmentNameId}.`);
  const resolved = resolveDirectTokens(originalDescription, gameDefinitions[definition.RootSpell]);
  const descriptionOriginal = plain(originalDescription).replace(/%i:[^%]+%/g, '').trim();
  const resolvedPlain = plain(resolved).replace(/%i:[^%]+%/g, '').trim();
  const unresolvedValues = [...new Set(resolvedPlain.match(/@[^@\n]+@|\{\{[^{}]+\}\}/g) ?? [])];
  const oldSnapshot = { name: local.name ?? '', enName: local.enName ?? '', description: local.descriptionOriginal ?? '', descriptionPatch: local.descriptionPatch ?? null, retiredPatch: local.retiredPatch ?? null };
  const isNew = newNameSet.has(normalizeName(en.nameTRA));
  Object.assign(local, {
    name, enName: en.nameTRA, rarity: ['silver', 'gold', 'prismatic'][definition.rarity ?? 0],
    aliases: [...new Set([oldSnapshot.name, oldSnapshot.enName, name, en.nameTRA].filter(Boolean))],
    descriptionOriginal, descriptionTemplate: translations[definition.DescriptionTra]?.raw ?? '',
    tooltipOriginal: plain(translations[definition.AugmentTooltipTra]?.expanded ?? '').replace(/%i:[^%]+%/g, '').trim(),
    description: resolvedPlain.replace(/@[^@\n]+@/g, '〔数值待核实〕').replace(/\{\{[^{}]+\}\}/g, '〔运行时内容待核实〕'),
    unresolvedValues, patch, descriptionPatch: patch,
    descriptionSource: 'CommunityDragon 16.21 正式服 KIWI 定义与官方简体中文字符串表；仅替换全等级相同的直接常数，动态公式不猜值。',
    sourceUrl: `${cdragonBase}/game/maps/modespecificdata/kiwi.bin.json`,
    sourceGameId: definition.AugmentNameId, sourcePath, gameDataId, definitionKey,
    localizationSourceUrl: `${cdragonBase}/game/zh_cn/data/menu/en_us/lol.stringtable.json`,
    descriptionKey: definition.DescriptionTra, tooltipKey: definition.AugmentTooltipTra,
    icon: `${cdragonBase}/game/${definition.AugmentSmallIconPath.toLowerCase().replace(/\.tex$/, '.png')}`,
    availability: 'current', retiredPatch: null, sourceRetiredPatch: oldSnapshot.retiredPatch,
    acquisition: headlinerOnly ? 'headliner-only' : 'regular', recommendable: !headlinerOnly,
    isInternalTemplate, introducedPatch: isNew || headlinerOnly ? patch : local.introducedPatch,
    officialPatchSource: isNew ? officialPatchUrl : null,
    previousSourceSnapshot: oldSnapshot,
  });
  local.summary = local.description;
  if (isNew) officialAdded.push({ id: local.id, name, enName: en.nameTRA, sourceGameId: definition.AugmentNameId });
}
assert(officialAdded.length === 35, 'Could not match all 35 officially added augments to the current KIWI pool.');
const officialRemoved = removedNames.map(enName => {
  const local = augments.find(row => normalizeName(row.enName) === normalizeName(enName));
  if (local) {
    assert(local.availability !== 'current', `Officially removed augment is in current pool: ${enName}`);
    local.sourceRetiredPatch = local.retiredPatch;
    local.retiredPatch = patch;
    local.availability = 'retired-in-source';
    local.officialPatchSource = officialPatchUrl;
  }
  return { enName, id: local?.id ?? null, patch, sourceUrl: officialPatchUrl };
});

const augmentIds = new Set(augments.map(row => row.id));
const championIds = new Set(champions.map(row => row.id));
const combos = sourceCombos.rows.map(row => ({
  id: String(row.comboId), championId: row.championId, augmentIds: row.augmentIds ?? [],
  types: row.types ?? [], sourceUrl: row.url ?? '', evidenceType: 'catalog-association',
  sourcePatch: statsPatch,
  note: `来源 ${statsPatch} 目录中的英雄与强化符文关联；不代表 ${patch} 实测机制、胜率或海克斯两两联动强度。`,
  unresolvedReferences: [
    ...(!championIds.has(row.championId) ? [`champion:${row.championId}`] : []),
    ...(row.augmentIds ?? []).filter(id => !augmentIds.has(id)).map(id => `augment:${id}`),
  ],
}));

assert(new Set(augments.map(row => row.id)).size === augments.length, 'Duplicate augment IDs.');
assert(augments.every(row => ['silver', 'gold', 'prismatic'].includes(row.rarity)), 'Unknown rarity; review source.');
const retired = augments.filter(row => row.retiredPatch).length;
const missingDescriptions = augments.filter(row => !row.description).length;
const missingIcons = augments.filter(row => !row.icon).length;
const unresolvedDescriptionValues = augments.filter(row => row.unresolvedValues.length).length;
const unresolvedComboReferences = combos.filter(row => row.unresolvedReferences.length).length;
const catalogOnly = augments.filter(row => row.availability === 'catalog-only').length;
const current = augments.filter(row => row.availability === 'current').length;
const regular = augments.filter(row => row.availability === 'current' && row.acquisition === 'regular').length;
const headliner = augments.filter(row => row.acquisition === 'headliner-only' && !row.isInternalTemplate).length;
const internalTemplates = augments.filter(row => row.isInternalTemplate).length;
assert(current === 249 && regular === 244 && headliner === 4 && internalTemplates === 1, 'Current/event/internal catalogue separation changed.');
const updatedAt = new Date().toISOString();
const data = {
  meta: {
    mode: 'ARAM Mayhem', gameVersion, rulesetName: 'Journey to Stardom', patch, augmentPatch: patch,
    statsPatch, statsDate: sourceAugments.meta.statsDate, fetchedAt: updatedAt, updatedAt,
    championDataVersion: dragonVersion, dataDragonVersion: dragonVersion, clientDataVersion: clientVersion,
    releaseId: sourceAugments.meta.releaseId ?? index.releaseId,
    sources: [
      { name: 'Riot Games 26.21 正式版本公告', url: officialPatchUrl, license: 'Riot Games 官方公告；用于核验35新增、13公告移除与4.0规则' },
      { name: 'CommunityDragon 16.21 KIWI 正式客户端模式名单', url: `${cdragonBase}/plugins/rcp-be-lol-game-data/global/default/v1/augment-lists.json`, license: 'Riot Games 客户端资料，由 CommunityDragon 提取；非 CC BY 4.0', modeName: 'KIWI', count: modeList.length },
      { name: 'CommunityDragon 16.21 KIWI 强化定义与直接数值', url: `${cdragonBase}/game/maps/modespecificdata/kiwi.bin.json`, license: 'Riot Games 游戏资料；非 CC BY 4.0' },
      { name: 'CommunityDragon 16.21 官方简体中文字符串表', url: `${cdragonBase}/game/zh_cn/data/menu/en_us/lol.stringtable.json`, license: 'Riot Games 游戏文本；非 CC BY 4.0' },
      { name: 'arammayhem.com 公开下载', url: `${base}/data/`, license: 'CC BY 4.0（公开下载；依其声明仅选择率，不包含胜率/强度等级）', licenseUrl: index.license.url, scope: index.license.scope },
      { name: 'arammayhem.com 历史/参考搜索目录', url: `${base}/search-index.json`, license: '游戏效果与图标引用；不属于上述选择率数据 CC 授权声明的确认范围', patch: searchIndex.patch },
      { name: 'Riot Games Data Dragon', url: 'https://developer.riotgames.com/docs/lol#data-dragon', license: 'Riot Games 游戏资料与素材；非 CC BY 4.0', version: dragonVersion },
    ],
    counts: { champions: champions.length, augments: augments.length, current, regular, headliner, internalTemplates, statsAugments: sourceAugments.rows.length, catalogOnly, combos: combos.length, retired, officialAdded: officialAdded.length, officialRemoved: officialRemoved.length, missingDescriptions, missingIcons, unresolvedDescriptionValues, unresolvedComboReferences },
    officialChanges: { patch, sourceUrl: officialPatchUrl, added: officialAdded, removed: officialRemoved },
    notes: [
      `规则与强化资料已更新至海克斯大乱斗 ${gameVersion} / ${patch}，采用 CommunityDragon ${clientVersion} 正式客户端 KIWI 名单与官方中文文本；英雄资料为 Data Dragon ${dragonVersion}。`,
      `统计来源仍为 ${statsPatch}、统计日 ${sourceAugments.meta.statsDate}；没有将旧选择率重标成 ${patch}。规则版、文本版与统计版分别记录。`,
      `KIWI 静态名单含249条：244条常规强化、4条Pentakill事件专属、1条本来没有显示名的事件内部模板。事件项不进入普通推荐，内部模板不展示。`,
      'current 只表示16.21正式客户端KIWI静态名单包含该定义，不能证明服务器热修后的实时可抽取状态；KIWI_JADE和CHERRY名单没有混入。',
      '官方26.21公告列35条新增、13条移除；客户端16.20→16.21静态名单差集为新增40（含5条事件内部/专属）、移除14，存在一项移除口径差异，当前状态以16.21 KIWI静态名单为准。',
      '数据来源：arammayhem.com；下载数据按 CC BY 4.0 整理并转换为本项目结构。',
      '选择率来自站点有限 ARAM: Mayhem 样本，非全球数据；来源未公开样本量、服务器及分段明细。选择率不等于强度或胜率。',
      '没有采集、推断或生成强化符文胜率；未复用站点强度等级或基于胜率的排名。',
      'current条目的descriptionPatch为26.21，中文来自正式客户端字符串表；descriptionTemplate/descriptionOriginal保留原始模板与展开文本。仅解析RootSpell各等级一致的DataValues直接常数，动态计算、运行中统计和未能确定的内容明确标记待核实。',
      `参考目录共 ${augments.length} 项，其中 ${catalogOnly} 项不在当前KIWI名单，保留作历史/待核实参考；${retired} 项带移除标记。旧站退休但现行KIWI包含的条目清除retiredPatch，并在sourceRetiredPatch保留旧站记录。`,
      `${unresolvedDescriptionValues} 项资料仍含无法离线解析的变量；不按猜测填值。`,
      `combos 保留 ${statsPatch} 来源目录的英雄与强化符文关联，没有实测验证 ${patch} 的机制、胜率或强化符文两两联动；原始types仅作来源分类存档。`,
      ...(unresolvedComboReferences ? [`${unresolvedComboReferences} 条来源关联有未解析的目录 ID，保留原始关联但不自动用于推荐。`] : []),
      '英雄职业取自 Data Dragon 官方 tags，中文昵称仅用于搜索。英雄全量目录不表示每个英雄都适用于当前模式。',
      ...(missingDescriptions || missingIcons ? [`部分公开详情未能获取：${missingDescriptions} 个描述、${missingIcons} 个图标为空；没有补造。`] : []),
      ...warnings,
    ],
    detailFailures,
  },
  champions, augments, combos,
};

// Write once only after all validation passes, preserving the last good output on upstream failures.
await fs.mkdir(path.dirname(output), { recursive: true });
const temporary = path.join(cache, 'data-next.json');
await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
await fs.rename(temporary, output);
console.log(JSON.stringify({ output, patch, statsDate: data.meta.statsDate, dataDragonVersion: dragonVersion, ...data.meta.counts, detailFailures }, null, 2));

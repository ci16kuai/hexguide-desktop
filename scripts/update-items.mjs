import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const version = '16.21.1';
const sourceUrl = `https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/item.json`;
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`Data Dragon HTTP ${response.status}`);
const source = await response.json();
if (source.version !== version || !source.data?.['3089']) throw new Error('Unexpected item catalog');
const plain = value => String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
const data = Object.fromEntries(Object.entries(source.data).map(([id, item]) => [id, {
  id, name: plain(item.name), description: plain(item.description), tags: item.tags || [],
  stats: item.stats || {}, maps: item.maps || {}, gold: item.gold,
  from: item.from || [], into: item.into || [], inStore: item.inStore !== false,
  ...(item.requiredChampion ? {requiredChampion: item.requiredChampion} : {}),
  ...(item.requiredAlly ? {requiredAlly: item.requiredAlly} : {}),
  icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${item.image.full}`
}]));
const output = {meta: {
  version, locale: 'zh_CN', sourceUrl, fetchedAt: new Date().toISOString(), count: Object.keys(data).length,
  note: '保留所有地图和目录项目，避免把模式专属装备漏掉；商店可用性以本局为准。静态说明中的动态数值可能为零，不据此计算收益。'
}, data};
await writeFile(fileURLToPath(new URL('../dist/items.json', import.meta.url)), JSON.stringify(output), 'utf8');
console.log(`Saved ${Object.keys(data).length} items from Data Dragon ${version}`);

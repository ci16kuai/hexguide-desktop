import {createHash} from 'node:crypto';
import {numericValue} from '../../dist/announcements-contract.js';

export const digest = input => createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex');
export async function fetchText(url, {fetchImpl=fetch, maxBytes=24*1024*1024, timeout=40000} = {}) {
  const response = await fetchImpl(url, {redirect:'error',signal:AbortSignal.timeout(timeout),headers:{'User-Agent':'HexGuide-announcements/1.0'},cache:'no-store'});
  if (!response.ok) throw new Error(`Source request failed: HTTP ${response.status} (${new URL(url).hostname}).`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Source too large.');
  let size=0; const chunks=[];
  for await (const chunk of response.body) { size+=chunk.length; if(size>maxBytes) throw new Error('Source too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export const plain = text => String(text??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
export const clientVersion = v => v.split('.').slice(0,2).join('.');
const validVersion = v => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);
export async function listVersions(options={}) {
  const versions=JSON.parse(await fetchText('https://ddragon.leagueoflegends.com/api/versions.json',options));
  if(!Array.isArray(versions) || !versions.length || !validVersion(versions[0])) throw new Error('Unexpected version list.');
  return versions.filter(validVersion);
}
const numericTokens = description => plain(description.replace(/<stats>[\s\S]*?<\/stats>/gi,''));
const formulaValues=new Set(['mStartValue','mEndValue','mCoefficient','mNumber','mValue','mLevel1Value','mLevel18Value','mBaseP','mBaseValue','mPerLevel','mAdditionalBonusAtThisLevel','mInitialBonusPerLevel']);
function formulaNumbers(value,prefix,numbers,fieldGroups,group) {
  if(Array.isArray(value))return value.map((row,i)=>formulaNumbers(row,`${prefix}[${i}]`,numbers,fieldGroups,group));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,row])=>{
    const field=`${prefix}.${key}`;
    if(formulaValues.has(key)&&numericValue(row)){numbers[field]=row;fieldGroups[field]=group;return [key,'#number'];}
    return [key,formulaNumbers(row,field,numbers,fieldGroups,group)];
  }));
  return value;
}
export function normalizeCatalog({version,items,lists,definitions,names,sources}) {
  if(!validVersion(version) || items.version!==version || !items.data || Object.keys(items.data).length<100) throw new Error('Incomplete item catalog.');
  const pool=lists?.find(row=>row.modeName==='KIWI')?.augmentList;
  if(!Array.isArray(pool) || pool.length<100 || pool.length>1000 || new Set(pool).size!==pool.length || !Array.isArray(names)) throw new Error('Incomplete KIWI catalog.');
  const nameIndex=new Map(names.map(row=>[row.augmentNameId,row.nameTRA]));
  const result={schemaVersion:1,version,clientVersion:clientVersion(version),sources,items:{},augments:{}};
  for(const [id,item] of Object.entries(items.data)) {
    if(!item.maps?.['12'] || item.inStore===false || !/^\d+$/.test(id)) continue;
    const numbers=Object.create(null);
    for(const [key,v] of Object.entries(item.stats??{})) if(numericValue(v)) numbers[`stats.${key}`]=v;
    for(const key of ['base','total','sell']) if(numericValue(item.gold?.[key])) numbers[`gold.${key}`]=item.gold[key];
    result.items[id]={name:plain(item.name),numbers,description:numericTokens(item.description??'')};
  }
  const definitionIndex=new Map(Object.entries(definitions).filter(([,row])=>row.__type==='AugmentData').map(([key,row])=>[row.AugmentNameId.toLowerCase(),{key,row}]));
  for(const sourcePath of pool) {
    const match=definitionIndex.get(sourcePath.split('/').at(-1).toLowerCase());
    const definition=match?.row;
    if(definition?.__type!=='AugmentData' || !definition.AugmentNameId) throw new Error('KIWI pool/definition mismatch.');
    const id=definition.AugmentNameId;
    if(id==='GoH_PentakillAug_Generic') continue;
    const name=plain(nameIndex.get(id));
    if(!name || !/[\u3400-\u9fff]/u.test(name)) throw new Error('Missing Chinese augment name.');
    const root=definitions[definition.RootSpell];
    if(!root?.mSpell) throw new Error('Missing augment spell data.');
    const numbers=Object.create(null),structures=Object.create(null),fieldGroups=Object.create(null);
    const base=sourcePath.toLowerCase()+'/';
    const spells=[[definition.RootSpell,root],...Object.entries(definitions).filter(([key,row])=>key!==definition.RootSpell&&row.__type==='SpellObject'&&row.mSpell&&(row.objectPath??key).toLowerCase().startsWith(base))];
    for(const [spellKey,spell] of spells) {
      const prefix=spellKey===definition.RootSpell?'':`spell.${spell.ObjectName??spellKey.split('/').at(-1)}.`;
      for(const [field,value] of Object.entries({'Cooldown.values':spell.mSpell.Cooldown?.values,cooldownTime:spell.mSpell.cooldownTime,castRange:spell.mSpell.castRange})) {
        if(numericValue(value))numbers[`${prefix}raw.${field}`]=value;
      }
      const values=spell.mSpell.DataValues??[];
      if(!Array.isArray(values)) throw new Error('Invalid augment numerical data.');
      for(const row of values) {
        const key=prefix+row.name;
        if(!row.name) throw new Error('Invalid augment numerical field.');
        if(Object.hasOwn(numbers,key)) {
          if(JSON.stringify(numbers[key])!==JSON.stringify(row.values))throw new Error('Conflicting augment numerical field.');
          continue;
        }
        if(row.values===undefined)continue;
        if(!numericValue(row.values))throw new Error('Invalid augment numerical values.');
        numbers[key]=row.values;
      }
      for(const [calculation,value] of Object.entries(spell.mSpell.mSpellCalculations??{})) {
        const group=`${prefix}calc.${calculation}`;
        structures[group]=digest(formulaNumbers(value,group,numbers,fieldGroups,group));
      }
    }
    if(Object.hasOwn(result.augments,id))throw new Error('Duplicate augment ID.');
    result.augments[id]={name,numbers,structures,fieldGroups};
  }
  if(Object.keys(result.items).length<80 || Object.keys(result.augments).length<100)throw new Error('Incomplete mode snapshot.');
  return result;
}
export async function fetchCatalog(version,options={}) {
  if(!validVersion(version))throw new Error('Invalid version.');
  const root=`https://raw.communitydragon.org/${clientVersion(version)}`;
  const urls={items:`https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/item.json`,lists:`${root}/plugins/rcp-be-lol-game-data/global/default/v1/augment-lists.json`,definitions:`${root}/game/maps/modespecificdata/kiwi.bin.json`,names:`${root}/plugins/rcp-be-lol-game-data/global/zh_cn/v1/cherry-augments.json`};
  const entries=await Promise.all(Object.entries(urls).map(async([key,url])=>{const body=await fetchText(url,options);return [key,JSON.parse(body),{name:`${key==='items'?'Riot Data Dragon':'CommunityDragon KIWI'} ${version}`,url,sha256:digest(body)}];}));
  return normalizeCatalog({version,...Object.fromEntries(entries.map(([key,value])=>[key,value])),sources:entries.map(([, ,source])=>source)});
}
export function diffCatalogs(previous,current) {
  if(previous?.schemaVersion!==1 || current?.schemaVersion!==1)throw new Error('Invalid baseline.');
  const changes=[],warnings=[];
  for(const [collection,kind] of [['items','item'],['augments','augment']]) {
    if(!previous[collection] || !current[collection])throw new Error('Missing baseline catalog.');
    for(const [id,next] of Object.entries(current[collection])) {
      const old=previous[collection][id]; if(!old)continue;
      for(const [field,after] of Object.entries(next.numbers)) {
        const group=next.fieldGroups?.[field];
        if(group && next.structures[group]!==old.structures?.[group]) {
          if(!warnings.some(w=>w.kind===kind&&w.id===id&&w.group===group))warnings.push({kind,id,group,reason:'公式结构变化，未把不同计算项的数值直接对应。'});
          continue;
        }
        const before=old.numbers[field];
        const percentage=kind==='item' && field.startsWith('stats.') && (/Percent/.test(field)||field==='stats.FlatCritChanceMod');
        if(numericValue(before) && JSON.stringify(before)!==JSON.stringify(after)) changes.push({key:`${kind}:${id}:${field}`,kind,entityId:id,name:next.name,field,before,after,unit:percentage?'%':field.startsWith('gold.')?'金币':'',scale:percentage?100:1});
      }
      if(kind==='item' && old.description!==next.description) {
        const pattern=/-?\d+(?:\.\d+)?/g;
        const before=old.description.match(pattern)??[],after=next.description.match(pattern)??[];
        if(old.description.replace(pattern,'#')===next.description.replace(pattern,'#') && before.length===after.length) {
          const matches=[...next.description.matchAll(pattern)];
          before.forEach((v,i)=>{if(v!==after[i]) changes.push({key:`item:${id}:effect.${i}`,kind,entityId:id,name:next.name,field:`effect.${i}`,context:next.description.slice(Math.max(0,matches[i].index-25),matches[i].index+40),before:Number(v),after:Number(after[i]),unit:next.description[matches[i].index+after[i].length]==='%'?'%':'',scale:1});});
        } else if(before.join('|')!==after.join('|'))warnings.push({kind,id,reason:'效果文本结构变化，无法逐项确认数值对应关系。'});
      }
    }
  }
  if(changes.length>4000)throw new Error('Unexpectedly large diff.');
  return {changes:changes.sort((a,b)=>a.key.localeCompare(b.key)),warnings};
}

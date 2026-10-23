import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createStatistics, getChampionRows, getAugmentRows, getAugmentBuildAdvice} from '../dist/statistics.js';

const hero = (id, name, aliases = []) => ({id, name, title:`${name}称号`, enName:id, aliases});
const aug = (id, extra = {}) => ({id, name:id, rarity:'gold', availability:'current', description:'获得20技能急速。', ...extra});
const catalog = {meta:{patch:'26.21'}, champions:[hero('Ahri','阿狸',['狐狸']), hero('Jinx','金克丝'), hero('Zed','劫')],
  augments:[aug('first'), aug('second'), aug('low'), aug('retired',{retiredPatch:'26.21'}), aug('headliner',{recommendable:false}), aug('pbe')]};
const observation = (id, wins, games, extra = {}) => ({augmentId:id,sourceAugmentId:id,name:id,rarity:'gold',cohortId:'main',games,wins,
  winRate:100*wins/games,lowSample:false,provisional:false,sourceUrl:`https://example.test/augment/${id}`,builds:[],...extra});
const snapshot = (extra = {}) => ({schemaVersion:1,meta:{mode:'aram-mayhem',patch:'16.21',rulesPatch:'26.21',cohortId:'main',validGames:2000,
  lowSampleThreshold:3000,statsUpdatedAt:'2026-10-23T10:00:00Z',fetchedAt:'2026-10-23T11:00:00Z',source:{name:'统计来源',url:'https://example.test',license:'source license'}},
  champions:[{championId:'Ahri',sourceChampionId:'103',cohortId:'main',games:1000,wins:500,winRate:50,
    augments:[observation('first',560,1000),observation('second',550,1000),observation('low',9,10,{lowSample:true}),
      observation('retired',600,1000),observation('headliner',700,1000),observation(null,800,1000,{sourceAugmentId:'unmapped',name:'未映射'}),
      observation('pbe',900,1000,{provisional:true,cohortId:'pbe'})]},
    {championId:'Jinx',cohortId:'main',games:500,wins:300,winRate:60,augments:[]}],...extra});

test('merge covers the entire catalog, preserves missing counts and never mutates source data', () => {
  const raw = snapshot(), before = structuredClone(raw), catalogBefore = structuredClone(catalog);
  const index = createStatistics(raw,catalog);
  assert.equal(index.champions.length,3);
  assert.equal(index.championById.get('Ahri').winRate,50);
  const missing = index.championById.get('Zed');
  assert.equal(missing.hasStats,false);
  assert.equal(missing.winRate,null);
  assert.equal(missing.games,null);
  assert.equal(missing.wins,null);
  assert.equal(index.meta.updatedAt,raw.meta.statsUpdatedAt);
  assert.notEqual(index.meta.updatedAt,index.meta.fetchedAt);
  assert.equal(index.meta.totalMatches,2000);
  assert.deepEqual(raw,before);
  assert.deepEqual(catalog,catalogBefore);
});

test('hero list searches aliases and Chinese metadata and places unknown statistics last', () => {
  const index = createStatistics(snapshot(),catalog);
  assert.deepEqual(getChampionRows(index).map(row=>row.id),['Jinx','Ahri','Zed']);
  assert.deepEqual(getChampionRows(index,{sort:'games'}).map(row=>row.id),['Ahri','Jinx','Zed']);
  assert.deepEqual(getChampionRows(index,{query:'狐狸'}).map(row=>row.id),['Ahri']);
  assert.deepEqual(getChampionRows(index,{query:' 金克丝称号 '}).map(row=>row.id),['Jinx']);
  assert.deepEqual(getChampionRows(index,{query:'ＡＨＲＩ'}).map(row=>row.id),['Ahri']);
  assert.equal(getChampionRows(index,{query:'不存在'}).length,0);
  assert.deepEqual(index.champions.map(row=>row.id),['Ahri','Jinx','Zed']);
});

test('augment rank is the unrounded percentage-point difference using observed wins/games', () => {
  const raw = snapshot();
  raw.champions[0].augments = [observation('first',50001,100000),observation('second',50002,100000),observation('low',49999,100000)];
  const rows = getAugmentRows(createStatistics(raw,catalog),'Ahri');
  assert.deepEqual(rows.map(row=>row.augmentId),['second','first','low']);
  assert.ok(Math.abs(rows[0].deltaPp-0.002)<1e-10);
  assert.equal(rows[0].delta,rows[0].deltaPp);
  assert.ok(rows[2].deltaPp<0);
  assert.equal(rows[0].comparable,true);
  assert.equal(rows[0].canAdopt,true);
});

test('default filters obey source low-sample flags, current availability and explicit reference switches', () => {
  const index = createStatistics(snapshot(),catalog);
  assert.deepEqual(getAugmentRows(index,'Ahri').map(row=>row.augmentId),['first','second']);
  assert.deepEqual(getAugmentRows(index,'Ahri',{includeLowSample:true}).map(row=>row.augmentId),['low','first','second']);
  const all = getAugmentRows(index,'Ahri',{includeLowSample:true,includeUnavailable:true});
  assert.equal(all.length,7);
  const unknown = all.find(row=>row.sourceAugmentId==='unmapped');
  assert.equal(unknown.augment,null);
  assert.equal(unknown.winRate,80);
  assert.equal(unknown.isCurrent,false);
  assert.equal(unknown.canAdopt,false);
  assert.equal(unknown.outdated,false,'unmapped does not mean old-version data');
  assert.equal(all.find(row=>row.augmentId==='retired').outdated,true);
  assert.equal(all.at(-1).provisional,true);
  assert.equal(all.at(-1).deltaPp,null);
  assert.match(all.at(-1).comparisonReason,/预览/);
  assert.equal(getAugmentRows(index,'Ahri',{rarity:'silver'}).length,0);
  assert.equal(getAugmentRows(index,'Ahri',{query:'second'}).length,1);
  // Source false wins over a local threshold of 3000, although samples are 1000.
  assert.equal(getAugmentRows(index,'Ahri')[0].lowSample,false);
});

test('incompatible cohorts and provisional rows never receive an uplift against the live baseline', () => {
  const raw = snapshot();
  raw.champions[0].augments = [observation('first',700,1000,{cohortId:'another-region'}),observation('second',650,1000,{provisional:true})];
  const index = createStatistics(raw,catalog);
  assert.equal(getAugmentRows(index,'Ahri').length,0);
  for (const row of getAugmentRows(index,'Ahri',{includeUnavailable:true})) {
    assert.equal(row.comparable,false);
    assert.equal(row.deltaPp,null);
    assert.ok(row.comparisonReason);
  }
  raw.meta.rulesPatch='26.20';
  const outdated = createStatistics(raw,catalog).championById.get('Ahri').augments[0];
  assert.equal(outdated.outdated,true);
  assert.equal(outdated.canAdopt,false);
});

test('pick rate, rounded rates without counts, zero samples and invalid units are never win rates', () => {
  for (const change of [{games:undefined,wins:undefined,winRate:80,pickRate:90},{games:0,wins:0,winRate:50},
    {games:100,wins:101,winRate:50},{games:100,wins:-1,winRate:50},{games:100,wins:50,winRate:0.5},
    {games:'100',wins:50,winRate:50},{games:100,wins:50,winRate:NaN}]) {
    const raw = snapshot();
    Object.assign(raw.champions[0],change);
    const index = createStatistics(raw,catalog), row = index.championById.get('Ahri');
    assert.equal(row.hasStats,false,JSON.stringify(change));
    assert.equal(row.winRate,null);
    assert.equal(row.augments[0].deltaPp,null);
  }
  const raw = snapshot();
  raw.champions[0].augments=[observation('first',500,1000,{winRate:undefined,pickRate:99})];
  assert.equal(getAugmentRows(createStatistics(raw,catalog),'Ahri')[0].winRate,50,'actual counts suffice; pickRate is ignored');
});

test('six-decimal source probabilities converted to percent retain precise count-derived rates', () => {
  const raw = snapshot();
  Object.assign(raw.champions[0],{games:110911,wins:54299,winRate:48.9573});
  const hero = createStatistics(raw,catalog).championById.get('Ahri');
  assert.equal(hero.hasStats,true);
  assert.equal(hero.winRate,100*54299/110911);
  assert.equal(hero.sourceWinRate,48.9573);
});

test('snapshot validation rejects wrong modes and duplicates instead of silently choosing a source', () => {
  assert.throws(()=>createStatistics({...snapshot(),schemaVersion:2},catalog),TypeError);
  const wrongMode=snapshot();wrongMode.meta.mode='aram';
  assert.throws(()=>createStatistics(wrongMode,catalog),TypeError);
  const duplicate=snapshot();duplicate.champions.push(duplicate.champions[0]);
  assert.throws(()=>createStatistics(duplicate,catalog),/Duplicate/);
  const duplicateAugment=snapshot();duplicateAugment.champions[0].augments.push(duplicateAugment.champions[0].augments[0]);
  assert.throws(()=>createStatistics(duplicateAugment,catalog),/duplicate/);
});

test('mechanism build suggestions use the selected mapped augment and never invent build win rates', async () => {
  const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
  const itemsCatalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
  const champion=data.champions.find(entry=>entry.id==='Ahri');
  const selected=data.augments.find(entry=>entry.id==='goliath');
  const advice=getAugmentBuildAdvice({champion,augment:selected,augments:data.augments,itemsCatalog});
  assert.equal(advice.evidence,'mechanism');
  assert.match(advice.label,/无该组合出装胜率/);
  assert.ok(advice.choices.some(choice=>choice.id==='tank'));
  assert.ok(advice.choices.flatMap(choice=>choice.items).length>0);
  assert.match(advice.context.join(' '),/此页查看的海克斯：「歌利亚巨人」/);
  const recursivelyNoRates=value=>{
    if(!value||typeof value!=='object')return;
    for(const [key,entry] of Object.entries(value)){
      assert.ok(!['winRate','deltaPp','wins','games','score'].includes(key),`invented ${key}`);
      recursivelyNoRates(entry);
    }
  };
  recursivelyNoRates(advice);
  for(const augment of [{augment:null,sourceAugmentId:'unknown'}, {...selected,availability:'catalog-only'}, {augment:selected,provisional:true}]){
    const unavailable=getAugmentBuildAdvice({champion,augment,augments:data.augments,itemsCatalog});
    assert.equal(unavailable.choices.length,0);
    assert.equal(unavailable.confidence,'unavailable');
  }
});

test('Hecarim uses the selected ability-then-attack augment for a specific AD weaving route', async () => {
  const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
  const itemsCatalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
  const selected=data.augments.find(entry=>entry.id==='the_boom_and_the_bass');
  const advice=id=>getAugmentBuildAdvice({champion:data.champions.find(entry=>entry.id===id),augment:selected,augments:data.augments,itemsCatalog});
  const horse=advice('Hecarim');
  assert.equal(horse.choices[0].id,'spell-attack-weave');
  assert.deepEqual(horse.choices[0].items.map(item=>item.id),['3078','3161']);
  assert.match(horse.choices[0].items[0].reason,/施放技能后.*普通攻击/);
  assert.match(horse.choices[0].items[1].reason,/基础技能急速/);
  assert.ok(horse.choices[0].items.every(item=>!['3100','3115','3068'].includes(item.id)));
  const prose=JSON.stringify({context:horse.context,choices:horse.choices});
  assert.doesNotMatch(prose,/已确认|实战面板|在真实对局开始前/);
  assert.match(prose,/查看建议不会将它加入本局/);
  const itemIds=horse.choices.flatMap(choice=>choice.items.map(item=>item.id));
  assert.equal(new Set(itemIds).size,itemIds.length);
  assert.ok(horse.choices.findIndex(choice=>choice.id==='survive')<0||horse.choices.at(-1).id==='survive');
  const mage=advice('Ahri');
  assert.equal(mage.choices[0].id,'spell-attack-weave');
  assert.deepEqual(mage.choices[0].items.map(item=>item.id),['3100']);
  assert.ok(!mage.choices[0].items.some(item=>item.id==='3078'));
  const malformedCatalog=structuredClone(itemsCatalog);
  malformedCatalog.data['3078'].description='只有攻击力，没有咒刃。';
  const guarded=getAugmentBuildAdvice({champion:data.champions.find(entry=>entry.id==='Hecarim'),augment:selected,augments:data.augments,itemsCatalog:malformedCatalog});
  assert.ok(guarded.choices[0].items.every(item=>item.id!=='3078'),'an unverified item effect is not stated as a fact');
});

test('spell, attack-crit and health augments change actual route priority and equipment choices', async () => {
  const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
  const itemsCatalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
  const champion=data.champions.find(entry=>entry.id==='Gwen');
  const advice=id=>getAugmentBuildAdvice({champion,augment:data.augments.find(entry=>entry.id===id),augments:data.augments,itemsCatalog});
  const spell=advice('jeweled_gauntlet'), attackCrit=advice('critical_rhythm'), health=advice('goliath');
  assert.equal(spell.choices[0].id,'spell');
  assert.equal(attackCrit.choices[0].id,'attack');
  assert.equal(health.choices[0].id,'tank');
  assert.notDeepEqual(spell.choices[0].items.map(item=>item.id),attackCrit.choices[0].items.map(item=>item.id));
  assert.notDeepEqual(attackCrit.choices[0].items.map(item=>item.id),health.choices[0].items.map(item=>item.id));
});

test('equipment upgrades use an exact unique purchasable ARAM base item and explain granted items', async () => {
  const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
  const itemsCatalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
  const champion=data.champions.find(entry=>entry.id==='Gwen');
  const advice=(id,items=itemsCatalog)=>getAugmentBuildAdvice({champion,augment:data.augments.find(entry=>entry.id===id),augments:data.augments,itemsCatalog:items});
  assert.equal(advice('upgrade_collector').choices[0].items[0].id,'6676');
  assert.equal(advice('upgrade_collector').choices[0].id,'augment-equipment');
  const grantFixture=aug('grant-fixture',{name:'升级：米凯尔的祝福',description:'获得一个【米凯尔的祝福】。'});
  const provided=getAugmentBuildAdvice({champion,augment:grantFixture,augments:[grantFixture],itemsCatalog});
  assert.match(provided.choices[0].items[0].reason,/请勿.*重复购买/);
  const ambiguous=advice('upgrade_infinity_edge');
  assert.notEqual(ambiguous.choices[0].id,'augment-equipment');
  assert.match(ambiguous.context.join(' '),/多个可购同名版本/);
  const fakeItems={data:{phantom:{id:'phantom',name:'收集者',inStore:false,gold:{purchasable:true},maps:{12:true}},
    arena:{id:'arena',name:'收集者',gold:{purchasable:true},maps:{30:true}}}};
  assert.notEqual(advice('upgrade_collector',fakeItems).choices[0].id,'augment-equipment');
  const map453={data:{mayhem:{id:'mayhem',name:'收集者',gold:{purchasable:true},maps:{453:true}}}};
  assert.equal(advice('upgrade_collector',map453).choices[0].items[0].id,'mayhem');
});

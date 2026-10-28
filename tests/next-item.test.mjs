import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildNextItemRecommendation as recommend, NEXT_ITEM_POLICY} from '../server/next-item.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const now = Date.parse('2026-10-27T06:00:00Z');
const stamp = offset => new Date(now + offset).toISOString();
const hero = id => data.champions.find(row => row.id === id);
const officialChampions=JSON.parse(await readFile(new URL('../server/resources/champions-16.21.1.json',import.meta.url),'utf8')).champions;
const numbers=Object.fromEntries(officialChampions.map(champion=>[champion.id,Number(champion.key)]));
const row = (id,winRate=.58,sampleCount=1000) => ({id:Number(id),winRate,sampleCount});
const yiRows = () => [row(3153,.60),row(3124,.58),row(6333,.59)];
const group = (rows,order) => ({items:{all:rows},builds:{archetypes:order ? [{key:'fixture',profiles:[{
  itemSet:order.map(id=>({id:Number(id)})),sampleCount:900,winRate:.57,
  routes:[{purchaseOrder:order.map(id=>({id:Number(id)})),sampleCount:800,winRate:.57}]}]}] : []}});
function source(championId='MasterYi',rows=yiRows(),order=[3153,3124,6333],conditions=[]) {
  const base = group(rows,order);
  return {championId,sourceChampionId:numbers[championId],patch:'16.21',status:'ready',mayhemStatus:'ready',referenceStatus:'missing',snapshot:{
    championId:numbers[championId],meta:{patch:'16.21',dataDate:'2026-10-25',sourceUrl:'https://aramkit.com/',dataPath:'data/16.21-test'},
    detail:{champion:{id:numbers[championId]},items:{filtered:base.items},builds:{filtered:base.builds},augments:{all:[]},augmentCombinations:[]},
    single:{items:conditions.map(condition=>({augmentId:condition.id,...group(condition.rows,condition.order).items})),
      builds:conditions.map(condition=>({augmentId:condition.id,...group(condition.rows,condition.order).builds}))}}};
}
const live = (championId='MasterYi') => ({connection:{status:'connected'},mode:{known:true,isMayhem:true},gameId:'fixture-match',
  stage:'live',phase:'InProgress',championSource:'live-client',championId,observedAt:stamp(0),gameTime:600,level:11,items:[],
  teams:{status:'detected',ownTeam:'ORDER',observedAt:stamp(0),allies:[],enemies:[]}});
const enemy = (championId,items=[],extra={}) => ({championId,level:11,items:items.map(id=>({id,count:1})),...extra});
const fedJinx = () => enemy('Jinx',[3031,6676,3006],{level:13,performance:{kills:18,deaths:2,assists:8,creepScore:80}});
function options(championId='MasterYi',overrides={}) {
  const input = {champion:hero(championId),champions:data.champions,augments:data.augments,itemsCatalog,
    live:live(championId),recommendationData:source(championId),now,...overrides};
  if (input.recommendationData && !input.recommendationData.ordinaryAram) {
    const order = input.recommendationData.snapshot?.detail?.builds?.filtered?.archetypes?.[0]?.profiles?.[0]?.routes?.[0]?.purchaseOrder?.map(item=>String(item.id));
    input.recommendationData.ordinaryAram=reference('aram',order || (championId==='Ahri' ? ['3100','4645','3135'] : ['3072','6672','3091']),{championId});
    input.recommendationData.referenceStatus='ready';
  }
  return input;
}
const inventory = ids => ids.map(id=>({id,count:1}));

test('observed route supplies one completed item; purchasing advances deterministically without mutating full plan', () => {
  const input = options(), fullPlan = {buildItems:[{id:'6333'}],choices:[]};
  input.plan = fullPlan;
  const before = structuredClone(input);
  const initial = recommend(input);
  assert.equal(initial.status,'ready'); assert.equal(initial.item.id,'3153');
  assert.deepEqual(recommend(input),initial); assert.deepEqual(input,before);
  assert.deepEqual(initial.evidence.purchaseOrder,['3153','3124','6333']);
  input.live.items = inventory([3153]); assert.equal(recommend(input).item.id,'3124');
  input.live.items = inventory([3153,3124]); assert.equal(recommend(input).item.id,'6333');
  input.live.items = inventory([3153,3124,6333]); assert.equal(recommend(input).status,'complete');
  assert.ok(initial.reasons.length <= 2); assert.equal(initial.item.totalGold,3200);
});

test('multiple visible frontlines can promote percent-health attacks within plausible statistical choices', () => {
  const input = options('MasterYi',{recommendationData:source('MasterYi',[row(3124,.60),row(3153,.599),row(6333,.58)],null)});
  assert.equal(recommend(input).item.id,'3124');
  input.live.teams.enemies = [enemy('Ornn',[3084]),enemy('Sion',[3083]),enemy('Chogath',[3084])];
  const result = recommend(input);
  assert.equal(result.item.id,'3153'); assert.equal(result.evidence.frontlineCount,3);
  assert.match(result.reason,/生命值/); assert.ok(result.evidence.contextBonus <= NEXT_ITEM_POLICY.contextLimit);
});

test('after BORK a fed physical threat can promote compatible AD armor; low or missing performance does not fake that threat', () => {
  const input = options(); input.live.items = inventory([3153]);
  input.live.teams.enemies = [enemy('Jinx')];
  assert.equal(recommend(input).item.id,'3124');
  input.live.teams.enemies = [fedJinx()];
  const result = recommend(input);
  assert.equal(result.item.id,'6333'); assert.equal(result.evidence.threatChampionId,'Jinx');
  assert.equal(result.evidence.performanceObserved,true); assert.match(result.reason,/物理机制/);
  input.live.teams.enemies[0].performance = {kills:1,deaths:10,assists:null};
  assert.equal(recommend(input).item.id,'3124');
});

test('physical threat does not make a caster buy AD armor', () => {
  const input = options('Ahri',{recommendationData:source('Ahri',[row(3089,.59),row(3157,.58),row(6333,.99)],null)});
  input.live.teams.enemies = [fedJinx()];
  assert.equal(recommend(input).item.id,'3157');
});

test('an unfinished target survives components and a changed threat until its complete item is observed', () => {
  const input = options();
  input.live.items = inventory([3153]);
  input.targetItemId = recommend(input).item.id;
  assert.equal(input.targetItemId,'3124');
  input.live.items = inventory([3153,1043,1052,1037]);
  input.live.teams.enemies = [fedJinx()];
  assert.equal(recommend({...input,targetItemId:null}).item.id,'6333','the changed situation would otherwise switch targets');
  let result = recommend(input);
  assert.equal(result.item.id,'3124','components cannot complete or replace the committed target');
  assert.equal(result.purchaseProgress.status,'building');
  input.live.items = inventory([3153,3124]);
  result = recommend(input);
  assert.equal(result.item.id,'6333');
  assert.equal(result.purchaseProgress.status,'completed');
});

test('retained targets use fresh evidence without inventing statistics when a new cohort omits them', () => {
  const condition={id:'changed-cohort',gameDataId:7009,name:'新条件',description:'获得30攻击力。'};
  const input=options('MasterYi',{targetItemId:'3153',owned:[condition],augments:[condition],
    recommendationData:source('MasterYi',yiRows(),null,[{id:7009,rows:[row(6333,.60)],order:null}])});
  const result=recommend(input);
  assert.equal(result.item.id,'3153');
  assert.equal(result.evidence.conditionAugmentId,condition.id);
  assert.equal(result.evidence.scope,'mechanism-fallback');
  assert.equal(result.evidence.sampleCount,null);
  assert.equal(result.evidence.winRate,null);
});

const upgrade = id => data.augments.find(augment => augment.id === id);
const replanOptions = (championId='Zaahen', augmentId='game_2140') => options(championId,{
  owned:[upgrade(augmentId)], targetItemId:'6333', targetAugmentIds:[],
  recommendationData:source(championId,[row(6333,.60),row(3078,.59),row(3074,.58)],[6333,3078,3074])
});

test('new confirmed equipment upgrades can replan an unstarted target across champions', () => {
  for (const championId of ['Zaahen','MasterYi','Fiora','Riven']) {
    const result=recommend(replanOptions(championId));
    assert.equal(result.item?.id,'3074',championId);
    assert.equal(result.evidence.replanning.status,'changed');
    assert.deepEqual(result.purchasePlan.evaluatedAugmentIds,['game_2140']);
    assert.equal(result.purchaseProgress.status,'building','replanning is not a fabricated purchase');
  }
});

test('a substantial existing recipe finishes first, then its deferred upgrade wins even without item statistics', () => {
  const input=replanOptions(); input.live.items=inventory([3133,2019]);
  let result=recommend(input);
  assert.equal(result.item?.id,'6333');
  assert.equal(result.followUpItem?.id,'3074');
  input.targetAugmentIds=result.purchasePlan.evaluatedAugmentIds;
  input.live.items=inventory([6333]);
  input.recommendationData=source('Zaahen',[row(3078,.61),row(3053,.59),row(6333,.60)],[6333,3078,3053]);
  input.recommendationData.ordinaryAram=reference('aram',['6333','3078','3053'],{championId:'Zaahen'});
  input.recommendationData.referenceStatus='ready';
  result=recommend(input);
  assert.equal(result.item?.id,'3074');
  assert.equal(result.evidence.sampleCount,null,'do not borrow other item statistics');
  assert.equal(result.purchaseProgress.status,'completed');
});

test('a visible urgent physical threat can retain Death Dance, but the upgrade stays next', () => {
  const input=replanOptions(); input.live.teams.enemies=[fedJinx()];
  const result=recommend(input);
  assert.equal(result.item?.id,'6333'); assert.equal(result.followUpItem?.id,'3074');
  assert.equal(result.evidence.replanning.status,'deferred');
});

test('the same owned set, legacy targets and non-equipment confirmations do not unlock an unfinished purchase', () => {
  const input=replanOptions(); input.targetAugmentIds=['game_2140'];
  assert.equal(recommend(input).item?.id,'6333');
  delete input.targetAugmentIds;
  assert.equal(recommend(input).item?.id,'6333','legacy migration retains current purchase');
  input.targetAugmentIds=[]; input.owned=[{id:'plain-gold',name:'金币',description:'获得500金币。'}];
  assert.equal(recommend(input).item?.id,'6333');
});

test('Sheen upgrade chooses a completed spellblade for the hero, and Sheen itself is not completion', () => {
  for (const [championId,expected,order] of [
    ['Zaahen','3078',[6333,3078,3053]],['Ahri','3100',[3157,3100,3089]],['Sion','6662',[3068,6662,3084]]
  ]) {
    const input=options(championId,{owned:[upgrade('upgrade_sheen')],
      recommendationData:source(championId,order.map(id=>row(id)),order)});
    input.live.items=inventory([3057]);
    const result=recommend(input);
    assert.equal(result.item?.id,expected,championId);
    input.live.items=inventory([expected]);
    assert.notEqual(recommend(input).item?.id,expected);
    assert.equal(recommend(input).evidence.augmentPriorities?.length,0,'completed family satisfies the upgrade');
  }
});

test('an already fulfilled upgrade never forces a duplicate or a conflicting Hydra', () => {
  const input=replanOptions(); input.live.items=inventory([3074]);
  assert.equal(recommend(input).item?.id,'6333');
  input.live.items=inventory([3748]);
  const result=recommend(input);
  assert.equal(result.item?.id,'6333'); assert.equal(result.followUpItem,null);
});

test('replanning does not fire from unconfirmed offers or stale inventory, and ordinary ticks lock the new target', () => {
  const input=replanOptions(); input.owned=[]; input.live.offers=[upgrade('game_2140')];
  assert.equal(recommend(input).item?.id,'6333');
  input.owned=[upgrade('game_2140')]; input.live.observedAt=stamp(-10001);
  assert.equal(recommend(input).purchasePlan,undefined);
  input.live.observedAt=stamp(0);
  let result=recommend(input); assert.equal(result.item?.id,'3074');
  input.targetItemId=result.item.id; input.targetAugmentIds=result.purchasePlan.evaluatedAugmentIds;
  input.live.teams.enemies=[fedJinx()]; input.live.items=inventory([1036]);
  result=recommend(input); assert.equal(result.item?.id,'3074');
});

test('all confirmed upgrades persist as priorities when a later unrelated augment is confirmed', () => {
  const input=replanOptions(); input.targetItemId=null;
  input.owned.push({id:'latest-gold',name:'金币奖励',description:'获得500金币。'});
  assert.equal(recommend(input).item?.id,'3074');
});

test('new Hydra upgrade reuses components instead of finishing an exclusive sibling and promising the impossible', () => {
  const input=replanOptions(); input.targetItemId='3748'; input.live.items=inventory([3077,2021]);
  let result=recommend(input);
  assert.equal(result.item?.id,'3074'); assert.equal(result.followUpItem,null);
  delete input.targetAugmentIds;
  result=recommend(input);
  assert.equal(result.item?.id,'3748','legacy commitment stays conservative');
  assert.equal(result.followUpItem,null,'never promise an exclusive purchase after the current item');
});

test('gifted completed equipment satisfies its upgrade without buying another copy', () => {
  const input=options('Lulu',{owned:[upgrade('upgrade_mikaels_blessing')],
    recommendationData:source('Lulu',[row(3222),row(6617),row(3504)],[3222,6617,3504])});
  input.live.items=inventory([3222]);
  const result=recommend(input);
  assert.notEqual(result.item?.id,'3222'); assert.equal(result.evidence.augmentPriorities?.length,0);
});

test('trusted newly confirmed condition evidence can replan beyond named equipment upgrades', () => {
  const augment={id:'condition-replan',gameDataId:7009,name:'已确认的机制变化',description:'获得30攻击力。'};
  const input=options('MasterYi',{owned:[augment],augments:[augment],targetItemId:'3153',targetAugmentIds:[],
    recommendationData:source('MasterYi',yiRows(),null,[{id:7009,rows:[row(6333,.6)],order:null}])});
  const result=recommend(input);
  assert.equal(result.item?.id,'6333'); assert.equal(result.evidence.conditionAugmentId,augment.id);
});

test('a real gold-only confirmation with missing cohort cannot release a target when the enemy changes', () => {
  const input=replanOptions('Zaahen','donation'); input.targetItemId='3078'; input.live.teams.enemies=[fedJinx()];
  assert.equal(recommend(input).item?.id,'3078');
});

test('offensive anti-health bonuses do not masquerade as immediate defensive urgency', () => {
  const input=replanOptions('MasterYi'); input.targetItemId='3153';
  input.live.teams.enemies=['Ornn','Sion','Chogath','DrMundo'].map(id=>enemy(id,[3084]));
  assert.equal(recommend(input).item?.id,'3074');
});

for (const status of ['missing','stale','small-sample']) test(`a ${status} conditional cohort can replan once its real samples arrive`, () => {
  const augment={id:'later-condition',gameDataId:7009,name:'已确认机制',description:'获得30攻击力。'};
  const input=options('MasterYi',{owned:[augment],augments:[augment],targetItemId:'3153',targetAugmentIds:[],
    recommendationData:source('MasterYi',yiRows(),null,status === 'small-sample' ? [{id:7009,rows:[row(6333,.6,10)],order:null}] : [])});
  if (status === 'stale') input.recommendationData.mayhemStatus='stale';
  const pending=recommend(input);
  assert.equal(pending.item?.id,'3153'); assert.deepEqual(pending.purchasePlan.evaluatedAugmentIds,[]);
  input.targetAugmentIds=pending.purchasePlan.evaluatedAugmentIds;
  input.recommendationData=source('MasterYi',yiRows(),null,[{id:7009,rows:[row(6333,.6)],order:null}]);
  input.recommendationData.ordinaryAram=reference('aram',['3153','3124','6333']); input.recommendationData.referenceStatus='ready';
  const result=recommend(input);
  assert.equal(result.item?.id,'6333'); assert.deepEqual(result.purchasePlan.evaluatedAugmentIds,[augment.id]);
});

test('every catalog hero uses the same upgrade replanning path and preserves the new purchase across component ticks', () => {
  const upgrades=data.augments.filter(a=>/^(?:升级|强化)[:：]/.test(a.name) && a.id!=='snowball_upgrade');
  for (const champion of data.champions) for (const augment of upgrades) {
    const input=options(champion.id,{owned:[augment],recommendationData:source(champion.id,
      [row(3153),row(3089),row(3084)],[3153,3089,3084])});
    const first=recommend(input);
    assert.equal(first.status,'ready',`${champion.id}/${augment.id}`);
    const definition=itemsCatalog.data[first.item.id];
    assert.equal(definition.gold.purchasable,true);
    assert.equal(definition.maps['12'],true);
    input.targetItemId=first.item.id; input.targetAugmentIds=first.purchasePlan.evaluatedAugmentIds;
    input.live.items=inventory(definition.from || []);
    const held=recommend(input);
    assert.equal(held.item?.id,first.item.id,`${champion.id}/${augment.id}: components do not complete target`);
    assert.equal(held.purchaseProgress.status,'building');
  }
});

test('a refreshed statistical damage affinity cannot hide a still-purchasable committed item', () => {
  const input=options('Katarina',{recommendationData:source('Katarina',[row(3153,.60),row(6333,.59),row(3072,.58)],[3153,6333,3072])});
  input.recommendationData.ordinaryAram=reference('aram',['3115','4633','3089'],{championId:'Katarina'});
  assert.equal(recommend(input).item.id,'3153');
  input.targetItemId='3153';
  const changed=options('Katarina',{recommendationData:source('Katarina',[row(3115,.60),row(4633,.59),row(3089,.58)],[3115,4633,3089])});
  input.recommendationData=changed.recommendationData;
  assert.notEqual(recommend({...input,targetItemId:null}).item.id,'3153');
  assert.equal(recommend(input).item.id,'3153');
  assert.equal(recommend(input).evidence.sampleCount,null);
});

test('hard conflicts and full slots wait without silently replacing an unfinished target', () => {
  const input=options('MasterYi',{targetItemId:'3153'});
  input.owned=[{id:'noattack',name:'禁止普攻',description:'你无法进行普通攻击。'}];
  let result=recommend(input);
  assert.equal(result.item,null); assert.equal(result.evidence.status,'target-incompatible');
  assert.equal(result.purchaseProgress.status,'building');
  input.owned=[]; input.live.items=inventory([1052,1052,1052,1052,1052,1052]);
  result=recommend(input);
  assert.equal(result.status,'inventory-full'); assert.equal(result.item,null);
  assert.equal(result.purchaseProgress.status,'building');
  input.live.items=inventory([3124,6333,3091,3072,3006,6672]);
  assert.equal(recommend(input).status,'inventory-full','six different finished items do not prove target completion');
});

test('zero quantity and sufficient gold do not finish a target; its verified transformation does', () => {
  const input=options('MasterYi',{targetItemId:'6333'});
  input.live.items=[{id:6333,count:0}]; input.live.currentGold=20000;
  assert.equal(recommend(input).item.id,'6333');
  const custom=structuredClone(itemsCatalog);
  custom.data['99999']={...custom.data['6333'],id:'99999',from:['6333'],gold:{total:4000,purchasable:false}};
  input.itemsCatalog=custom; input.live.items=inventory([99999]);
  const result=recommend(input);
  assert.equal(result.purchaseProgress.status,'completed');
  assert.notEqual(result.item?.id,'6333');
});

test('magic performance promotes a compatible MR item, without claiming actual damage shares', () => {
  const input = options('MasterYi',{recommendationData:source('MasterYi',[row(3124,.60),row(3156,.599),row(6333,.58)],null)});
  input.live.teams.enemies = [enemy('Ahri',[3089,4645],{level:13,performance:{kills:16,deaths:1,assists:9}})];
  const result = recommend(input);
  assert.equal(result.item.id,'3156'); assert.equal(result.evidence.threatChampionId,'Ahri');
  assert.match(result.evidence.limitations.join(' '),/未读取敌方实际伤害占比/);
});

test('unknown enemy damage evidence dilutes team tendencies without hiding an individually observed AP threat', () => {
  const input=options('Rakan',{recommendationData:source('Rakan',[row(3190,.60)],null)});
  input.recommendationData.ordinaryAram=reference('aram',['3190','3050','6617'],{championId:'Rakan'});
  // Actual catalog tags classify Cho as magic but leave Ornn and Sion's
  // damage direction unknown; their tank roles are not a damage inference.
  input.live.teams.enemies=[enemy('Ornn'),enemy('Sion'),enemy('Chogath')];
  const unknown=recommend(input);
  assert.equal(unknown.item.id,'3190'); assert.equal(unknown.evidence.opponentCount,3);
  assert.equal(unknown.evidence.contextBonus,0); assert.equal(unknown.evidence.threatChampionId,null);
  assert.doesNotMatch(unknown.reason,/偏魔法|偏物理/);
  // Two explicitly classified magic champions out of three retain a bounded
  // composition adjustment, with no claim to measured damage percentages.
  input.live.teams.enemies=[enemy('Ornn'),enemy('Ahri'),enemy('Chogath')];
  const known=recommend(input);
  assert.equal(known.item.id,'3190'); assert.equal(known.evidence.contextBonus,6);
  assert.match(known.reason,/偏魔法/); assert.equal(known.evidence.threatChampionId,null);
  // Read AP equipment and valid performance can still identify one specific
  // threat even when the hero has no broad magic tag and others are unknown.
  input.live.teams.enemies=[enemy('Ornn'),enemy('Sion',[3089,4645],
    {level:13,performance:{kills:18,deaths:1,assists:8}})];
  const geared=recommend(input);
  assert.equal(geared.evidence.contextBonus,16); assert.equal(geared.evidence.threatChampionId,'Sion');
  assert.match(geared.reason,/魔法机制/);
});

test('high kills cannot always replace a much stronger empirical direction', () => {
  const input = options('MasterYi',{recommendationData:source('MasterYi',[row(3124,.80),row(6333,.40)],null)});
  input.live.teams.enemies = [fedJinx()];
  assert.equal(recommend(input).item.id,'3124');
});

test('a late-item win-rate outlier does not erase a published purchase sequence', () => {
  const input = options('MasterYi',{recommendationData:source('MasterYi',[row(3153,.46),row(3124,.55),row(6333,.99)],[3153,3124,6333])});
  assert.equal(recommend(input).item.id,'3153');
});

test('duplicate enemy records count once and malformed performance never creates a fed threat', () => {
  const input = options(); input.live.items = inventory([3153]);
  const duplicates = enemy('Ornn',[3084]); input.live.teams.enemies = [duplicates,duplicates,duplicates];
  assert.equal(recommend(input).evidence.frontlineCount,1);
  for (const performance of [{kills:'18',deaths:0,assists:[]},{kills:1001,deaths:-1,assists:Infinity},[],null]) {
    input.live.teams.enemies = [{...fedJinx(),performance}];
    const result = recommend(input);
    assert.equal(result.item.id,'3124'); assert.equal(result.evidence.threatChampionId,null);
  }
});

test('expired enemy observations drop adaptations while fresh own data retains purchase guidance', () => {
  const input = options(); input.live.items = inventory([3153]); input.live.teams.enemies = [fedJinx()];
  input.live.teams.observedAt = stamp(-10001);
  const result = recommend(input);
  assert.equal(result.status,'ready'); assert.equal(result.item.id,'3124'); assert.equal(result.evidence.enemyStatus,'stale');
  assert.equal(result.evidence.contextBonus,0); assert.equal(result.evidence.performanceObserved,false);
});

test('latest confirmed condition changes empirical direction while retaining earlier hard constraints', () => {
  const first = {id:'first',gameDataId:7001,name:'旧的限制',description:'你的伤害不能暴击。'};
  const second = {id:'second',gameDataId:7002,name:'新的选择',description:'获得30攻击力。'};
  const entry = source('MasterYi',yiRows(),[3153,3124,6333],[{id:7001,rows:[row(3153,.6)],order:null},
    {id:7002,rows:[row(3031,.9),row(6333,.6)],order:null}]);
  const input = options('MasterYi',{recommendationData:entry,owned:[first],augments:[...data.augments,first,second]});
  assert.equal(recommend(input).item.id,'3153');
  input.owned.push(second);
  const result = recommend(input);
  assert.equal(result.item.id,'6333'); assert.equal(result.evidence.conditionAugmentId,'second');
  assert.match(result.evidence.conditionNote,/不代表联合条件胜率/); assert.equal(result.evidence.scope,'champion-single-augment');
});

test('all confirmed no-attack constraints filter on-hit items without banning reactive armor', () => {
  const first = {id:'noattack',gameDataId:7001,name:'禁止普攻',description:'你无法进行普通攻击。'};
  const second = {id:'ad',gameDataId:7002,name:'数值',description:'获得30攻击力。'};
  const input = options('MasterYi',{owned:[first,second],augments:[first,second],recommendationData:source('MasterYi',yiRows(),null,
    [{id:7002,rows:[row(3153,.8),row(3075,.6),row(6333,.59)],order:null}])});
  assert.equal(recommend(input).item.id,'3075');
});

test('confirmed attribute conversion permits corresponding off-role item direction', () => {
  const choice = {id:'convert',gameDataId:7003,name:'攻击转化',description:'将你的法术强度转化为攻击力。'};
  const input = options('Ahri',{owned:[choice],augments:[choice],recommendationData:source('Ahri',[],null,
    [{id:7003,rows:[row(6333,.6)],order:null}])});
  assert.equal(recommend(input).item.id,'6333');
});

test('unconfirmed live augments and OCR offers never select a condition', () => {
  const input = options(); input.live.augments = {status:'detected',ids:['proposal']}; input.live.offers = [{id:'proposal'}];
  assert.equal(recommend(input).evidence.conditionAugmentId,null);
  assert.equal(recommend(input).evidence.scope,'champion-filtered-items');
});

test('missing conditional data remains explicit and does not reuse unconditional win rate', () => {
  const input = options('MasterYi',{owned:[{id:'missing',gameDataId:7999,name:'缺样本',description:'获得20攻击力。'}]});
  const result = recommend(input);
  assert.equal(result.evidence.scope,'mechanism-fallback'); assert.equal(result.evidence.status,'condition-missing');
  assert.equal(result.evidence.sampleCount,null); assert.equal(result.evidence.winRate,null);
  assert.deepEqual(result.evidence.modeWeights,{mayhem:0,aram:0,summonersRift:0}); assert.match(result.reason,/条件样本暂缺/);
});

test('reference-only repository ready never becomes a Mayhem or blended statistic', () => {
  const entry = source(); entry.snapshot = null; entry.mayhemStatus = 'error'; entry.referenceStatus = 'ready';
  entry.ordinaryAram = reference('aram',['6333','3153','3124'],{items:[row(6333,.9)]});
  const result = recommend(options('MasterYi',{recommendationData:entry}));
  assert.equal(result.evidence.scope,'mechanism-fallback'); assert.equal(result.evidence.source,'catalog-mechanisms');
  assert.equal(result.evidence.sampleCount,null); assert.equal(result.evidence.modeWeights.mayhem,0);
});

test('invalid or stale whole-game context never publishes a next item', () => {
  for (const change of [
    input=>{input.live.championId='Ahri';},input=>{input.live.gameId=null;},input=>{input.live.gameId='0';},
    input=>{input.live.mode.isMayhem=false;},input=>{input.live.mode.known=false;},input=>{input.live.connection.status='waiting';},
    input=>{input.live.championSource='loading-screen';},input=>{input.live.gameTime=-1;},input=>{input.live.phase='Lobby';},
    input=>{input.live.observedAt=stamp(-10001);},input=>{input.live.observedAt=stamp(5001);},
    input=>{input.plan={gameId:'other-match'};},input=>{input.plan={championId:'Ahri'};},
  ]) { const input=options();change(input);assert.equal(recommend(input).item,null); }
  assert.equal(recommend().status,'waiting');
});

test('loading ignores previous inventory, owned choices, performance and route', () => {
  const input = options(); Object.assign(input.live,{stage:'loading',phase:'GameStart',championSource:'loading-screen'});
  input.live.teams.source='loading-roster'; input.live.teams.enemies=[fedJinx()];
  input.live.items=inventory([3153,3124,6333]); input.owned=[{id:'old',description:'你无法进行普通攻击。'}]; input.route='spell';
  const result = recommend(input);
  assert.equal(result.stage,'loading-preview'); assert.equal(result.item.id,'3153');
  assert.equal(result.evidence.conditionAugmentId,null); assert.equal(result.evidence.performanceObserved,false);
});

test('six completed items are complete; six blocked slots require a consumable recipe component', () => {
  const input = options(); input.live.items=inventory([3153,3124,6333,3091,3072,3006]);
  assert.equal(recommend(input).status,'complete');
  input.live.items=inventory([1036,1036,1036,1036,1036,1036]);
  input.recommendationData=options('MasterYi',{recommendationData:source('MasterYi',[row(3153,.6)],null)}).recommendationData;
  assert.equal(recommend(input).status,'ready','Long Swords are usable recipe components');
  input.live.items=inventory([1052,1052,1052,1052,1052,1052]);
  assert.equal(recommend(input).status,'inventory-full');
});

test('recipe progress consumes each held component at most once and breaks ties', () => {
  const input = options('Ahri',{recommendationData:source('Ahri',[row(3089,.6),row(3102,.6)],null)});
  input.live.items=inventory([1058]);
  const result=recommend(input);
  assert.ok(result.evidence.recipeValue <= itemsCatalog.data['1058'].gold.total);
  const custom=structuredClone(itemsCatalog); custom.data['3089'].from=['1058','1058'];
  input.itemsCatalog=custom; input.recommendationData=options('Ahri',{recommendationData:source('Ahri',[row(3089,.6)],null)}).recommendationData;
  assert.equal(recommend(input).evidence.recipeValue,1200);
});

test('upgraded ancestors, duplicate finished boots, exclusive families and components are excluded', () => {
  const input=options('MasterYi',{recommendationData:source('MasterYi',[row(3156,.7),row(3047,.69),row(1029,.8),row(6333,.6)],null)});
  input.live.items=inventory([3053,3006]); assert.equal(recommend(input).item.id,'6333');
  const custom=structuredClone(itemsCatalog); custom.data['99999']={...custom.data['6333'],id:'99999',from:['6333']};
  input.itemsCatalog=custom; input.live.items=inventory([99999]);
  input.recommendationData=options('MasterYi',{recommendationData:source('MasterYi',[row(6333,.9),row(3153,.6)],null)}).recommendationData;
  assert.equal(recommend(input).item.id,'3153');
});

test('shop restrictions filter champion-only, non-purchasable, off-map and consumable candidates', () => {
  for (const changes of [{requiredChampion:'Ahri'},{gold:{...itemsCatalog.data['3153'].gold,purchasable:false}},
    {maps:{12:false}},{tags:['Consumable']},{tags:['Trinket']},{inStore:false}]) {
    const catalog=structuredClone(itemsCatalog);Object.assign(catalog.data['3153'],changes);
    const result=recommend(options('MasterYi',{itemsCatalog:catalog,recommendationData:source('MasterYi',[row(3153,.8),row(6333,.6)],null)}));
    assert.equal(result.item.id,'6333');
  }
});

test('unordered item sets and unverified slots do not become a purchase order', () => {
  const entry=source(); entry.snapshot.detail.builds.filtered.archetypes[0].profiles[0].routes=[];
  entry.snapshot.detail.items.filtered.slots={'1':[row(6333,.9)]};
  const result=recommend(options('MasterYi',{recommendationData:entry}));
  assert.equal(result.item.id,'3153'); assert.deepEqual(result.evidence.purchaseOrder,[]);
});

const reference = (mode='aram',items=['3124','3153','6333'],extra={}) => ({mode,championId:'MasterYi',patch:'16.21',comparable:true,
  source:'OP.GG',sourceUrl:'https://op.gg/lol/modes/aram/masteryi/items?patch=16.21',observedAt:stamp(0),items:[],
  buildOrders:[{items,sampleCount:1200,winRate:.56,orderKind:'core-item-sequence'}],...extra});

test('verified reference core sequence changes the next item independently of Mayhem item ranks', () => {
  const input=options('MasterYi',{recommendationData:source('MasterYi',[row(3153,.58),row(3124,.58),row(6333,.58)])}); assert.equal(recommend(input).item.id,'3153');
  input.recommendationData.referenceStatus='ready'; input.recommendationData.ordinaryAram=reference();
  const result=recommend(input);
  assert.equal(result.item.id,'3124'); assert.equal(result.evidence.orderReference.mode,'aram');
  assert.deepEqual(result.evidence.purchaseOrder,['3124','3153','6333']);
  assert.equal(result.evidence.sampleCount,1000); assert.equal(result.evidence.orderReference.sampleCount,1200);
  assert.equal(result.evidence.winRate,.58); assert.equal(result.evidence.orderReference.winRate,.56);
  assert.match(result.reason,/顺序参考 OP.GG 普通 ARAM/);
  input.live.items=inventory([3124]); assert.equal(recommend(input).item.id,'3153');
});

test('ordinary ARAM order is preferred, with separate Rift order fallback when ARAM has no compatible sequence', () => {
  const input=options('MasterYi',{recommendationData:source('MasterYi',[row(3153,.58),row(3124,.58),row(6333,.58)])}); input.recommendationData.referenceStatus='ready';
  input.recommendationData.ordinaryAram=reference();
  input.recommendationData.summonersRift=reference('summoners-rift',['6333','3153','3124']);
  assert.equal(recommend(input).item.id,'3124');
  input.recommendationData.ordinaryAram.buildOrders=[];
  const result=recommend(input); assert.equal(result.item.id,'6333'); assert.equal(result.evidence.orderReference.mode,'summoners-rift');
  input.recommendationData.summonersRift=null;
  input.recommendationData.orderReference=reference('summoners-rift',['6333','3153','3124']);
  input.recommendationData.orderReferenceStatus='ready';
  assert.equal(recommend(input).item.id,'6333');
});

test('reference orders reject wrong hero, patch, source, mode, age, kind and malformed rows', () => {
  for (const change of [
    ref=>{ref.championId='Ahri';},ref=>{ref.patch='16.20';},ref=>{ref.source='unknown';},ref=>{ref.mode='summoners-rift';},
    ref=>{ref.observedAt=stamp(-86400001);},ref=>{ref.observedAt=stamp(5001);},ref=>{ref.comparable=false;},
    ref=>{ref.buildOrders[0].orderKind='item-set';},ref=>{ref.buildOrders[0].sampleCount=199;},
    ref=>{ref.buildOrders[0].items=['3124','3124','6333'];},ref=>{ref.buildOrders[0].winRate=Infinity;},
  ]) {
    const input=options(); input.recommendationData.referenceStatus='ready'; input.recommendationData.ordinaryAram=reference();
    change(input.recommendationData.ordinaryAram);
    const result=recommend(input); assert.equal(result.item,null); assert.equal(result.evidence.orderStatus,'unavailable');
    assert.equal(result.status,'waiting'); assert.equal(result.stage,'live'); assert.match(result.message,/等待可核验/);
  }
});

test('reference sequence never overrides all confirmed compatibility restrictions or invents Mayhem samples', () => {
  const choice={id:'noattack',gameDataId:7001,name:'禁止普攻',description:'你无法进行普通攻击。获得20攻击力。'};
  const input=options('MasterYi',{owned:[choice],augments:[choice],recommendationData:source('MasterYi',[],null,
    [{id:7001,rows:[row(3153,.7),row(3124,.65),row(6333,.6)],order:null}])});
  input.recommendationData.referenceStatus='ready';input.recommendationData.ordinaryAram=reference();
  assert.equal(recommend(input).item.id,'6333');
  input.recommendationData.snapshot=null;input.recommendationData.mayhemStatus='error';
  const result=recommend(input);
  assert.equal(result.item.id,'6333'); assert.equal(result.evidence.scope,'mechanism-fallback');
  assert.equal(result.evidence.sampleCount,null);assert.equal(result.evidence.orderReference.sampleCount,1200);
  assert.equal(result.evidence.modeWeights.mayhem,0);
});

test('missing reference order waits in the current stage instead of fabricating a purchase sequence', () => {
  const input=options(); input.recommendationData.ordinaryAram.buildOrders=[];
  const result=recommend(input);
  assert.equal(result.status,'waiting'); assert.equal(result.stage,'live'); assert.equal(result.item,null);
  assert.equal(result.evidence.status,'order-data-pending'); assert.equal(result.evidence.mayhemStatus,'ready');
  Object.assign(input.live,{stage:'loading',phase:'GameStart',championSource:'loading-screen'});
  input.live.teams.source='loading-roster';
  assert.equal(recommend(input).stage,'loading-preview');
});

test('completed reference core permits later empirical items without inventing an observed fourth purchase', () => {
  const input=options('MasterYi',{recommendationData:source('MasterYi',[row(6333,.6),row(3156,.59)],null)});
  input.recommendationData.ordinaryAram=reference('aram',['3153','3124','6676']);
  input.live.items=inventory([3153,3124,6676]);
  const result=recommend(input);
  assert.equal(result.status,'ready'); assert.equal(result.item.id,'6333');
  assert.equal(result.evidence.orderReference.completedCore,true);
  assert.equal(result.evidence.orderReference.disposition,'completed-core');
  assert.deepEqual(result.evidence.purchaseOrder,[]); assert.equal(result.evidence.purchaseOrderSource,null);
  assert.match(result.reason,/来源未提供第四件顺序/);
});

test('published sequence alternatives adapt to current opponents and confirmed cohorts instead of locking the most popular order', () => {
  // Small regression excerpt of the 16.21 public aggregate observations checked
  // on 2026-10-27. This is not a replay of the provider's entire item population.
  const baseline=[row(6333,.5854,459761),row(3031,.5738,778455),row(6676,.5694,1092930),
    row(3153,.5567,824773),row(3124,.5536,247110),row(3091,.5496,175233)];
  const conditional=[row(6333,.6171,18384),row(3124,.6124,12697),row(3153,.5982,31159),
    row(3091,.6024,7640),row(6676,.5931,32255),row(3031,.5858,22378)];
  const choice=data.augments.find(augment=>Number(augment.gameDataId)===3116);
  const input=options('MasterYi',{recommendationData:source('MasterYi',baseline,null,[{id:3116,rows:conditional,order:null}])});
  input.recommendationData.ordinaryAram=reference('aram',['6676','3153','3031']);
  input.recommendationData.ordinaryAram.buildOrders=[
    {items:['6676','3153','3031'],sampleCount:2474,winRate:.582053354890865,orderKind:'core-item-sequence'},
    {items:['3153','6676','3031'],sampleCount:292,winRate:.6095890410958904,orderKind:'core-item-sequence'},
    {items:['3153','3124','3091'],sampleCount:260,winRate:.5923076923076923,orderKind:'core-item-sequence'},
  ];
  assert.equal(recommend(input).item.id,'6676');
  input.live.teams.enemies=[enemy('Ornn',[3084]),enemy('Sion',[3083]),enemy('Chogath',[3084])];
  const tanks=recommend(input);
  assert.equal(tanks.item.id,'3153'); assert.equal(tanks.evidence.orderReference.items[0],'3153');
  assert.equal(tanks.evidence.orderReference.sampleCount,292);
  input.live.teams.enemies=[];input.owned=[choice];
  const selected=recommend(input);
  assert.equal(selected.item.id,'3153'); assert.equal(selected.evidence.conditionAugmentId,choice.id);
  assert.equal(selected.evidence.scope,'champion-single-augment');
});

test('all 173 catalog heroes can retain their own coherent empirical core without champion-ID routing', () => {
  assert.equal(data.champions.length,173);
  for (const champion of data.champions) {
    // A synthetic source-contract audit, not a claim these cores are optimal
    // for every hero. Direction is supplied per hero, never borrowed across IDs.
    const roles=champion.roles || [];
    const ids=roles.includes('法师') ? [6653,3089,3135] : roles.includes('射手') ? [6676,3153,3031]
      : roles.includes('辅助') ? [6620,6617,3504] : roles.includes('坦克') ? [3068,3143,4401] : [6692,3071,6333];
    const input=options(champion.id,{recommendationData:source(champion.id,ids.map(id=>row(id,.60)),ids)});
    const result=recommend(input);
    assert.equal(result.status,'ready',champion.id); assert.equal(result.item.id,String(ids[0]),champion.id);
    assert.equal(result.evidence.scope,'champion-filtered-items',champion.id);
    assert.equal(result.evidence.source,'ARAMKit',champion.id);
    assert.equal(result.evidence.sampleCount,1000,champion.id);
  }
});

test('missing broad damage tags cannot erase observed assassin, bruiser, AP attacker or enchanter cores', () => {
  for (const [championId,ids] of [['Zed',[6692,3142,6694]],['Pantheon',[6692,3071,6333]],
    ['Nasus',[3078,3053,6333]],['Gwen',[3115,4633,3089]],['Rakan',[6620,6617,3504]]]) {
    const result=recommend(options(championId,{recommendationData:source(championId,ids.map(id=>row(id,.60)),ids)}));
    assert.equal(result.status,'ready',championId); assert.equal(result.item.id,String(ids[0]),championId);
    assert.equal(result.evidence.scope,'champion-filtered-items',championId);
    assert.equal(result.evidence.affinitySource,'hero-mechanisms-and-observed-cores',championId);
  }
});

test('tank and enchanter can adapt through compatible resistance and allied shield effects', () => {
  for (const [championId,ids,expected] of [['Ornn',[3068,4401,3143],'4401'],['Rakan',[6617,3190,6620],'3190']]) {
    const input=options(championId,{recommendationData:source(championId,ids.map((id,i)=>row(id,.60-i*.001)),null)});
    input.recommendationData.ordinaryAram=reference('aram',ids.map(String),{championId});
    input.recommendationData.ordinaryAram.buildOrders.push({items:[String(ids[1]),String(ids[0]),String(ids[2])],
      sampleCount:500,winRate:.59,orderKind:'core-item-sequence'});
    input.live.teams.enemies=[enemy('Ahri',[3089,4645],{level:13,performance:{kills:18,deaths:1,assists:8}})];
    const result=recommend(input);
    assert.equal(result.item.id,expected,championId); assert.ok(!['6333','3153'].includes(result.item.id));
    assert.equal(result.evidence.threatChampionId,'Ahri'); assert.match(result.reason,/魔法机制/);
  }
});

test('support ally-triggered attack buffs remain useful when the holder cannot attack', () => {
  const choice={id:'noattack-support',gameDataId:9001,name:'禁止普攻',description:'你无法进行普通攻击。'};
  const input=options('Rakan',{owned:[choice],augments:[choice],recommendationData:source('Rakan',[],null,
    [{id:9001,rows:[row(3504,.60),row(6617,.59),row(6620,.58)],order:[3504,6617,6620]}])});
  input.recommendationData.ordinaryAram=reference('aram',['3504','6617','6620'],{championId:'Rakan'});
  assert.equal(recommend(input).item.id,'3504');
});

test('quest-only reward items are never purchasable targets even when catalog flags or cohort rows say purchasable', () => {
  const cases=[['MasterYi',226668,2141,3153],['Ornn',223069,1361,4401],['Ahri',228002,1156,3135]];
  for (const [championId,reward,augmentNumber,normal] of cases) {
    const choice=data.augments.find(augment=>Number(augment.gameDataId)===augmentNumber);
    assert.ok(choice,String(augmentNumber));
    for (const owned of [[],[choice]]) {
      const rows=[row(reward,.99),row(normal,.58)];
      const input=options(championId,{owned,augments:data.augments,recommendationData:source(championId,rows,null,
        [{id:augmentNumber,rows,order:null}])});
      const result=recommend(input);
      if (!owned.length) assert.equal(result.item.id,String(normal),`${championId}:no quest`);
      else {
        const quest=result.questPlans[0];
        assert.equal(quest.rewardId,String(reward));
        assert.ok(quest.ingredients.some(item=>item.id===result.item.id));
      }
      assert.notEqual(result.item.id,String(reward),'a reward itself never becomes a shop target');
      assert.equal(result.evidence.itemRulesVersion,'16.21');
    }
  }
});

test('unselected Golden Spatula cannot leak from its Mayhem statistics into a purchase target', () => {
  const input=options('MasterYi',{recommendationData:source('MasterYi',[row(994403,.99)],null)});
  assert.notEqual(recommend(input).item?.id,'994403');
});

test('held quest transformations satisfy consumed components without recommending them again', () => {
  for (const [championId,reward,consumed,next] of [['MasterYi',226668,[3074,6698,3748],3153],
    ['Ornn',223069,[3068,6664],4401],['Ahri',228002,[3089,3157],3135]]) {
    const ids=[...consumed,next],input=options(championId,{recommendationData:source(championId,ids.map(id=>row(id,.6)),null)});
    input.live.items=inventory([reward]);
    assert.equal(recommend(input).item.id,String(next),championId);
  }
});

test('the verified three-Hydra quest exempts only its required items from the normal exclusive family', () => {
  const choice=data.augments.find(augment=>Number(augment.gameDataId)===2141);
  const rows=[row(6698,.60),row(3748,.59),row(6333,.58)];
  const input=options('MasterYi',{recommendationData:source('MasterYi',rows,null,[{id:2141,rows,order:null}])});
  input.live.items=inventory([3074]);
  assert.equal(recommend(input).item.id,'6333');
  input.owned=[choice];input.recommendationData.ordinaryAram=reference('aram',['3074','6698','3748']);
  assert.equal(recommend(input).item.id,'6698');
});

test('source champion, mode and confirmed condition remain isolated across role changes', () => {
  const input=options('Zed',{recommendationData:source('Zed',[row(6692,.60),row(3142,.59),row(6694,.58)],[6692,3142,6694])});
  const zed=recommend(input);assert.equal(zed.evidence.source,'ARAMKit');
  input.champion=hero('Ahri'); input.live=live('Ahri');
  assert.equal(recommend(input).status,'waiting','Zed reference orders cannot serve Ahri');
  input.recommendationData.ordinaryAram=reference('aram',['6653','3089','3135'],{championId:'Ahri'});
  const wrongPrimary=recommend(input);
  assert.equal(wrongPrimary.evidence.scope,'mechanism-fallback'); assert.equal(wrongPrimary.evidence.sampleCount,null);
  assert.equal(wrongPrimary.evidence.conditionAugmentId,null);
  input.recommendationData.ordinaryAram.mode='summoners-rift';
  assert.equal(recommend(input).status,'waiting','wrong-mode placement cannot be relabeled ARAM');
});

test('holder-health damage is not mistaken for a percentage enemy-health counter', () => {
  const input=options('MasterYi',{recommendationData:source('MasterYi',[row(3084,.60),row(3153,.599),row(6333,.58)],null)});
  input.live.teams.enemies=[enemy('Ornn',[3084]),enemy('Sion',[3083]),enemy('Chogath',[3084])];
  assert.equal(recommend(input).item.id,'3153');
});

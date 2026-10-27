import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildLivePlan} from '../dist/adaptive.js';
import {buildNextItemRecommendation as recommend, isPurchaseTarget} from '../server/next-item.mjs';
import {QUEST_ITEM_RULES, buildItemQuestPlans, questRewardRule} from '../dist/item-acquisition.js';

const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const now=Date.parse('2026-10-27T10:00:00Z'), stamp=new Date(now).toISOString();
const quest=id=>data.augments.find(a=>a.id===id);
const inventory=ids=>ids.map(id=>({id,count:1}));
function input(owned=[],items=[],championId='MasterYi') {
  return {champion:data.champions.find(c=>c.id===championId),champions:data.champions,augments:data.augments,owned,itemsCatalog,now,
    live:{connection:{status:'connected'},phase:'InProgress',stage:'live',championSource:'live-client',championId,gameId:'quest-game',
      mode:{known:true,isMayhem:true},gameTime:500,observedAt:stamp,items:inventory(items),stats:{},
      teams:{status:'detected',source:'live-client',observedAt:stamp,allies:[],enemies:[]}}};
}
function statistics(ids) {
  const rows=ids.map(id=>({id:Number(id),winRate:.99,sampleCount:1500}));
  return {championId:'MasterYi',sourceChampionId:11,patch:'16.21',status:'ready',mayhemStatus:'ready',referenceStatus:'ready',snapshot:{
    championId:11,meta:{patch:'16.21',dataDate:'2026-10-25',sourceUrl:'https://aramkit.com/',dataPath:'data/16.21-test'},
    detail:{champion:{id:11},items:{filtered:{all:rows}},builds:{filtered:{archetypes:[]}},augments:{all:[]},augmentCombinations:[]},single:{items:[],builds:[]}},
    ordinaryAram:{mode:'aram',championId:'MasterYi',patch:'16.21',comparable:true,source:'OP.GG',observedAt:stamp,
      sourceUrl:'https://op.gg/lol/modes/aram/masteryi/items',items:[],buildOrders:[{items:['3153','3124','6333'],sampleCount:1000,winRate:.58,orderKind:'core-item-sequence'}]}};
}

test('reward rules bind to real current quest augments and all known reward variants',()=>{
  for(const rule of QUEST_ITEM_RULES) {
    assert.equal(Number(quest(rule.augmentId)?.gameDataId),rule.gameDataId);
    assert.match(quest(rule.augmentId).description,/任务/);
    for(const id of [...rule.rewardIds,...rule.ingredients]) assert.ok(itemsCatalog.data[id],id);
    for(const id of rule.rewardIds) {
      assert.equal(questRewardRule(id),rule);
      assert.equal(isPurchaseTarget(id,data.champions[0],itemsCatalog),false);
    }
  }
  assert.equal(questRewardRule('3153'),null);
});

test('both plans reject unselected quest rewards even with dominant public statistics',()=>{
  for(const rule of QUEST_ITEM_RULES) {
    const args=input(); args.recommendationData=statistics([rule.rewardId]);
    const full=buildLivePlan(args), compact=recommend(args);
    assert.equal(full.buildItems.some(i=>questRewardRule(i.id)),false);
    assert.equal(full.choices.flatMap(c=>c.items).some(i=>questRewardRule(i.id)),false);
    assert.equal(questRewardRule(compact.item?.id),null);
    assert.equal(full.questPlans,undefined); assert.equal(compact.questPlans,undefined);
    args.live.augments={status:'detected',ids:[rule.augmentId]};
    args.live.offers=[quest(rule.augmentId)];
    assert.equal(buildLivePlan(args).questPlans,undefined,'raw offers are not confirmed ownership');
  }
});

test('an augment mentioning Witchcap in its text does not unlock the Witchcap task',()=>{
  const args=input([quest('upgrade_zhonyas')]);
  assert.equal(recommend(args).questPlans,undefined);
  assert.equal(buildLivePlan(args).questPlans,undefined);
});

test('confirmed recipes show their reward only as a task and buy each missing complete ingredient',()=>{
  for(const rule of QUEST_ITEM_RULES.filter(r=>r.kind==='recipe')) {
    const args=input([quest(rule.augmentId)]), held=[];
    for(let step=0;step<rule.ingredients.length;step++) {
      let result=recommend(args);
      assert.equal(result.status,'ready',rule.augmentId);
      assert.ok(rule.ingredients.includes(result.item.id)); assert.ok(!held.includes(result.item.id));
      assert.equal(result.evidence.scope,'confirmed-quest');
      assert.equal(result.evidence.sampleCount,null,'task route is not a measured win rate');
      assert.equal(result.evidence.orderStatus,'unavailable','missing reference data is not invented');
      assert.equal(result.questPlans[0].status,'building');
      for(const itemId of rule.ingredients) assert.ok(result.reason.includes(itemsCatalog.data[itemId].name));
      const full=buildLivePlan(args), card=full.buildItems.find(item=>item.id===rule.rewardId);
      assert.ok(card); assert.equal(card.evidenceKind,'confirmed-quest'); assert.match(card.effect,/不能直接购买/);
      args.targetItemId=result.item.id;
      args.live.items=inventory([...held,...itemsCatalog.data[result.item.id].from]);
      assert.equal(recommend(args).item.id,result.item.id,'all components still do not complete an ingredient');
      held.push(result.item.id); args.live.items=inventory(held);
    }
    const waiting=recommend(args);
    assert.equal(waiting.status,'waiting'); assert.equal(waiting.item,null);
    assert.equal(waiting.questPlans[0].status,'awaiting-reward');
    assert.equal(waiting.purchaseProgress.status,'completed');
    args.targetItemId=null; args.live.items=inventory([rule.rewardId]);
    const earned=recommend(args);
    assert.equal(earned.questPlans[0].status,'earned');
    assert.equal(buildLivePlan(args).buildItems.some(item=>item.id===rule.rewardId),false);
  }
});

test('Urf quest exposes no fake recipe or takedown progress and keeps ordinary shopping available',()=>{
  const rule=QUEST_ITEM_RULES.find(r=>r.kind==='takedowns'), args=input([quest(rule.augmentId)]);
  args.recommendationData=statistics(['3153','3124','6333',rule.rewardId]);
  args.live.teams.allies=[{championId:'MasterYi',performance:{kills:40,assists:50}}];
  const result=recommend(args), plan=result.questPlans[0];
  assert.equal(result.status,'ready'); assert.equal(questRewardRule(result.item.id),null);
  assert.deepEqual(plan.ingredients,[]); assert.match(plan.routeText,/无购买配方/);
  assert.equal(plan.status,'building','total KDA is not since-selection quest progress');
  for(const rewardId of rule.rewardIds) {
    args.live.items=inventory([rewardId]);
    assert.equal(recommend(args).questPlans[0].status,'earned');
  }
});

test('a previously committed ordinary purchase finishes before starting the new quest route',()=>{
  const args=input([quest('ultra_hydra')]); args.targetItemId='3153';
  args.recommendationData=statistics(['3153','3124','6333']);
  let result=recommend(args);
  assert.equal(result.item.id,'3153'); assert.match(result.reason,/贪欲九头蛇/);
  args.live.items=inventory([3153]); result=recommend(args);
  assert.ok(['3074','6698','3748'].includes(result.item.id));
});

test('hard mechanisms still block quest ingredients; full slots never turn components into completed quest rewards',()=>{
  const args=input([quest('ultra_hydra'),{id:'cannot-attack',description:'你无法进行普通攻击。'}]);
  assert.equal(recommend(args).status,'waiting');
  assert.equal(recommend(args).evidence.status,'quest-ingredient-incompatible');
  args.owned=[quest('ultra_hydra')]; args.live.items=inventory([1052,1052,1052,1052,1052,1052]);
  assert.equal(recommend(args).status,'inventory-full');
  assert.equal(recommend(args).questPlans[0].status,'building');
});

test('loading, stale game data and manual quest removal cannot expose a stale quest route',()=>{
  const args=input([quest('quest_wooglets_witchcap')]);
  assert.ok(recommend(args).questPlans);
  args.live.observedAt=new Date(now-10001).toISOString();
  assert.equal(recommend(args).questPlans,undefined);
  args.live.observedAt=stamp; args.owned=[];
  assert.equal(recommend(args).questPlans,undefined);
  args.owned=[quest('quest_wooglets_witchcap')];
  Object.assign(args.live,{stage:'loading',phase:'GameStart',championSource:'loading-screen'});args.live.teams.source='loading-roster';
  assert.equal(recommend(args).questPlans,undefined); assert.equal(buildLivePlan(args).questPlans,undefined);
});

test('the full task card never confirms ownership from stale, foreign, disconnected or malformed inventory',()=>{
  const args=input([quest('quest_wooglets_witchcap')],['228002']);
  assert.equal(buildLivePlan(args).questPlans[0].status,'earned');
  for(const patch of [{observedAt:new Date(now-10001).toISOString()},{gameId:null},{championId:'Ahri'},
    {phase:'Reconnect'},{connection:{status:'waiting'}},{items:null}]) {
    const changed={...args,live:{...args.live,...patch}};
    const plan=buildLivePlan(changed);
    assert.equal(plan.questPlans[0].status,'unobserved');
    assert.ok(plan.buildItems.some(i=>i.id==='228002'),'static task requirements remain visible without completion claims');
    assert.equal(plan.questPlans[0].ingredients.some(i=>i.owned),false);
  }
  for(const count of [0,-1,1.5,'1',100]) {
    args.live.items=[{id:228002,count}];
    assert.equal(buildLivePlan(args).questPlans[0].status,'building');
    assert.equal(recommend(args).questPlans[0].status,'building');
  }
});

test('multiple quests preserve selection order and do not conflate distinct rewards',()=>{
  const owned=[quest('quest_wooglets_witchcap'),quest('ultra_hydra'),quest('quest_urfs_champion')];
  const args=input(owned,['228002']);
  const result=recommend(args);
  assert.deepEqual(result.questPlans.map(q=>q.status),['earned','building','building']);
  assert.ok(['3074','6698','3748'].includes(result.item.id));
  const duplicated=buildItemQuestPlans({owned:[...owned,...owned],catalog:new Map(Object.entries(itemsCatalog.data))});
  assert.equal(duplicated.length,3);
});

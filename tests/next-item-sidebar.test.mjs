import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar} from '../server/sidebar.mjs';
import {buildLivePlan} from '../dist/adaptive.js';
import {buildChampionIndex, snapshotFromLive} from '../server/collector.mjs';

const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const eligible=data.augments.filter(a=>a.availability==='current' && a.recommendable!==false && !a.retiredPatch && !a.isInternalTemplate);
const choice=eligible.find(a=>Number.isSafeInteger(Number(a.gameDataId)) && Number(a.gameDataId)>0);
const rows=ids=>ids.map((id,index)=>({id,winRate:.60-index*.01,sampleCount:1200}));
function setup(t, dataDirectory) {
  let clock=Date.parse('2026-10-27T06:00:00Z');
  let live={connection:{status:'connected'},phase:'InProgress',stage:'live',championSource:'live-client',
    championId:'MasterYi',gameId:'next-item-game',gameTime:600,level:11,items:[],stats:{},
    mode:{known:true,isMayhem:true},augments:{status:'unavailable',ids:[]},observedAt:new Date(clock).toISOString(),
    teams:{status:'detected',observedAt:new Date(clock).toISOString(),allies:[],enemies:[]}};
  const recommendationData={championId:'MasterYi',sourceChampionId:11,patch:'16.21',status:'ready',mayhemStatus:'ready',referenceStatus:'ready',
    snapshot:{championId:11,meta:{patch:'16.21',dataDate:'2026-10-25',sourceUrl:'https://aramkit.com/',dataPath:'data/16.21-test'},
      detail:{champion:{id:11},items:{filtered:{all:rows([3153,3124,6333])}},builds:{filtered:{archetypes:[]}},augments:{all:[]},augmentCombinations:[]},
      single:{items:[{augmentId:Number(choice.gameDataId),all:rows([6333,3153,3124])}],builds:[]}},
    ordinaryAram:{mode:'aram',championId:'MasterYi',patch:'16.21',comparable:true,source:'OP.GG',
      sourceUrl:'https://op.gg/lol/modes/aram/masteryi/build',observedAt:new Date(clock).toISOString(),ordersContractVersion:1,
      items:rows([3153,3124,6333]),buildOrders:[{items:['3153','3124','6333'],sampleCount:1200,winRate:.58,orderKind:'core-item-sequence'}]}};
  const collector={getSnapshot:()=>structuredClone(live)};
  const repository={get:id=>id==='MasterYi'?structuredClone(recommendationData):null,ensure:async()=>{},close:async()=>{}};
  const sidebar=new BackgroundSidebar({collector,data,itemsCatalog,dataDirectory,recommendationRepository:repository,now:()=>clock});
  t.after(()=>sidebar.stop());
  return {sidebar,collector,repository,recommendationData,now:()=>clock,update:patch=>{live={...live,...patch};},advance:ms=>{clock+=ms;}};
}
const context=model=>({gameId:model.gameId,gameEpoch:model.gameEpoch,sessionRevision:model.sessionRevision,
  championId:model.champion.id,ownedIds:model.owned.map(a=>a.id),route:model.route});

test('compact recommendation is additive and preserves the full application plan',t=>{
  const s=setup(t), model=s.sidebar.getModel();
  assert.equal(model.nextItem.status,'ready');
  for(const [key,value] of Object.entries(context(model))) assert.deepEqual(model.nextItem[key],value,key);
  const full=buildLivePlan({champion:s.sidebar.champions.get('MasterYi'),owned:[],route:'auto',live:s.collector.getSnapshot(),
    augments:[...s.sidebar.augments.values()],champions:[...s.sidebar.champions.values()],itemsCatalog,
    recommendationData:s.repository.get('MasterYi'),policy:{},now:s.now()});
  for(const [key,value] of Object.entries(full)) assert.deepEqual(model.plan[key],value,key);
  assert.ok(Array.isArray(model.plan.buildItems));
  assert.equal(Object.hasOwn(s.sidebar.recognitionSnapshot(s.collector.getSnapshot()),'nextItem'),false);
});

test('only confirmed selections alter condition evidence and route/context follows each revision',async t=>{
  const s=setup(t), initial=s.sidebar.getModel();
  s.sidebar.pendingOffers.accept(eligible.slice(0,3).map(a=>a.id),{lifecycle:1,offerCycle:1,captureRevision:1,now:s.now()});
  let model=s.sidebar.getModel();
  assert.equal(model.offers.length,3,'full app still receives three candidates');
  assert.deepEqual(model.nextItem,initial.nextItem,'unselected OCR candidates cannot influence purchase decision');
  await s.sidebar.setSession({owned:[choice.id],route:'attack'});
  model=s.sidebar.getModel();
  assert.equal(model.nextItem.evidence.conditionAugmentId,choice.id);
  assert.deepEqual(model.nextItem.ownedIds,[choice.id]);
  assert.equal(model.nextItem.route,'attack');
  assert.equal(model.nextItem.sessionRevision,model.sessionRevision);
  assert.ok(model.sessionRevision>initial.sessionRevision);
  await s.sidebar.setSession({owned:[choice.id],route:'tank'});
  model=s.sidebar.getModel();
  assert.equal(model.nextItem.route,'tank');
  assert.equal(model.nextItem.sessionRevision,model.sessionRevision);
});

test('current inventory immediately changes next item while stale or disconnected data cannot retain it',t=>{
  const s=setup(t), first=s.sidebar.getModel().nextItem;
  assert.equal(first.status,'ready');
  s.update({items:[{id:Number(first.item.id),count:1}]});
  let model=s.sidebar.getModel();
  assert.equal(model.nextItem.status,'ready');
  assert.notEqual(model.nextItem.item.id,first.item.id);
  s.advance(10001);
  model=s.sidebar.getModel();
  assert.equal(model.nextItem.status,'stale'); assert.equal(model.nextItem.item,null);
  s.update({connection:{status:'waiting'},observedAt:new Date(s.now()).toISOString()});
  model=s.sidebar.getModel();
  assert.equal(model.nextItem.status,'waiting'); assert.equal(model.nextItem.item,null);
});

test('a new match clears old choices and raw missing identity never borrows the retained session identity',async t=>{
  const s=setup(t);
  await s.sidebar.setSession({owned:[choice.id],route:'attack'});
  const old=s.sidebar.getModel();
  s.update({gameId:null});
  let model=s.sidebar.getModel();
  assert.equal(model.nextItem.item,null);
  s.update({gameId:'next-item-game-2',gameTime:10});
  model=s.sidebar.getModel();
  assert.deepEqual(model.nextItem.ownedIds,[]); assert.equal(model.nextItem.route,'auto');
  assert.equal(model.nextItem.gameId,'next-item-game-2');
  assert.ok(model.nextItem.gameEpoch>old.nextItem.gameEpoch);
  assert.equal(model.nextItem.evidence.conditionAugmentId,null);
});

function promoteArmor(s) {
  s.recommendationData.snapshot.detail.items.filtered.all=rows([6333,3124,3153]);
  s.recommendationData.ordinaryAram.items=rows([6333,3124,3153]);
  s.recommendationData.ordinaryAram.buildOrders[0].items=['6333','3124','3153'];
}

test('the shared sidebar holds its target through components, unrelated purchases and updated statistics',t=>{
  const s=setup(t);
  assert.equal(s.sidebar.getModel().nextItem.item.id,'3153');
  promoteArmor(s);
  for (const items of [[],[{id:1036,count:1}],[{id:3144,count:1},{id:1043,count:1},{id:1037,count:1}],
    [{id:3006,count:1},{id:3124,count:1}]]) {
    s.update({items,currentGold:10000});
    assert.equal(s.sidebar.getModel().nextItem.item.id,'3153');
  }
  s.update({items:[{id:3153,count:1}]});
  assert.equal(s.sidebar.getModel().nextItem.item.id,'6333','only the completed target releases the next purchase');
});

test('stale completion and disconnection preserve intent; fresh completion advances it',t=>{
  const s=setup(t);
  s.sidebar.getModel(); promoteArmor(s);
  s.advance(10001); s.update({items:[{id:3153,count:1}]});
  assert.equal(s.sidebar.getModel().nextItem.status,'stale');
  assert.equal(s.sidebar.purchaseTarget.itemId,'3153');
  s.update({connection:{status:'waiting'},observedAt:new Date(s.now()).toISOString()});
  assert.equal(s.sidebar.getModel().nextItem.item,null);
  s.update({connection:{status:'connected'},items:[{id:1036,count:1}]});
  assert.equal(s.sidebar.getModel().nextItem.item.id,'3153');
  s.update({items:[{id:3153,count:1}]});
  assert.equal(s.sidebar.getModel().nextItem.item.id,'6333');
});

test('raw collector inventory cannot turn zero or malformed counts into completed purchases',t=>{
  const s=setup(t); s.sidebar.getModel(); promoteArmor(s);
  const index=buildChampionIndex(data.champions);
  const raw={activePlayer:{riotId:'local#fixture',level:11,championStats:{}},gameData:{gameTime:600,gameMode:'KIWI'},
    allPlayers:[{riotId:'local#fixture',rawChampionName:'game_character_displayname_MasterYi',team:'ORDER',items:[]}]};
  for (const count of [0,-1,0.5,100,'1',false]) {
    raw.allPlayers[0].items=[{itemID:3153,count}];
    s.update(snapshotFromLive(raw,{index,now:new Date(s.now()),lcu:{gameId:'next-item-game'}}));
    assert.equal(s.sidebar.getModel().nextItem.item.id,'3153');
  }
  raw.allPlayers[0].items=[{itemID:3153,count:1}];
  s.update(snapshotFromLive(raw,{index,now:new Date(s.now()),lcu:{gameId:'next-item-game'}}));
  assert.equal(s.sidebar.getModel().nextItem.item.id,'6333');
});

test('a completed target is cleared even while reference data is unavailable',t=>{
  const s=setup(t); s.sidebar.getModel();
  s.recommendationData.referenceStatus='error';
  s.update({items:[{id:3153,count:1}]});
  assert.equal(s.sidebar.getModel().nextItem.status,'waiting');
  assert.equal(s.sidebar.purchaseTarget,null);
});

test('loading preview does not commit, while new matches and clock resets discard prior targets',t=>{
  const s=setup(t), original=s.collector.getSnapshot();
  s.update({stage:'loading',phase:'GameStart',championSource:'loading-screen',teams:{...original.teams,source:'loading-roster'}});
  assert.equal(s.sidebar.getModel().nextItem.stage,'loading-preview');
  assert.equal(s.sidebar.purchaseTarget,null);
  s.update(original); assert.equal(s.sidebar.getModel().nextItem.item.id,'3153');
  promoteArmor(s);
  s.update({gameTime:5}); assert.equal(s.sidebar.getModel().nextItem.item.id,'6333');
  s.recommendationData.ordinaryAram.buildOrders[0].items=['3124','6333','3153'];
  s.recommendationData.snapshot.detail.items.filtered.all=rows([3124,6333,3153]);
  s.update({gameId:'a-new-game'}); assert.equal(s.sidebar.getModel().nextItem.item.id,'3124');
});

test('purchase intent restores in the same game; malformed or component targets do not restore',async t=>{
  const root=process.env.HEXGUIDE_TEST_WORK || path.resolve('H:/Chatgpt/work/2026-10-27/hexguide-purchase-completion/test-work');
  await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'target-'));
  const s=setup(t,directory);
  t.after(async()=>{await s.sidebar.stop();await rm(directory,{recursive:true,force:true});});
  s.sidebar.getModel(); await s.sidebar.persistTail;
  const saved=JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.deepEqual(saved.purchaseTarget,{championId:'MasterYi',itemId:'3153'});
  promoteArmor(s);
  const restore=async()=>new BackgroundSidebar({collector:s.collector,data,itemsCatalog,dataDirectory:directory,recommendationRepository:s.repository,now:s.now}).load();
  const restored=await restore();
  assert.equal(restored.getModel().nextItem.item.id,'3153'); await restored.stop();
  const original=s.collector.getSnapshot();
  s.update({stage:'loading',phase:'GameStart',championSource:'loading-screen',teams:{...original.teams,source:'loading-roster'}});
  const recovering=await restore();
  assert.equal(recovering.getModel().nextItem.stage,'loading-preview');
  assert.equal(recovering.purchaseTarget.itemId,'3153','same-game startup roster is not proof of a new purchase plan');
  s.update(original);
  assert.equal(recovering.getModel().nextItem.item.id,'3153'); await recovering.stop();
  for (const purchaseTarget of [null,{championId:'unknown',itemId:'3153'},{championId:'MasterYi',itemId:'1036'},
    {championId:'MasterYi',itemId:'99999999'},{championId:'MasterYi',itemId:3153},{championId:'MasterYi',itemId:'994403'}]) {
    await writeFile(path.join(directory,'session.json'),JSON.stringify({...saved,purchaseTarget}));
    const invalid=await restore();
    assert.equal(invalid.purchaseTarget,null); await invalid.stop();
  }
});

test('confirmed quest routing uses the shared session and preserves purchase completion across every ingredient',async t=>{
  const s=setup(t); assert.equal(s.sidebar.getModel().nextItem.item.id,'3153');
  await s.sidebar.setSession({owned:['ultra_hydra'],route:'auto'});
  assert.equal(s.sidebar.getModel().nextItem.item.id,'3153');
  const held=[3153]; s.update({items:held.map(id=>({id,count:1}))});
  for(let step=0;step<3;step++) {
    const model=s.sidebar.getModel(), id=model.nextItem.item.id;
    assert.ok(['3074','6698','3748'].includes(id));
    assert.equal(s.sidebar.purchaseTarget.itemId,id);
    assert.equal(model.plan.questPlans[0].rewardId,model.nextItem.questPlans[0].rewardId);
    assert.deepEqual(model.nextItem.ownedIds,['ultra_hydra']);
    s.update({items:[...held,...itemsCatalog.data[id].from].map(id=>({id,count:1}))});
    assert.equal(s.sidebar.getModel().nextItem.item.id,id);
    held.push(Number(id));s.update({items:held.map(id=>({id,count:1}))});
  }
  assert.equal(s.sidebar.getModel().nextItem.questPlans[0].status,'awaiting-reward');
  assert.equal(s.sidebar.purchaseTarget,null);
  s.update({items:[{id:3153,count:1},{id:226668,count:1}]});
  assert.equal(s.sidebar.getModel().nextItem.questPlans[0].status,'earned');
  await s.sidebar.setSession({owned:[],route:'auto'});
  assert.equal(s.sidebar.getModel().nextItem.questPlans,undefined);
});

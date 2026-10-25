import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar} from '../server/sidebar.mjs';

const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const selected=data.augments.find(augment=>augment.id==='goliath');
const second=data.augments.find(augment=>augment.id==='jeweled_gauntlet') || data.augments.find(augment=>augment.id==='jeweled_bracelet');
const now=Date.parse('2026-10-25T03:00:00Z');
function setup(extra={}) {
  const state={live:{gameId:'test-game',phase:'InProgress',stage:'live',championId:'Ahri',championSource:'live-client',
    connection:{status:'connected'},mode:{known:true,isMayhem:true,queueId:2400},gameTime:120,level:6,
    observedAt:new Date(now).toISOString(),augments:{status:'unavailable',ids:[]},
    teams:{status:'detected',source:'live-client',allies:[{championId:'Ahri'}],enemies:[{championId:'Jinx'},{championId:'Ashe'}],observedAt:new Date(now).toISOString()}}};
  const snapshot={championId:103,meta:{patch:'16.21',dataPath:'data/16.21-test'},detail:{champion:{id:103},items:{filtered:{all:[]}},
    augments:{all:[{id:Number(second.gameDataId),sampleCount:1000,winRate:.61,pickRate:.2}]},augmentCombinations:[]},
    single:{items:[{augmentId:Number(selected.gameDataId),all:[{id:3089,sampleCount:1000,winRate:.61}]}],builds:[]}};
  let calls=0;
  const repo={get:id=>({championId:id,patch:'16.21',status:'ready',snapshot,augmentStatistics:{}}),ensure:async()=>{calls++;},close:async()=>{}};
  const sidebar=new BackgroundSidebar({collector:{getSnapshot:()=>state.live},data,itemsCatalog,now:()=>now,recommendationRepository:repo,...extra});
  return {sidebar,state,repo,getCalls:()=>calls};
}

test('manual state and explicit detected selected IDs produce the same immediate guarded recommendation', async()=>{
  const manual=setup(), observed=setup();
  await manual.sidebar.setSession({owned:[selected.id],route:'auto'});
  observed.state.live.augments={status:'detected',ids:[selected.id]};
  const a=manual.sidebar.getModel(),b=observed.sidebar.getModel();
  assert.deepEqual(a.plan.buildItems,b.plan.buildItems);
  assert.deepEqual(a.plan.nextAugments,b.plan.nextAugments);
  assert.equal(b.plan.statistics.conditionAugmentId,selected.id);
  assert.ok(b.plan.buildItems.some(item=>item.evidenceKind==='aggregate-statistics'));
  assert.deepEqual(b.plan.ownedIds,[selected.id]);
  assert.equal(b.plan.sessionRevision,b.sessionRevision); assert.equal(b.plan.gameEpoch,b.gameEpoch);
  assert.equal(b.plan.gameId,b.gameId); assert.equal(b.plan.championId,'Ahri');
  assert.ok(observed.getCalls()>0);
  const revision=b.sessionRevision;
  assert.equal(observed.sidebar.getModel().sessionRevision,revision,'repeated snapshot cannot append twice');
});

test('unavailable, empty, unknown, stale or loading observations never infer actual choices',()=>{
  const cases=[{augments:{status:'unavailable',ids:[selected.id]}},{augments:{status:'detected',ids:[]}},
    {augments:{status:'detected',ids:[selected.id,'unknown']}},
    {observedAt:new Date(now-11000).toISOString(),augments:{status:'detected',ids:[selected.id]}},
    {stage:'loading',phase:'GameStart',championSource:'loading-screen',augments:{status:'detected',ids:[selected.id]}}];
  for(const change of cases){const h=setup();Object.assign(h.state.live,change);assert.deepEqual(h.sidebar.getModel().owned,[]);}
});

test('manual correction wins over later source snapshots and persists across helper restarts',async t=>{
  const base=path.resolve('H:/Chatgpt/work/2026-10-25/hexguide-build-policy/state-tests');await mkdir(base,{recursive:true});
  const directory=await mkdtemp(path.join(base,'case-'));
  t.after(async()=>{const resolved=path.resolve(directory);assert.ok(resolved.startsWith(base+path.sep));await rm(resolved,{recursive:true,force:true});});
  const h=setup({dataDirectory:directory});await h.sidebar.load();
  h.state.live.augments={status:'detected',ids:[selected.id]};assert.equal(h.sidebar.getModel().owned[0].id,selected.id);
  await h.sidebar.setSession({owned:[],route:'auto'});
  h.state.live.augments={status:'detected',ids:[selected.id,second.id]};
  assert.deepEqual(h.sidebar.getModel().owned,[]);
  await h.sidebar.stop();
  const again=setup({dataDirectory:directory});again.state.live=h.state.live;await again.sidebar.load();
  assert.deepEqual(again.sidebar.getModel().owned,[]);
  const disk=JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.deepEqual(disk.selectionSources,{manualBarrier:true});
  again.state.live={...again.state.live,gameId:'next-game'};
  assert.deepEqual(again.sidebar.getModel().owned.map(a=>a.id),[selected.id,second.id],'new game resets the manual snapshot barrier');
  await again.sidebar.stop();
});

test('empty or temporarily unavailable selected snapshots retain previously confirmed choices',()=>{
  const h=setup();h.state.live.augments={status:'detected',ids:[selected.id]};h.sidebar.getModel();
  h.state.live.augments={status:'detected',ids:[]};assert.deepEqual(h.sidebar.getModel().owned.map(a=>a.id),[selected.id]);
  h.state.live.augments={status:'unavailable',ids:[]};assert.deepEqual(h.sidebar.getModel().owned.map(a=>a.id),[selected.id]);
});

test('manual choices take precedence over a differing source snapshot; only an ordered extension can add a new result',async()=>{
  const h=setup();await h.sidebar.setSession({owned:[selected.id],route:'auto'});
  h.state.live.augments={status:'detected',ids:[second.id]};
  assert.deepEqual(h.sidebar.getModel().owned.map(a=>a.id),[selected.id]);
  h.state.live.augments={status:'detected',ids:[selected.id,second.id]};
  assert.deepEqual(h.sidebar.getModel().owned.map(a=>a.id),[selected.id,second.id]);
});

test('new game and new champion cannot reuse another hero condition plan or offer authority',()=>{
  const h=setup();h.state.live.augments={status:'detected',ids:[selected.id]};const old=h.sidebar.getModel();
  h.state.live={...h.state.live,gameId:'next-game',championId:'Jinx',augments:{status:'unavailable',ids:[]}};
  const next=h.sidebar.getModel();
  assert.deepEqual(next.owned,[]);assert.equal(next.plan.gameId,'next-game');assert.equal(next.plan.championId,'Jinx');
  assert.notEqual(next.plan.gameEpoch,old.plan.gameEpoch);assert.equal(next.plan.statistics.conditionAugmentId,null);
});

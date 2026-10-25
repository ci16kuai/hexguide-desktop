import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getStaticAugmentStatistics, selectBuildEvidence, mixBuildItemEvidence} from '../dist/build-evidence.js';
import {buildLivePlan} from '../dist/adaptive.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const hero = data.champions.find(hero => hero.id === 'Ahri');
const choices = [
  {id:'test-one',gameDataId:101,name:'测试选择一',description:'你的技能可以造成暴击。',availability:'current'},
  {id:'test-two',gameDataId:102,name:'测试选择二',description:'获得100攻击力。',availability:'current'}
];
const entry = () => ({championId:'Ahri',status:'ready',patch:'16.21',augmentStatistics:{},snapshot:{championId:103,
  meta:{patch:'16.21',dataPath:'data/16.21-test',sourceUrl:'https://aramkit.com/',dataDate:'2026-10-24'},
  detail:{champion:{id:103},items:{filtered:{all:[{id:3089,winRate:.56,sampleCount:900},{id:3157,winRate:.54,sampleCount:900}]}},
    builds:{filtered:{archetypes:[]}},augments:{all:[{id:101,winRate:.55,sampleCount:900,pickRate:.1},{id:102,winRate:.63,sampleCount:900,pickRate:.2}]},
    augmentCombinations:[{augmentIds:[101,102],winRate:.61,sampleCount:500}]},
  single:{items:[{augmentId:101,all:[{id:3137,winRate:.7,sampleCount:800},{id:3089,winRate:.6,sampleCount:1000}]},
    {augmentId:102,all:[{id:3157,winRate:.59,sampleCount:800}]}],builds:[]}}});

test('static evidence uses original counts, cohort and source low sample rule without old pick rates', () => {
  const s={meta:{mode:'aram-mayhem',patch:'16.21',cohortId:'a',lowSampleThreshold:3000},champions:[{championId:'Ahri',cohortId:'a',augments:[
    {augmentId:'ok',cohortId:'a',wins:2000,games:4000,winRate:99,pickRate:99},
    {augmentId:'low',cohortId:'a',wins:190,games:200},
    {augmentId:'pbe',cohortId:'pbe',wins:4000,games:5000,provisional:true},
    {augmentId:'invalid',cohortId:'a',wins:5001,games:5000}]}]};
  const r=getStaticAugmentStatistics(s,'Ahri');
  assert.equal(r.ok.winRate,.5); assert.equal(r.ok.comparable,true); assert.equal(r.ok.pickRate,null);
  assert.equal(r.low.comparable,false); assert.equal(r.pbe.comparable,false); assert.equal(r.invalid,undefined);
  assert.deepEqual(Object.keys(getStaticAugmentStatistics({...s,meta:{...s.meta,mode:'aram'}},'Ahri')),[]);
});

test('loading gets unconditioned filtered data and confirming picks selects the matching single condition', () => {
  const source=entry();
  const before=selectBuildEvidence(source,{champion:hero,augments:choices});
  const one=selectBuildEvidence(source,{champion:hero,augments:choices,owned:[choices[0]]});
  const two=selectBuildEvidence(source,{champion:hero,augments:choices,owned:choices});
  assert.equal(before.scope,'champion-filtered-items'); assert.equal(before.items[0].id,'3089');
  assert.equal(one.scope,'champion-single-augment'); assert.equal(one.items[0].id,'3137');
  assert.equal(one.pairs[0].augmentId,'test-two'); assert.equal(two.items[0].id,'3157');
  assert.equal(two.conditionAugmentId,'test-two'); assert.match(two.conditionNote,/不代表联合条件胜率/);
  assert.equal(before.augmentStatistics['test-one'].winRate,.55);
});

test('missing hero augment condition and mismatched source never masquerade as a conditional build', () => {
  const missing=selectBuildEvidence(entry(),{champion:hero,owned:[{id:'missing',gameDataId:999}],augments:choices});
  assert.equal(missing.status,'condition-missing'); assert.deepEqual(missing.items,[]);
  assert.deepEqual(selectBuildEvidence({...entry(),patch:'16.20'}, {champion:hero,patch:'16.20'}).items,[]);
  assert.deepEqual(selectBuildEvidence({...entry(),championId:'Jinx'},{champion:hero}).items,[]);
});

test('80:20 blends per-mode rank scores while preserving each observed win rate', () => {
  const primary={items:[{id:1,winRate:.6,sampleCount:1000},{id:2,winRate:.55,sampleCount:1000}],source:'ARAMKit',scope:'champion-single-augment'};
  const aram={mode:'aram',patch:'16.21',comparable:true,source:'OP.GG',items:[{id:1,winRate:.45,sampleCount:900},{id:2,winRate:.65,sampleCount:900}]};
  const r=mixBuildItemEvidence(primary,{ordinaryAram:aram});
  assert.deepEqual(r.effectiveWeights,{mayhem:.8,aram:.2,summonersRift:0});
  assert.equal(r.items[0].id,'1'); assert.equal(r.items[0].recommendationScore,.8);
  assert.equal(r.items[0].evidence.mayhem.winRate,.6); assert.equal(r.items[0].evidence.secondary.winRate,.45);
  assert.equal(r.mixedWinRate,null);
});

test('fallback preference is ARAM, then Summoners Rift, then Mayhem only; no primary means no false blend', () => {
  const primary={items:[{id:3089,winRate:.6,sampleCount:500}]};
  const secondary={patch:'16.21',comparable:true,source:'OP.GG',items:[{id:3089,winRate:.6,sampleCount:500}]};
  const aram={...secondary,mode:'aram'}, rift={...secondary,mode:'summoners-rift'};
  assert.equal(mixBuildItemEvidence(primary,{ordinaryAram:aram,summonersRift:rift}).secondaryMode,'aram');
  assert.equal(mixBuildItemEvidence(primary,{ordinaryAram:{...aram,patch:'16.20'},summonersRift:rift}).secondaryMode,'summoners-rift');
  assert.deepEqual(mixBuildItemEvidence(primary,{}).effectiveWeights,{mayhem:1,aram:0,summonersRift:0});
  assert.deepEqual(mixBuildItemEvidence({items:[]},{ordinaryAram:aram}).effectiveWeights,{mayhem:0,aram:0,summonersRift:0});
  assert.deepEqual(mixBuildItemEvidence(primary,{ordinaryAram:{...aram,items:[{id:999,winRate:.7,sampleCount:800}]}}).effectiveWeights,{mayhem:1,aram:0,summonersRift:0});
  assert.deepEqual(mixBuildItemEvidence({items:[{id:1,winRate:.99,sampleCount:1}]},{}).items,[]);
});

test('an unobserved auxiliary item is unknown, not zero performance or a penalty', () => {
  const primary={items:Array.from({length:10},(_,i)=>({id:i+1,winRate:.6-i*.01,sampleCount:1000}))};
  const secondary={mode:'aram',patch:'16.21',comparable:true,source:'OP.GG',items:[{id:2,winRate:.65,sampleCount:900}]};
  const result=mixBuildItemEvidence(primary,{ordinaryAram:secondary});
  assert.equal(result.items[0].id,'1');
  assert.deepEqual(result.items[0].effectiveWeights,{mayhem:1,aram:0,summonersRift:0});
  assert.equal(result.items[0].evidence.secondary,null);
  assert.deepEqual(result.coverage,{mayhemItems:10,comparableItems:1,mayhemOnlyItems:9});
  assert.match(result.summary,/缺同装备辅助样本/);
});

test('expired primary snapshots are kept out of statistical builds', () => {
  const stale=selectBuildEvidence({...entry(),mayhemStatus:'stale'},{champion:hero,augments:choices});
  assert.equal(stale.status,'stale');assert.deepEqual(stale.items,[]);
  const refreshing=selectBuildEvidence({...entry(),mayhemStatus:'loading'},{champion:hero,augments:choices});
  assert.equal(refreshing.status,'loading');assert.deepEqual(refreshing.items,[]);
});

const now=Date.parse('2026-10-25T03:00:00Z');
const live={connection:{status:'connected'},gameId:'test-game',phase:'GameStart',stage:'loading',championId:'Ahri',championSource:'loading-screen',
  mode:{known:true,isMayhem:true},teams:{status:'detected',source:'loading-roster',observedAt:new Date(now).toISOString(),
    allies:[{championId:'Ahri'},{championId:'Ornn'}],enemies:[{championId:'Jinx'},{championId:'Ashe'},{championId:'Caitlyn'}]}};
const plan = (snapshot=live,owned=[]) => buildLivePlan({champion:hero,champions:data.champions,owned,augments:choices,itemsCatalog,
  recommendationData:entry(),live:snapshot,now});

test('loading returns allies and lineup armor options but no future augments or prior selections', () => {
  const r=plan(live,choices);
  assert.equal(r.stage,'loading-preview'); assert.deepEqual(r.nextAugments,[]);
  assert.deepEqual(r.allyContext.champions.map(row=>row.id),['Ahri','Ornn']);
  assert.ok(r.buildItems.some(row=>row.id==='3157'));
  assert.ok(r.buildItems.some(row=>row.evidenceKind==='aggregate-statistics'));
  assert.equal(r.statistics.conditionAugmentId,null);
  assert.doesNotMatch(r.summary,/海克斯/);
});

test('confirmed changes immediately update condition equipment and future statistical ranking without mixing selected states', () => {
  const snapshot={...live,phase:'InProgress',stage:'live',championSource:'live-client',level:7,gameTime:190,teams:{...live.teams,source:'live-client',enemies:[]}};
  const one=plan(snapshot,[choices[0]]), two=plan(snapshot,choices);
  assert.equal(one.statistics.conditionAugmentId,'test-one'); assert.equal(two.statistics.conditionAugmentId,'test-two');
  assert.ok(one.buildItems.some(row=>row.id==='3089')); assert.ok(two.buildItems.some(row=>row.id==='3157'));
  assert.equal(one.nextAugments[0].id,'test-two'); assert.equal(one.nextAugments[0].rankingEvidence.winRate,.63);
  assert.equal(two.nextAugments.length,0);
});

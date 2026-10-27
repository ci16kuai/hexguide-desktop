import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../dist/live.js',import.meta.url),'utf8');
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const makePlan=(label,stage='live')=>({stage,label,title:label,summary:label,context:[],choices:[],buildItems:[{id:'1001',name:label+'-ITEM',effect:'fixture effect'}],nextAugments:[{id:'future',name:label+'-FUTURE',reason:'fixture direction'}],enemyContext:{status:'detected',source:stage==='loading-preview'?'loading-roster':'live-client',champions:[{id:'Garen',name:'盖伦'}],signals:[],summary:'fixture roster'},allyContext:{status:'detected',champions:[{id:'Ahri',name:'阿狸'}]},statistics:{summary:'统计来源说明：隔离测试'}});

async function harness({alterModel,stage='live'}={}){
  let now=Date.now(),sampleCalls=0,localCalls=0;
  let session={gameId:'game-one',gameEpoch:3,revision:7,owned:[],route:'auto'};
  let owned=[];
  let live={connection:{status:'connected',message:'fixture'},phase:stage==='loading'?'GameStart':'InProgress',stage,gameId:'game-one',championId:'Ahri',championSource:stage==='loading'?'loading-screen':'live-client',gameTime:stage==='loading'?null:12,mode:{known:true,isMayhem:true},stats:{},items:[],teams:{status:'detected',enemies:[],allies:[]},observedAt:new Date(now).toISOString()};
  let model={gameId:'game-one',gameEpoch:3,sessionRevision:7,stage,phase:live.phase,champion:{id:'Ahri'},owned:[],route:'auto',updatedAt:new Date(now).toISOString(),ocr:{enabled:true,proposals:[]},plan:{...makePlan('AUTH',stage==='loading'?'loading-preview':'live'),gameId:'game-one',gameEpoch:3,sessionRevision:7,championId:'Ahri',ownedIds:[],route:'auto',generatedAt:new Date(now).toISOString()}};
  if(alterModel)alterModel(model);
  const ticks=[],clicks=[];
  const FakeDate=class extends Date{static now(){return now;}};
  const context=vm.createContext({Date:FakeDate,AbortSignal,console,location:{hash:'#live'},sessionStorage:{getItem:()=> 'fixture-token',setItem(){}},history:{replaceState(){}},shortItemEffect:()=>'',buildLivePlan:options=>{localCalls++;return makePlan('LOCAL',options.live.stage==='loading'?'loading-preview':'live');},
    setInterval:fn=>{ticks.push(fn);return ticks.length;},clearInterval(){},setTimeout,
    window:{addEventListener(){}},document:{addEventListener:(name,fn)=>{if(name==='click')clicks.push(fn);}},
    fetch:async url=>{if(url==='./items.json')return {ok:true,json:async()=>({})};if(url==='/api/live')return {ok:true,json:async()=>structuredClone(live)};if(url==='/api/sidebar'){if(model instanceof Error)throw model;return {ok:true,json:async()=>structuredClone(model)};}throw Error('Unexpected fixture request '+url);}
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function createLiveController','function createLiveController')+'\nthis.createController=createLiveController;',context);
  const controller=context.createController({getChampion:()=>({id:'Ahri',name:'阿狸'}),getChampionById:id=>({id,name:id}),getChampions:()=>[],getAugments:()=>[],getOwned:()=>owned.map(id=>({id,name:id})),getRoute:()=>session.route,getSessionContext:()=>session,getGameId:()=>session.gameId,getBuildExpanded:()=>true,onOffers(){sampleCalls++;},onChampion(){},onNewGame(){owned=[];},onGameId(){},renderLive(){}});
  await settle();
  return {html:()=>controller.html(),offerRanking:ids=>controller.getOfferRanking(ids),async confirmed(){controller.confirmedSelection();await settle();},get localCalls(){return localCalls;},get proposals(){return sampleCalls;},get owned(){return [...owned];},advance:ms=>{now+=ms;},session:update=>{session={...session,...update};},setOwned:update=>{owned=[...update];},model:update=>{model=typeof update==='function'?update(model):update;},live:update=>{live={...live,...update};},async tick(){ticks.forEach(fn=>fn());await settle();},async click(action){clicks.forEach(fn=>fn({target:{closest:()=>({dataset:{liveAction:action}})}}));await settle();}};
}

test('matching desktop plan supplies authoritative equipment and source caption without changing ownership',async()=>{
  const h=await harness();
  assert.match(h.html(),/AUTH-ITEM/);
  assert.match(h.html(),/AUTH-FUTURE/);
  assert.match(h.html(),/live-statistics-source/);
  assert.deepEqual(h.owned,[]);
});

test('task reward cards retain the acquisition route and pending reward explanation',async()=>{
  const h=await harness({alterModel:m=>{m.plan.buildItems=[{id:'228002',name:'沃格勒特的巫师帽',effect:'任务奖励，不能直接购买。',
    evidenceKind:'confirmed-quest',reason:'中娅沙漏 + 灭世者的死亡之帽 → 沃格勒特的巫师帽。前置已齐，等待游戏发放奖励。'}];}});
  assert.match(h.html(),/前置已齐，等待游戏发放奖励/);
  assert.match(h.html(),/任务奖励，不能直接购买/);
});

test('loading authoritative plan still displays only equipment and both rosters',async()=>{
  const h=await harness({stage:'loading'});
  const html=h.html();
  assert.match(html,/AUTH-ITEM/);
  assert.match(html,/我方阵容|敌方阵容/);
  assert.doesNotMatch(html,/AUTH-FUTURE|live-next-augments|live-owned-note|class="ocr-panel"/);
});

test('every mismatched authority boundary falls back instead of using its equipment',async t=>{
  const changes={
    'model game':m=>{m.gameId='another';},'plan game':m=>{m.plan.gameId='another';},
    'model epoch':m=>{m.gameEpoch++;},'plan epoch':m=>{m.plan.gameEpoch++;},
    'model revision':m=>{m.sessionRevision++;},'plan revision':m=>{m.plan.sessionRevision++;},
    'model champion':m=>{m.champion.id='Jinx';},'plan champion':m=>{m.plan.championId='Jinx';},
    'model owned':m=>{m.owned=[{id:'not-selected'}];},'plan owned':m=>{m.plan.ownedIds=['not-selected'];},
    'duplicate owned':m=>{m.plan.ownedIds=['duplicate','duplicate'];},
    'model route':m=>{m.route='attack';},'plan route':m=>{m.plan.route='attack';},
    'model phase':m=>{m.phase='GameStart';},'model stage':m=>{m.stage='loading';},'plan stage':m=>{m.plan.stage='loading-preview';},
    'missing fresh timestamp':m=>{delete m.plan.generatedAt;},
    'stale plan':m=>{m.plan.generatedAt=new Date(Date.now()-31000).toISOString();},
    'stale model':m=>{m.updatedAt=new Date(Date.now()-31000).toISOString();},
    'future timestamp':m=>{m.plan.generatedAt=new Date(Date.now()+60000).toISOString();}
  };
  for(const [name,alterModel] of Object.entries(changes))await t.test(name,async()=>{const h=await harness({alterModel});assert.match(h.html(),/LOCAL-ITEM/);assert.doesNotMatch(h.html(),/AUTH-ITEM/);});
});

test('expired or invalidated plans do not become reusable when local metadata changes back',async()=>{
  const h=await harness();assert.match(h.html(),/AUTH-ITEM/);
  h.session({revision:8});assert.match(h.html(),/LOCAL-ITEM/);
  h.session({revision:7});assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  await h.tick();assert.match(h.html(),/AUTH-ITEM/);
  h.advance(30001);assert.match(h.html(),/LOCAL-ITEM/);
  h.advance(-30001);assert.doesNotMatch(h.html(),/AUTH-ITEM/);
});

test('pause, demo, failed sidebar requests and game boundaries discard authority',async()=>{
  const h=await harness();assert.match(h.html(),/AUTH-ITEM/);
  await h.click('pause');assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  h.model(new Error('fixture unavailable'));await h.click('pause');assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  await h.click('sample');assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  await h.click('sample');assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  const next=await harness();next.live({gameId:'game-two'});await next.tick();assert.doesNotMatch(next.html(),/AUTH-ITEM/);
});

test('recognized candidates never supply selected augment IDs to the plan guard',async()=>{
  const h=await harness({alterModel:m=>{m.ocr={enabled:true,status:'recognized',observedAt:new Date().toISOString(),proposals:['a','b','c'].map(id=>({id,name:id}))};m.plan.ownedIds=['a'];}});
  assert.match(h.html(),/LOCAL-ITEM/);
  assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  assert.deepEqual(h.owned,[]);
  assert.equal(h.proposals,1);
});


test('a locally confirmed choice or unsynchronised revision invalidates the previous build immediately',async()=>{
  const h=await harness();assert.match(h.html(),/AUTH-ITEM/);
  h.setOwned(['chosen']);
  assert.match(h.html(),/LOCAL-ITEM/);assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  h.setOwned([]);assert.doesNotMatch(h.html(),/AUTH-ITEM/);
  await h.tick();assert.match(h.html(),/AUTH-ITEM/);
  h.session({revision:null});assert.doesNotMatch(h.html(),/AUTH-ITEM/);
});


test('the same owned set in a different order cannot reuse a plan for the latest selected augment',async()=>{
  const h=await harness();
  h.setOwned(['first','latest']);h.session({owned:['first','latest']});
  h.model(m=>({...m,owned:[{id:'latest'},{id:'first'}],plan:{...m.plan,ownedIds:['latest','first']}}));
  await h.tick();
  assert.match(h.html(),/LOCAL-ITEM/);assert.doesNotMatch(h.html(),/AUTH-ITEM/);
});

test('current three-offer statistics share desktop authority and cannot leak into another trio or revision',async()=>{
  const h=await harness({alterModel:m=>{m.offers=['a','b','c'].map((id,i)=>({id,rank:i+1,rankingEvidence:{trusted:true,winRate:.6-i*.01,sampleCount:500,patch:'16.21',source:'fixture'}}));}});
  const rows=h.offerRanking(['a','b','c']);assert.equal(rows.length,3);assert.equal(rows[0].rankingEvidence.winRate,.6);
  rows[0].rankingEvidence.winRate=.1;
  assert.equal(h.offerRanking(['a','b','c'])[0].rankingEvidence.winRate,.6,'callers cannot mutate cached authority');
  assert.equal(h.offerRanking(['a','b','other']),null);assert.equal(h.offerRanking(['a','b']),null);
  h.session({revision:8});assert.equal(h.offerRanking(['a','b','c']),null);
});

test('selection confirmation requests a fresh authoritative plan immediately without waiting for another live tick',async()=>{
  const h=await harness();assert.match(h.html(),/AUTH-ITEM/);
  h.model(m=>({...m,plan:{...m.plan,buildItems:[{id:'1001',name:'FRESH-AFTER-CONFIRM',effect:'fixture'}]}}));
  await h.confirmed();assert.match(h.html(),/FRESH-AFTER-CONFIRM/);
});

test('statistical panel choices are visibly inferred only with matching session authority',async()=>{
  const h=await harness();
  h.setOwned(['chosen']);h.session({owned:['chosen']});
  h.model(m=>({...m,owned:[{id:'chosen',inferred:true}],plan:{...m.plan,ownedIds:['chosen']}}));
  await h.tick();
  assert.match(h.html(),/推定已选（同图标）/);
  assert.match(h.html(),/此记录为助手推定/);
  h.session({revision:8});
  assert.doesNotMatch(h.html(),/推定已选（同图标）/,'stale metadata cannot label another session');
});

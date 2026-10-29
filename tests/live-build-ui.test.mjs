import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildLivePlan} from '../dist/adaptive.js';
import {shortItemEffect} from '../dist/statistics-view.js';

const source=await readFile(new URL('../dist/live.js',import.meta.url),'utf8');
const catalog=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const items=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const championMap=new Map(catalog.champions.map(c=>[c.id,c]));
const owned=catalog.augments.filter(a=>a.id==='firebrand');
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};

async function controllerHarness(initial={},options={}){
  let expanded=options.expanded??true,previewOpens=0,resets=0,stageChanges=0,currentOwned=options.owned??owned,snapshot={connection:{status:'connected',message:'fixture'},phase:'InProgress',gameId:'ui-fixture',championId:'Ahri',championSource:'live-client',level:11,gameTime:660,stats:{abilityPower:150},items:[],augments:{status:'unavailable',ids:[]},mode:{known:true,isMayhem:true},teams:{status:'detected',ownTeam:'ORDER',allies:[],enemies:[{championId:'Soraka',level:11,items:[{id:6617,count:1}]}],observedAt:new Date().toISOString()},...initial};
  const ticks=[],clicks=[],offers=[];
  const renderPlan=options.planTransform?args=>options.planTransform(buildLivePlan(args)):buildLivePlan;
  const context=vm.createContext({buildLivePlan:renderPlan,shortItemEffect,location:{hash:'#live'},sessionStorage:{getItem:key=>key==='hexguide-local-session'?'fixture-token':null,setItem(){}},history:{replaceState(){}},Date,AbortSignal,console,
    setInterval:fn=>{ticks.push(fn);return ticks.length;},clearInterval(){},setTimeout,
    window:{addEventListener(){}},document:{addEventListener:(name,fn)=>{if(name==='click')clicks.push(fn);}},
    fetch:async url=>{if(url==='./items.json')return {ok:true,json:async()=>items};if(url==='/api/live')return {ok:true,json:async()=>structuredClone(snapshot)};if(url==='/api/sidebar')return {ok:true,json:async()=>({ocr:{enabled:true,proposals:[]}})};throw Error('Unexpected fixture request '+url);}
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function createLiveController','function createLiveController')+'\nthis.createController=createLiveController;',context);
  const controller=context.createController({getChampion:()=>championMap.get('Ahri'),getChampionById:id=>championMap.get(id),getChampions:()=>catalog.champions,getAugments:()=>catalog.augments,getOwned:()=>currentOwned,getRoute:()=> 'auto',getBuildExpanded:()=>expanded,getSelectedAugment:()=>currentOwned[0],onBuildToggle:()=>{expanded=!expanded;},onLoadingPreview(){expanded=true;previewOpens++;},onStageChange(){stageChanges++;},onGameId(){},getGameId:()=>null,onChampion(){},onNewGame(){currentOwned=[];expanded=false;resets++;},onOffers:ids=>offers.push(ids),renderLive(){}});
  await settle();
  return {html:()=>controller.html(),isLoading:()=>controller.isLoadingPreview(),get stageChanges(){return stageChanges;},get previewOpens(){return previewOpens;},get resets(){return resets;},select(id){currentOwned=catalog.augments.filter(a=>a.id===id);expanded=true;controller.confirmedSelection();},async update(value){snapshot={...snapshot,...value};ticks.forEach(fn=>fn());await settle();},async click(action){clicks.forEach(fn=>fn({target:{closest:()=>({dataset:{liveAction:action}})}}));await settle();}};
}

test('expanded build renders observed enemies, actual item icons, short effects and six future directions',async()=>{
  const h=await controllerHarness(),html=h.html();
  assert.match(html,/id="live-build" class="live-plan expanded"/);
  assert.match(html,/class="live-enemy-avatar"[^>]+Soraka/);
  assert.match(html,/class="live-enemy-items"[\s\S]+6617\.png/);
  assert.match(html,/class="live-item-icon"[^>]+3165\.png/);
  assert.match(html,/已读取[^<]+治疗\/续航/);
  const next=html.slice(html.indexOf('<section class="live-next-augments"'));
  assert.equal((next.match(/class="live-next-icon"/g)||[]).length,6);
  assert.match(next,/下轮是否出现，以游戏实际选项为准/);
  assert.doesNotMatch(next,/<h4>火上浇油/,'already selected augments are not future candidates');
  await h.click('pause');
  const paused=h.html().slice(h.html().indexOf('<div id="live-build-details"'));
  assert.doesNotMatch(paused,/class="live-enemy-avatar"|class="live-item-icon"|class="live-next-icon"/,'pause hides previous live recommendations');
  await h.click('pause');
  await h.click('build-toggle');
  assert.match(h.html(),/class="live-plan collapsed"/);
  assert.match(h.html(),/id="live-build-details" class="live-build-details" hidden/);
});

test('collapsed build exposes existing equipment references only while its real match context is usable',async()=>{
  const h=await controllerHarness({}, {expanded:false});
  const preview=()=>h.html().slice(h.html().indexOf('<div class="live-build-preview"'),h.html().indexOf('<div class="plan-context"'));
  assert.match(h.html(),/id="live-build-details" class="live-build-details" hidden/);
  assert.match(preview(),/当前出装参考/);
  assert.match(preview(),/class="live-item-icon"[^>]+3165\.png/);
  assert.equal((preview().match(/class="live-item-icon"/g)||[]).length,2);
  assert.doesNotMatch(preview(),/下一件|下一轮/,'existing build order is not presented as an authoritative next purchase');
  await h.click('pause');
  assert.match(preview(),/同步已暂停/);
  assert.doesNotMatch(preview(),/live-item-icon/);
  await h.click('pause');
  assert.match(preview(),/live-item-icon/);
  await h.update({connection:{status:'waiting'}});
  assert.match(preview(),/等待连接真实对局/);
  assert.doesNotMatch(preview(),/live-item-icon/);
  await h.click('sample');
  assert.match(preview(),/演示预览不作为本局装备建议/);
  assert.doesNotMatch(preview(),/live-item-icon/);
});

test('secondary tools keep their chosen expansion through automatic polls',async()=>{
  const h=await controllerHarness();
  assert.match(h.html(),/data-action="focus-session"/);
  const statsTag=()=>h.html().match(/<dl id="live-observed-stats"[^>]+>/)[0];
  assert.match(statsTag(),/ hidden /);
  await h.click('tools-toggle');
  assert.doesNotMatch(statsTag(),/ hidden /);
  assert.match(h.html(),/data-live-action="tools-toggle" aria-expanded="true"/);
  await h.update({gameTime:662});
  assert.doesNotMatch(statsTag(),/ hidden /);
  assert.match(h.html(),/data-live-action="ocr-scan"/);
  await h.click('tools-toggle');
  await h.update({gameTime:664});
  assert.match(statsTag(),/ hidden /);
});

test('live build replaces opponent items and recommendations on the next poll and drops stale rosters',async()=>{
  const h=await controllerHarness();
  await h.update({teams:{status:'detected',ownTeam:'ORDER',allies:[],enemies:[{championId:'Garen',level:12,items:[{id:3065,count:1}]}],observedAt:new Date().toISOString()}});
  let html=h.html(),details=html.slice(html.indexOf('<div id="live-build-details"'));
  assert.match(details,/class="live-enemy-items"[\s\S]+3065\.png/);
  assert.match(details,/class="live-item-icon"[^>]+3135\.png/);
  assert.doesNotMatch(details,/Soraka\.png|6617\.png/);
  await h.update({teams:{status:'detected',ownTeam:'ORDER',allies:[],enemies:[{championId:'Garen',level:12,items:[{id:3065,count:1}]}],observedAt:new Date(Date.now()-31000).toISOString()}});
  html=h.html();details=html.slice(html.indexOf('<div id="live-build-details"'));
  assert.match(details,/敌方资料已过期/);
  assert.doesNotMatch(details,/class="live-enemy-avatar"/);
  assert.doesNotMatch(details,/class="live-item-icon"[^>]+3135\.png/);
  await h.update({connection:{status:'waiting',message:'fixture disconnected'},championId:null,championSource:null,stats:{},items:[]});
  assert.match(h.html(),/等待连接真实对局后生成本局出装/);
});

const loadingSnapshot=(gameId='loading-one')=>({phase:'GameStart',stage:'loading',gameId,championSource:'loading-screen',gameTime:null,level:null,currentGold:null,stats:{},items:[],teams:{status:'detected',source:'loading-roster',ownTeam:'ORDER',allies:[],enemies:['Soraka','Garen','Malphite','Jinx','Lux'].map(championId=>({championId,level:null,items:[]})),observedAt:new Date().toISOString()}});

test('loading preview opens once per game with equipment only, hiding all augment controls and directions',async()=>{
  const h=await controllerHarness(loadingSnapshot());
  let html=h.html(),details=html.slice(html.indexOf('<div id="live-build-details"'));
  assert.equal(h.previewOpens,1);
  assert.match(html,/class="live-plan expanded loading-preview"/);
  assert.match(html,/开局前预览/);
  assert.equal((details.match(/class="live-enemy-avatar"/g)||[]).length,5);
  assert.match(details,/开局出装预设/);
  assert.match(details,/class="live-item-icon"/);
  assert.doesNotMatch(html,/live-next-augments|live-next-icon|live-build-owned|live-owned-note|live-ocr|live-next-compare|后续海克斯|已选海克斯|确认已选/);
  assert.equal(h.isLoading(),true);
  assert.equal(h.stageChanges,1);
  assert.doesNotMatch(details,/live-build-current|0 级|等级未知|尚未读取到装备/);
  assert.doesNotMatch(html,/data-ui-id="live-owned-button"|data-ui-id="live-ocr-scan"|data-action="focus-session"/);
  assert.match(html,/<dt>等级<\/dt><dd>—<\/dd>/);
  assert.match(html,/<dt>游戏时间<\/dt><dd>—<\/dd>/);
  await h.click('build-toggle');
  await h.update(loadingSnapshot());
  assert.equal(h.previewOpens,1,'same loading round does not override user collapse');
  assert.match(h.html(),/class="live-plan collapsed loading-preview"/);
  await h.update({...loadingSnapshot('loading-two')});
  assert.equal(h.previewOpens,2,'a different game opens its own preview');
  assert.match(h.html(),/class="live-plan expanded loading-preview"/);
  assert.equal(h.resets,1,'new game clears previous session before preview');
});

test('loading preview displays both verified rosters and never fills in unavailable allies',async()=>{
  const ids=['Ahri','Sett','Jinx','Thresh','Senna'];
  const allyContext={status:'detected',source:'loading-roster',champions:ids.map(id=>({id,name:championMap.get(id)?.name,icon:championMap.get(id)?.icon}))};
  const h=await controllerHarness(loadingSnapshot(),{planTransform:plan=>({...plan,allyContext})});
  const html=h.html();
  assert.match(html,/aria-label="我方阵容"/);
  assert.match(html,/>敌方阵容<\/h3>/);
  assert.equal((html.match(/class="live-ally-avatar"/g)||[]).length,5);
  assert.equal((html.match(/class="live-enemy-avatar"/g)||[]).length,5);
  for(const id of ids)assert.ok(html.includes(championMap.get(id)?.name));
  const unavailable=await controllerHarness(loadingSnapshot(),{planTransform:plan=>({...plan,allyContext:{...allyContext,status:'unavailable'}})});
  assert.doesNotMatch(unavailable.html(),/class="live-ally-avatar"/);
  assert.match(unavailable.html(),/等待读取本局我方阵容/);
});

test('loading presentation stays equipment-only through pause and restores after resuming',async()=>{
  const h=await controllerHarness(loadingSnapshot());
  await h.click('pause');
  assert.equal(h.isLoading(),true);
  assert.doesNotMatch(h.html(),/live-next-augments|live-owned-note|class="ocr-panel"|后续海克斯|已选海克斯/);
  await h.click('pause');
  assert.equal(h.isLoading(),true);
  assert.match(h.html(),/class="live-item-icon"/);
  assert.doesNotMatch(h.html(),/live-next-augments|live-owned-note|class="ocr-panel"/);
});

test('loading preview becomes live recommendations and a confirmed choice removes that augment from future directions',async()=>{
  const h=await controllerHarness(loadingSnapshot());
  await h.update({stage:'live',phase:'InProgress',championSource:'live-client',gameTime:8,level:3,teams:{status:'detected',source:'live-client',ownTeam:'ORDER',allies:[],enemies:[{championId:'Soraka',level:3,items:[{id:6617,count:1}]}],observedAt:new Date().toISOString()}});
  assert.doesNotMatch(h.html(),/loading-preview|开局前预览/);
  assert.match(h.html(),/本局装备选择/);
  assert.equal(h.isLoading(),false);
  assert.equal(h.stageChanges,2);
  assert.match(h.html(),/live-next-augments|live-owned-note|live-ocr/);
  assert.doesNotMatch(h.html(),/data-ui-id="live-owned-button"[^>]*disabled/);
  assert.match(h.html(),/class="live-enemy-items"[\s\S]+6617\.png/);
  h.select('firebrand');
  const html=h.html(),next=html.slice(html.indexOf('<section class="live-next-augments"'));
  assert.match(html,/已选择「火上浇油」/);
  assert.doesNotMatch(next,/<h4>火上浇油/);
  await h.update({connection:{status:'waiting',message:'fixture disconnected'},stage:'waiting',championId:null,championSource:null,teams:{status:'unavailable',enemies:[]}});
  assert.doesNotMatch(h.html(),/class="live-enemy-avatar"/);
  assert.match(h.html(),/等待连接真实对局后生成本局出装/);
});

test('old game clock followed by a new loading screen resets only once before the first live update',async()=>{
  const h=await controllerHarness();
  await h.update(loadingSnapshot('next-loading-game'));
  assert.equal(h.resets,1);
  assert.equal(h.previewOpens,1);
  h.select('firebrand');
  await h.update({stage:'live',phase:'InProgress',championSource:'live-client',gameTime:20});
  assert.equal(h.resets,1,'the previous game clock cannot clear the new game a second time');
  assert.match(h.html(),/已选择「火上浇油」/);
});

const earlyLiveSnapshot=(gameTime=0)=>({stage:'live',phase:'InProgress',championSource:'live-client',gameTime,level:3});

test('missing the loading sample opens the first valid early live plan once without labelling it as loading',async()=>{
  const h=await controllerHarness(earlyLiveSnapshot(),{expanded:false,owned:[]});
  assert.equal(h.previewOpens,1);
  assert.match(h.html(),/class="live-plan expanded"/);
  assert.match(h.html(),/本局出装与后续海克斯/);
  assert.doesNotMatch(h.html(),/loading-preview|开局前预览/);
  await h.click('build-toggle');
  await h.update(earlyLiveSnapshot(2));
  await h.click('pause');await h.click('pause');
  assert.equal(h.previewOpens,1,'polling and pause/resume cannot override an explicit collapse');
  assert.match(h.html(),/class="live-plan collapsed"/);
  await h.update({...earlyLiveSnapshot(0),gameId:'next-early-fixture'});
  assert.equal(h.previewOpens,2,'a new game gets a separate initial recommendation');
});

test('loading expansion and early live fallback share the same per-game opportunity',async()=>{
  const h=await controllerHarness(loadingSnapshot(),{expanded:false,owned:[]});
  assert.equal(h.previewOpens,1);
  await h.click('build-toggle');
  await h.update(earlyLiveSnapshot(3));
  assert.equal(h.previewOpens,1);
  assert.match(h.html(),/class="live-plan collapsed"/);
});

test('early fallback waits for a valid fresh opponent plan and never opens for a late launch or selected augment',async()=>{
  const unavailable={status:'unavailable',enemies:[],observedAt:new Date().toISOString()};
  const h=await controllerHarness({...earlyLiveSnapshot(2),teams:unavailable},{expanded:false,owned:[]});
  assert.equal(h.previewOpens,0);
  await h.update({teams:{status:'detected',ownTeam:'ORDER',allies:[],enemies:[{championId:'Soraka',level:3,items:[]}],observedAt:new Date(Date.now()-31000).toISOString()}});
  assert.equal(h.previewOpens,0,'stale enemies cannot qualify for early expansion');
  await h.update({gameTime:4,teams:{status:'detected',ownTeam:'ORDER',allies:[],enemies:[{championId:'Soraka',level:3,items:[]}],observedAt:new Date().toISOString()}});
  assert.equal(h.previewOpens,1);
  const late=await controllerHarness(earlyLiveSnapshot(55),{expanded:false,owned:[]});
  assert.equal(late.previewOpens,0);
  await late.update(earlyLiveSnapshot(0));
  assert.equal(late.previewOpens,0,'a retransmitted zero clock cannot reopen a late-launch plan');
  assert.equal(late.resets,0,'zero alone is not a new-game clock reset');
  const selected=await controllerHarness(earlyLiveSnapshot(1),{expanded:false});
  assert.equal(selected.previewOpens,0,'an existing selected augment keeps the initial fallback from opening');
});

test('same-game zero clock retransmission preserves confirmed augments while positive clock restart still clears them',async()=>{
  const h=await controllerHarness({gameTime:120});
  await h.update({gameTime:0});
  assert.equal(h.resets,0);
  assert.match(h.html(),/已选择「火上浇油」/);
  await h.update({gameTime:122});
  assert.equal(h.resets,0,'120 -> 0 -> 122 must stay in the same game');
  await h.update({gameTime:0});
  await h.update({gameTime:40});
  assert.equal(h.resets,1);
  assert.match(h.html(),/已确认 0 个海克斯/);
});

test('early live fallback requires verified Mayhem mode instead of treating unknown or ordinary modes as eligible',async()=>{
  for(const mode of [{known:false},{known:true,isMayhem:false,queueId:450}]){
    const h=await controllerHarness({...earlyLiveSnapshot(1),mode},{expanded:false,owned:[]});
    assert.equal(h.previewOpens,0);
    assert.match(h.html(),/class="live-plan collapsed"/);
    await h.update({mode:{known:true,isMayhem:true,queueId:2400},gameTime:2});
    assert.equal(h.previewOpens,1,'verification arriving within the opening window can qualify the plan');
  }
});

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
  let expanded=options.expanded??true,previewOpens=0,resets=0,currentOwned=options.owned??owned,snapshot={connection:{status:'connected',message:'fixture'},phase:'InProgress',gameId:'ui-fixture',championId:'Ahri',championSource:'live-client',level:11,gameTime:660,stats:{abilityPower:150},items:[],augments:{status:'unavailable',ids:[]},mode:{known:true,isMayhem:true},teams:{status:'detected',ownTeam:'ORDER',allies:[],enemies:[{championId:'Soraka',level:11,items:[{id:6617,count:1}]}],observedAt:new Date().toISOString()},...initial};
  const ticks=[],clicks=[],offers=[];
  const context=vm.createContext({buildLivePlan,shortItemEffect,location:{hash:'#live'},sessionStorage:{getItem:key=>key==='hexguide-local-session'?'fixture-token':null,setItem(){}},history:{replaceState(){}},Date,AbortSignal,console,
    setInterval:fn=>{ticks.push(fn);return ticks.length;},clearInterval(){},setTimeout,
    window:{addEventListener(){}},document:{addEventListener:(name,fn)=>{if(name==='click')clicks.push(fn);}},
    fetch:async url=>{if(url==='./items.json')return {ok:true,json:async()=>items};if(url==='/api/live')return {ok:true,json:async()=>structuredClone(snapshot)};if(url==='/api/sidebar')return {ok:true,json:async()=>({ocr:{enabled:true,proposals:[]}})};throw Error('Unexpected fixture request '+url);}
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function createLiveController','function createLiveController')+'\nthis.createController=createLiveController;',context);
  const controller=context.createController({getChampion:()=>championMap.get('Ahri'),getChampionById:id=>championMap.get(id),getChampions:()=>catalog.champions,getAugments:()=>catalog.augments,getOwned:()=>currentOwned,getRoute:()=> 'auto',getBuildExpanded:()=>expanded,getSelectedAugment:()=>currentOwned[0],onBuildToggle:()=>{expanded=!expanded;},onLoadingPreview(){expanded=true;previewOpens++;},onGameId(){},getGameId:()=>null,onChampion(){},onNewGame(){currentOwned=[];expanded=false;resets++;},onOffers:ids=>offers.push(ids),renderLive(){}});
  await settle();
  return {html:()=>controller.html(),get previewOpens(){return previewOpens;},get resets(){return resets;},select(id){currentOwned=catalog.augments.filter(a=>a.id===id);expanded=true;controller.confirmedSelection();},async update(value){snapshot={...snapshot,...value};ticks.forEach(fn=>fn());await settle();},async click(action){clicks.forEach(fn=>fn({target:{closest:()=>({dataset:{liveAction:action}})}}));await settle();}};
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

test('loading preview opens once per game, shows real roster and directions without stale selected augments or invented stats',async()=>{
  const h=await controllerHarness(loadingSnapshot());
  let html=h.html(),details=html.slice(html.indexOf('<div id="live-build-details"'));
  assert.equal(h.previewOpens,1);
  assert.match(html,/class="live-plan expanded loading-preview"/);
  assert.match(html,/开局前预览/);
  assert.equal((details.match(/class="live-enemy-avatar"/g)||[]).length,5);
  assert.match(details,/开局出装预设/);
  assert.match(details,/class="live-item-icon"/);
  assert.match(details,/开局可关注的海克斯/);
  assert.match(details,/class="live-next-icon"/);
  assert.doesNotMatch(details,/live-build-current|0 级|等级未知|尚未读取到装备/);
  assert.match(html,/已确认 0 个海克斯/);
  assert.match(html,/data-ui-id="live-owned-button"[^>]*disabled/);
  assert.match(html,/data-ui-id="live-ocr-scan"[^>]*disabled/);
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

test('loading preview becomes live recommendations and a confirmed choice removes that augment from future directions',async()=>{
  const h=await controllerHarness(loadingSnapshot());
  await h.update({stage:'live',phase:'InProgress',championSource:'live-client',gameTime:8,level:3,teams:{status:'detected',source:'live-client',ownTeam:'ORDER',allies:[],enemies:[{championId:'Soraka',level:3,items:[{id:6617,count:1}]}],observedAt:new Date().toISOString()}});
  assert.doesNotMatch(h.html(),/loading-preview|开局前预览/);
  assert.match(h.html(),/本局装备选择/);
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

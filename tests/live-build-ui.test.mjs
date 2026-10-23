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

async function controllerHarness(){
  let expanded=true,snapshot={connection:{status:'connected',message:'fixture'},phase:'InProgress',gameId:'ui-fixture',championId:'Ahri',championSource:'live-client',level:11,gameTime:660,stats:{abilityPower:150},items:[],augments:{status:'unavailable',ids:[]},mode:{known:true,isMayhem:true},teams:{status:'detected',ownTeam:'ORDER',allies:[],enemies:[{championId:'Soraka',level:11,items:[{id:6617,count:1}]}],observedAt:new Date().toISOString()}};
  const ticks=[],clicks=[],offers=[];
  const context=vm.createContext({buildLivePlan,shortItemEffect,location:{hash:'#live'},sessionStorage:{getItem:key=>key==='hexguide-local-session'?'fixture-token':null,setItem(){}},history:{replaceState(){}},Date,AbortSignal,console,
    setInterval:fn=>{ticks.push(fn);return ticks.length;},clearInterval(){},setTimeout,
    window:{addEventListener(){}},document:{addEventListener:(name,fn)=>{if(name==='click')clicks.push(fn);}},
    fetch:async url=>{if(url==='./items.json')return {ok:true,json:async()=>items};if(url==='/api/live')return {ok:true,json:async()=>structuredClone(snapshot)};if(url==='/api/sidebar')return {ok:true,json:async()=>({ocr:{enabled:true,proposals:[]}})};throw Error('Unexpected fixture request '+url);}
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function createLiveController','function createLiveController')+'\nthis.createController=createLiveController;',context);
  const controller=context.createController({getChampion:()=>championMap.get('Ahri'),getChampionById:id=>championMap.get(id),getChampions:()=>catalog.champions,getAugments:()=>catalog.augments,getOwned:()=>owned,getRoute:()=> 'auto',getBuildExpanded:()=>expanded,getSelectedAugment:()=>owned[0],onBuildToggle:()=>{expanded=!expanded;},onGameId(){},getGameId:()=>null,onChampion(){},onNewGame(){},onOffers:ids=>offers.push(ids),renderLive(){}});
  await settle();
  return {html:()=>controller.html(),async update(value){snapshot={...snapshot,...value};ticks.forEach(fn=>fn());await settle();},async click(action){clicks.forEach(fn=>fn({target:{closest:()=>({dataset:{liveAction:action}})}}));await settle();}};
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

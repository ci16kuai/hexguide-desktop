import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {enrichData,recommend,getSynergy,getChampionTags,TAG_LABELS} from '../dist/engine.js';
import {getVersionInfo} from '../dist/version.js';

const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const catalog=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const active=catalog.augments.filter(a=>!a.isInternalTemplate&&a.availability==='current'&&!a.retiredPatch&&a.recommendable!==false);

async function appHarness(hash=''){
  const storage=new Map(),nodes=new Map(),clicks=[],hashListeners=[];
  let liveContext,syncContext,manualChanges=0;
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',hidden:false,value:'',open:false,scrolls:0,focuses:0,classList:{add(){},remove(){},toggle(){}},dataset:{},addEventListener(){},setAttribute(){},removeAttribute(){},showModal(){this.open=true;},close(){this.open=false;},focus(){this.focuses++;},querySelector(){return null;},insertAdjacentHTML(_position,html){this.innerHTML+=html;},scrollIntoView(){this.scrolls++;}});return nodes.get(selector);};
  const nav=['live','library','champions','stats','synergy','compare'].map(tab=>({...node(`nav-${tab}`),dataset:{nav:tab}}));
  const location={hash};
  const context=vm.createContext({
    enrichData,recommend,getSynergy,getChampionTags,TAG_LABELS,getVersionInfo,
    createStatisticsView:()=>({html:()=>'<div class="statistics-fixture">英雄胜率</div>'}),
    createLiveController:options=>{liveContext=options;return {html:()=>`<div class="live-fixture">已确认 ${options.getOwned().length} 个海克斯 · ${options.getChampion()?.name}</div>`,manualChampion(){manualChanges++;}};},
    createSessionSync:options=>{syncContext=options;return {publish(){},close(){}};},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    sessionStorage:{getItem:()=>null},location,
    document:{title:'',querySelector:node,querySelectorAll:selector=>selector==='[data-nav]'?nav:selector==='dialog'?[node('#detail-dialog'),node('#picker-dialog')]:[],addEventListener:(name,callback)=>{if(name==='click')clicks.push(callback);}},
    window:{addEventListener:(name,callback)=>{if(name==='hashchange')hashListeners.push(callback);},scrollTo(){}},
    fetch:async url=>{assert.equal(url,'./data.json');return {ok:true,json:async()=>structuredClone(catalog)};},
    setTimeout:()=>1,clearTimeout(){},matchMedia:()=>({matches:true}),console
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,''),context);
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(node('#loading').hidden,true,node('#loading').innerHTML);
  return {
    node,location,storage,nav,
    html:()=>node('#app').innerHTML,
    navigate(tab){location.hash=`#${tab}`;hashListeners.forEach(callback=>callback());},
    click(action,extra={}){const event={preventDefault(){},target:{closest:()=>({dataset:{action,...extra}})}};clicks.forEach(callback=>callback(event));},
    offers(ids){liveContext.onOffers(ids);},
    expireOffers(){liveContext.onOffersExpired();},
    sync(value){syncContext.applyState(value);},
    get buildExpanded(){return liveContext.getBuildExpanded();},
    get selectedAugment(){return liveContext.getSelectedAugment();},
    get manualChanges(){return manualChanges;}
  };
}

test('match home owns expanded session controls and all auxiliary routes render without them',async()=>{
  const app=await appHarness();
  assert.match(app.html(),/workspace-home/);
  assert.match(app.html(),/class="session-panel"/);
  assert.match(app.html(),/class="session-body "/);
  assert.match(app.html(),/id="home-compare"/);
  assert.equal((app.html().match(/class="triple-slot live-offer-waiting/g)||[]).length,3);
  assert.match(app.html(),/<details class="home-manual-fallback"><summary>/);
  assert.doesNotMatch(app.html(),/<details class="home-manual-fallback" open/);
  for(const route of ['library','champions','stats','synergy','compare']){
    app.navigate(route);
    assert.match(app.html(),/workspace-tool/);
    assert.doesNotMatch(app.html(),/class="session-panel"/);
    assert.doesNotMatch(app.html(),/id="home-compare"/);
  }
});

test('home comparison and adoption share candidates with the independent comparison page',async()=>{
  const app=await appHarness();
  for(let slot=0;slot<3;slot++){
    app.click('pick-candidate',{slot:String(slot)});
    app.click('pick-item',{id:String(active[slot].id)});
  }
  app.click('compare');
  assert.match(app.html(),/data-ui-id="home-compare-results"/);
  assert.equal((app.html().match(/class="recommendation /g)||[]).length,3);
  app.navigate('compare');
  assert.match(app.html(),/data-ui-id="compare-results"/);
  for(const augment of active.slice(0,3))assert.ok(app.html().includes(augment.name));
  app.click('adopt-candidate',{id:String(active[0].id)});
  assert.equal(app.location.hash,'#live');
  assert.equal(app.buildExpanded,true);
  assert.equal(app.node('#live-build').scrolls,1);
  app.navigate('live');
  assert.match(app.html(),/已确认 1 个海克斯/);
  assert.doesNotMatch(app.html(),/data-ui-id="home-compare-results"/);
  const stored=JSON.parse(app.storage.get('hexguide-session'));
  assert.deepEqual(stored.owned,[String(active[0].id)]);
});

test('new offers update home without taking navigation away from reference pages',async()=>{
  const app=await appHarness('#stats');
  app.offers(active.slice(0,3).map(a=>String(a.id)));
  assert.equal(app.location.hash,'#stats');
  assert.match(app.html(),/statistics-fixture/);
  assert.match(app.node('#toast').textContent,/回我的这一局查看/);
  assert.equal(app.node('#home-compare').scrolls,0);
  app.navigate('live');
  assert.match(app.html(),/data-ui-id="home-compare-results"/);
  for(const augment of active.slice(0,3))assert.ok(app.html().includes(augment.name));
  app.offers(active.slice(3,6).map(a=>String(a.id)));
  assert.equal(app.location.hash,'#live');
  assert.equal(app.node('#home-compare').scrolls,0,'automatic detection does not move the viewport');
});

test('sidebar selection expands the build without changing reference navigation or scrolling',async()=>{
  const app=await appHarness('#stats');
  app.offers(active.slice(0,3).map(a=>String(a.id)));
  app.sync({owned:[String(active[1].id)],route:'auto',gameId:'fixture-game'});
  assert.equal(app.buildExpanded,true);
  assert.equal(app.selectedAugment.id,String(active[1].id));
  assert.equal(app.location.hash,'#stats');
  assert.equal(app.node('#live-build').scrolls,0);
  assert.equal(app.node('#live-build').focuses,0);
  assert.match(app.html(),/statistics-fixture/);
  app.navigate('live');
  assert.match(app.html(),/已确认 1 个海克斯/);
  assert.doesNotMatch(app.html(),/live-offer-card/);
});

test('recognized candidates preserve game order, never adopt themselves, and expire together',async()=>{
  const app=await appHarness('#live'),ids=active.slice(0,3).map(a=>String(a.id));
  app.offers(ids);
  const html=app.html(),cards=html.slice(html.indexOf('data-ui-id="home-compare-slots"'),html.indexOf('data-ui-id="home-compare-actions"'));
  assert.equal((cards.match(/我选了这个/g)||[]).length,3);
  assert.ok(cards.indexOf(active[0].name)<cards.indexOf(active[1].name));
  assert.ok(cards.indexOf(active[1].name)<cards.indexOf(active[2].name));
  assert.equal(app.buildExpanded,false);
  assert.match(html,/已确认 0 个海克斯/);
  app.expireOffers();
  assert.doesNotMatch(app.html(),/live-offer-card/);
  assert.match(app.html(),/等待识别/);
  assert.equal(app.storage.has('hexguide-session'),false);
});

test('reference-page champion switch remains manual and updates the shared home selection',async()=>{
  const app=await appHarness('#synergy');
  assert.match(app.html(),/page-champion-context/);
  const champion=catalog.champions.find(c=>c.id==='Jinx')||catalog.champions[1];
  app.click('pick-champion');
  app.click('pick-item',{id:String(champion.id)});
  assert.equal(app.manualChanges,1);
  app.navigate('live');
  assert.ok(app.html().includes(champion.name));
});

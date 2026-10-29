import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {enrichData,recommend,getSynergy,getChampionTags,TAG_LABELS} from '../dist/engine.js';
import {getVersionInfo} from '../dist/version.js';
import {replacePreservingFocus} from '../dist/focus-preservation.js';
import {getStaticAugmentStatistics} from '../dist/build-evidence.js';
import {rankAugmentCandidates} from '../dist/recommendation-policy.js';
import {focusDocument,focusElement} from './fixtures/focus-dom.mjs';

const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const catalog=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const active=catalog.augments.filter(a=>!a.isInternalTemplate&&a.availability==='current'&&!a.retiredPatch&&a.recommendable!==false);

async function appHarness(hash='',options={}){
  const storage=new Map(),nodes=new Map(),clicks=[],changes=[],hashListeners=[];
  const document=focusDocument();
  let liveContext,syncContext,manualChanges=0,loading=false,pulls=0;
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,focusElement(document,{id:selector.startsWith('#')?selector.slice(1):'',textContent:'',hidden:false,value:'',open:false,scrolls:0,classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(){},removeAttribute(){},showModal(){this.open=true;},close(){this.open=false;},querySelector(){return null;},insertAdjacentHTML(_position,html){this.innerHTML+=html;},scrollIntoView(){this.scrolls++;}}));return nodes.get(selector);};
  const nav=['live','library','champions','stats','synergy','compare'].map(tab=>({...node(`nav-${tab}`),dataset:{nav:tab}}));
  const location={hash};
  const context=vm.createContext({
    enrichData,recommend,getSynergy,getChampionTags,TAG_LABELS,getVersionInfo,replacePreservingFocus,getStaticAugmentStatistics,rankAugmentCandidates,
    createStatisticsView:()=>({html:()=>'<div class="statistics-fixture">英雄胜率</div>'}),
    createLiveController:controllerOptions=>{liveContext=controllerOptions;return {isLoadingPreview:()=>loading,html:()=>`<div class="live-fixture">已确认 ${controllerOptions.getOwned().length} 个海克斯 · ${controllerOptions.getChampion()?.name}</div>`,manualChampion(){manualChanges++;},confirmCandidate:options.confirmCandidate,resetSession:options.resetSession};},
    createSessionSync:options=>{syncContext=options;return {publish(){},pull(){pulls++;},close(){}};},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    sessionStorage:{getItem:()=>null},location,
    document:Object.assign(document,{title:'',querySelector:node,querySelectorAll:selector=>selector==='[data-nav]'?nav:selector==='dialog'?[node('#detail-dialog'),node('#picker-dialog')]:[],addEventListener:(name,callback)=>{if(name==='click')clicks.push(callback);if(name==='change')changes.push(callback);}}),
    window:{addEventListener:(name,callback)=>{if(name==='hashchange')hashListeners.push(callback);},scrollTo(){}},
    fetch:async url=>{if(url==='./statistics.json'){if(options.statistics instanceof Error)throw options.statistics;return {ok:Boolean(options.statistics),json:async()=>structuredClone(options.statistics)};}assert.equal(url,'./data.json');return {ok:true,json:async()=>structuredClone(options.catalog||catalog)};},
    setTimeout:()=>1,clearTimeout(){},matchMedia:()=>({matches:true}),console
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,''),context);
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(node('#loading').hidden,true,node('#loading').innerHTML);
  return {
    node,location,storage,nav,document,
    html:()=>node('#app').innerHTML,
    change(id,value){changes.forEach(callback=>callback({target:{id,value}}));},
    navigate(tab){location.hash=`#${tab}`;hashListeners.forEach(callback=>callback());},
    click(action,extra={}){const event={preventDefault(){},target:{closest:()=>({dataset:{action,...extra}})}};clicks.forEach(callback=>callback(event));},
    offers(ids,meta){liveContext.onOffers(ids,meta);},
    expireOffers(){liveContext.onOffersExpired();},
    sync(value){syncContext.applyState(value);},
    pendingConfirmed(){liveContext.onPendingConfirmed();},
    sessionReset(){liveContext.onSessionReset();},
    refreshLive(){liveContext.renderLive();},
    stage(value){loading=value;liveContext.onStageChange();},
    get buildExpanded(){return liveContext.getBuildExpanded();},
    get selectedAugment(){return liveContext.getSelectedAugment();},
    get manualChanges(){return manualChanges;},
    get pulls(){return pulls;}
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
  assert.equal(app.node('#live-build').focuses,1,'explicit adoption still focuses the expanded build');
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

test('an older pending round keeps its label and confirmation identity when promoted to the main cards',async()=>{
  const app=await appHarness();
  const ids=active.slice(0,3).map(a=>String(a.id));
  app.offers(ids,{pendingId:'new-round',gameId:'fixture-game',revision:4,sequence:2,previousRound:false});
  assert.match(app.html(),/<h2>本轮三选一<\/h2>/);
  app.offers(ids,{pendingId:'old-round',gameId:'fixture-game',revision:5,sequence:1,previousRound:true});
  assert.match(app.html(),/<h2>上一轮待确认 · 第 1 轮<\/h2>/);
  assert.match(app.html(),/data-pending-id="old-round"/);
  assert.match(app.html(),/这是之前保留的候选/);
  app.offers(ids,{pendingId:'future-round',gameId:'fixture-game',revision:6,sequence:3,previousRound:false,forceRerank:true});
  assert.match(app.html(),/<h2>本轮三选一<\/h2>/);
  assert.doesNotMatch(app.html(),/上一轮待确认/);
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

test('authoritative pending candidate adoption uses scoped confirmation before syncing ownership',async()=>{
  const confirmed=[],app=await appHarness('#live',{confirmCandidate:(id,pendingId,scope)=>{confirmed.push({id,pendingId,...scope});return true;}}),ids=active.slice(0,3).map(a=>String(a.id));
  app.offers(ids,{pendingId:'pending-round',gameId:'fixture-game',revision:12});
  const buttons=app.html().match(/<button[^>]*data-action="adopt-candidate"[^>]*>/g)||[];
  assert.equal(buttons.length,6,'both the game-order cards and the comparison result buttons can confirm');
  for(const button of buttons){assert.match(button,/data-pending-id="pending-round"/);assert.match(button,/data-game-id="fixture-game"/);assert.match(button,/data-revision="12"/);}
  app.click('adopt-candidate',{id:ids[1],pendingId:'pending-round',gameId:'fixture-game',revision:'12'});
  assert.deepEqual(confirmed,[{id:ids[1],pendingId:'pending-round',gameId:'fixture-game',revision:12}]);
  assert.match(app.html(),/已确认 0 个海克斯/,'a pending click does not submit a full local owned-array correction');
  assert.equal(app.storage.has('hexguide-session'),false);
  app.pendingConfirmed();assert.equal(app.pulls,1);
  app.sync({owned:[ids[1]],route:'auto',gameId:'fixture-game'});
  assert.equal(app.selectedAugment.id,ids[1]);
  assert.equal(app.buildExpanded,true);
});

test('missing pending guards never fall through to a full local session correction',async()=>{
  const app=await appHarness('#live',{confirmCandidate:()=>false}),ids=active.slice(0,3).map(a=>String(a.id));
  app.offers(ids,{pendingId:'pending-round',gameId:'fixture-game',revision:12});
  app.click('adopt-candidate',{id:ids[1]});
  assert.match(app.html(),/已确认 0 个海克斯/);
  assert.equal(app.storage.has('hexguide-session'),false);
});

test('an owned candidate still renders with the other two unresolved choices',async()=>{
  const app=await appHarness('#live'),ids=active.slice(0,3).map(a=>String(a.id));
  app.sync({owned:[ids[0]],route:'auto',gameId:'fixture-game'});
  app.offers(ids,{pendingId:'overlap-round',gameId:'fixture-game',revision:13});
  assert.equal((app.html().match(/live-offer-card/g)||[]).length,3);
  assert.match(app.html(),/disabled>已在本局<\/button>/);
  assert.match(app.html(),/已确认 1 个海克斯/);
});

test('empty local session reset still requests the explicit server reset operation',async()=>{
  let resets=0;const app=await appHarness('#live',{resetSession:()=>{resets++;return true;}});
  app.offers(active.slice(0,3).map(a=>String(a.id)),{pendingId:'unconfirmed',gameId:'fixture-game',revision:12});
  app.click('reset-session');
  assert.equal(resets,1);assert.equal(app.storage.has('hexguide-session'),false);
  app.sessionReset();assert.equal(app.pulls,1);
  assert.doesNotMatch(app.html(),/live-offer-card/);
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

test('automatic live polling restores only foreground controls replaced inside live content',async()=>{
  for(const mode of ['foreground','background','hidden','topbar']){
    const app=await appHarness('#live'),root=app.node('#live-content');
    const old=focusElement(app.document,{dataset:{liveAction:'pause'}}),next=focusElement(app.document,{dataset:{liveAction:'pause'}});
    root.replaceChildren(old);root.nextChildren=[next];app.document.activeElement=old;
    if(mode==='background')app.document.focused=false;
    if(mode==='hidden')app.document.visibilityState='hidden';
    if(mode==='topbar')app.document.activeElement=focusElement(app.document,{dataset:{liveAction:'pause'}});
    app.refreshLive();
    assert.equal(next.focuses,mode==='foreground'?1:0,mode);
    assert.equal(old.focuses,0,mode);
  }
});

test('offers and sidebar sync keep foreground controls usable without focusing background or dialogs',async()=>{
  for(const trigger of ['offers','session-sync'])for(const mode of ['foreground','background','hidden','dialog']){
    const app=await appHarness('#live'),root=app.node('#app');
    const old=focusElement(app.document,{id:'route'}),next=focusElement(app.document,{id:'route'});
    root.replaceChildren(old);root.nextChildren=[next];app.document.activeElement=old;
    if(mode==='background')app.document.focused=false;
    if(mode==='hidden')app.document.visibilityState='hidden';
    const dialog=app.node('#picker-search');
    if(mode==='dialog')app.document.activeElement=dialog;
    if(trigger==='offers')app.offers(active.slice(0,3).map(a=>String(a.id)));
    else app.sync({owned:[],route:'auto',gameId:'fixture-game'});
    assert.equal(next.focuses,mode==='foreground'?1:0,`${trigger}: ${mode}`);
    assert.equal(dialog.focuses,0,`${trigger}: ${mode}`);
    assert.equal(old.focuses,0,`${trigger}: ${mode}`);
  }
});

test('loading stage hides outer session and comparison controls and restores them on live entry',async()=>{
  const app=await appHarness('#live');
  app.stage(true);
  assert.match(app.html(),/workspace-tool/);
  assert.doesNotMatch(app.html(),/class="session-panel"|id="home-compare"/);
  app.refreshLive();
  assert.doesNotMatch(app.html(),/class="session-panel"|id="home-compare"/);
  app.stage(false);
  assert.match(app.html(),/workspace-home/);
  assert.match(app.html(),/class="session-panel"/);
  assert.match(app.html(),/id="home-compare"/);
  app.navigate('stats');
  app.stage(true);
  assert.equal(app.location.hash,'#stats');
  assert.match(app.html(),/statistics-fixture/);
});


const rankingCatalog={...catalog,combos:[],augments:[
  {id:'fixture_health',name:'测试生命',rarity:'silver',description:'获得100点生命值。',availability:'current',recommendable:true},
  {id:'fixture_vamp',name:'测试全能吸血',rarity:'silver',description:'获得10%全能吸血。',availability:'current',recommendable:true},
  {id:'fixture_crit',name:'测试技能暴击',rarity:'gold',description:'你的技能可以造成暴击。',availability:'current',recommendable:true}
]};
const rankingStatistics={schemaVersion:1,meta:{mode:'aram-mayhem',patch:'16.21',cohortId:'fixture',lowSampleThreshold:200,source:{name:'Fixture'}},champions:[{championId:'Ahri',cohortId:'fixture',augments:rankingCatalog.augments.map((augment,index)=>({augmentId:augment.id,cohortId:'fixture',games:1000,wins:[520,900,700][index],lowSample:false,provisional:false}))}]};

test('shared policy ranks library, champion and comparison views by actual statistics while home keeps game order',async()=>{
  const app=await appHarness('#live',{catalog:rankingCatalog,statistics:rankingStatistics});
  const ids=rankingCatalog.augments.map(a=>a.id);
  app.offers(ids);
  let html=app.html(),home=html.slice(html.indexOf('data-ui-id="home-compare-slots"'),html.indexOf('data-ui-id="home-compare-actions"'));
  assert.ok(home.indexOf('测试生命')<home.indexOf('测试全能吸血'));
  assert.ok(home.indexOf('测试全能吸血')<home.indexOf('测试技能暴击'));
  assert.match(home,/游戏选项 2 · 推荐 1/);
  assert.match(home,/持有胜率 90.00%/);
  const results=html.slice(html.indexOf('data-ui-id="home-compare-results"'));
  assert.match(results,/<article class="recommendation top-choice" data-augment-id="fixture_vamp"/);
  app.navigate('compare');
  assert.match(app.html(),/<article class="recommendation top-choice" data-augment-id="fixture_vamp"/);
  app.navigate('champions');
  html=app.html();
  assert.ok(html.indexOf('<h3>测试全能吸血')<html.indexOf('<h3>测试技能暴击'));
  assert.ok(html.indexOf('<h3>测试技能暴击')<html.indexOf('<h3>测试生命'));
  app.navigate('library');app.change('sort-filter','fit');
  html=app.node('#library-results').innerHTML;
  assert.ok(html.indexOf('<h3>测试全能吸血')<html.indexOf('<h3>测试技能暴击'));
  assert.ok(html.indexOf('<h3>测试技能暴击')<html.indexOf('<h3>测试生命'));
  assert.match(html,/持有胜率 90.00%/);
});

test('missing statistics do not block app startup or fabricate win rates',async()=>{
  for(const statistics of [null,new Error('fixture fetch failed'),{meta:{},champions:[]}]){
    const app=await appHarness('#live',{catalog:rankingCatalog,statistics});
    app.offers(rankingCatalog.augments.map(a=>a.id));
    assert.equal(app.node('#loading').hidden,true);
    assert.match(app.html(),/机制参考 · 暂无可靠胜率/);
    assert.doesNotMatch(app.html(),/持有胜率 \d/);
  }
});

test('low-sample observations remain labelled and never outrank a trusted rate by their displayed percentage',async()=>{
  const statistics=structuredClone(rankingStatistics);
  Object.assign(statistics.champions[0].augments[0],{games:10,wins:10,lowSample:true});
  const app=await appHarness('#live',{catalog:rankingCatalog,statistics});
  app.offers(rankingCatalog.augments.map(a=>a.id));
  assert.match(app.html(),/持有胜率 100.00%[^<]+样本或口径不足/);
  assert.match(app.html(),/<article class="recommendation top-choice" data-augment-id="fixture_vamp"/);
});

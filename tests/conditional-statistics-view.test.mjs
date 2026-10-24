import test from 'node:test';
import assert from 'node:assert/strict';
import {createStatisticsView} from '../dist/statistics-view.js';
import {focusDocument,focusElement} from './fixtures/focus-dom.mjs';

// Synthetic API fixtures and a minimal DOM only. No network, game, native
// window, production dataset, or external player's match record is used.
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const augment=(id,gameDataId,name)=>({id,gameDataId,name,rarity:'gold',availability:'current',description:'获得额外伤害。',icon:`https://example.test/augment/${gameDataId}.png`});
const catalog={meta:{patch:'4.0'},champions:[{id:'Ahri',name:'阿狸'},{id:'Jinx',name:'金克丝'}],
  augments:[augment('first',1001,'选项甲'),augment('second',1002,'选项乙'),
    ...[1101,1102,1103,1104,1201,1202,1203,1204,1301,1302].map(id=>augment(`other-${id}`,id,`联动${id}`))]};
const observation=(id,sourceId,wins)=>({augmentId:id,sourceAugmentId:String(sourceId),cohortId:'baseline',
  games:1000,wins,winRate:wins/10,lowSample:false});
const baseline={schemaVersion:1,meta:{mode:'aram-mayhem',patch:'16.21',cohortId:'baseline'},
  champions:[{championId:'Ahri',sourceChampionId:'103',cohortId:'baseline',games:1000,wins:500,winRate:50,
    augments:[observation('first',1001,560),observation('second',1002,550)]},
  {championId:'Jinx',sourceChampionId:'222',cohortId:'baseline',games:1000,wins:510,winRate:51,
    augments:[observation('first',1001,570),observation('second',1002,540)]}]};
const itemNames={'3031':'甲条件装备','3078':'甲三件套二','3161':'甲三件套三','3153':'乙条件装备','3115':'乙三件套二','3006':'乙三件套三'};
const itemsCatalog={meta:{version:'fixture',sourceUrl:'https://example.test/riot'},
  data:Object.fromEntries(Object.entries(itemNames).map(([id,name])=>[id,{id,name,icon:`https://example.test/item/${id}.png`,description:'造成额外魔法伤害。'}]))};

function conditionalSnapshot(championId=103){
  const combination=(a,b,sampleCount)=>({augmentIds:[a,b],sampleCount,winRate:0.62,pickRate:0.9876});
  const equipment=(augmentId,id)=>({augmentId,sampleCount:1000,all:[{id,sampleCount:350,winRate:0.64,pickRate:0.8765}]});
  const build=(augmentId,ids)=>({augmentId,sampleCount:900,archetypes:[{key:'fixture',sampleCount:800,winRate:0.62,profiles:[{
    itemSet:ids.map(id=>({id})),sampleCount:270,winRate:0.63,
    routes:[{purchaseOrder:[...ids].reverse().map(id=>({id})),sampleCount:170,winRate:0.65}]
  }]}]});
  return {championId,meta:{patch:'16.21',dataDate:'2026-10-23',sourceName:'ARAMKit',sourceUrl:'https://aramkit.com/',
      buildTimeUnixMs:1792820649085,fetchedAt:'2026-10-24T00:00:00.000Z',dataPath:'data/16.21-fixture',scope:'all',pairCoverage:'published-top-10'},
    detail:{champion:{id:championId},augmentCombinations:[
      ...[1101,1102,1103,1104].map((id,i)=>combination(1001,id,301+i)),
      ...[1201,1202,1203,1204].map((id,i)=>combination(1002,id,501+i)),
      combination(1301,1302,900),combination(1301,1303,800)]},
    single:{items:[equipment(1001,3031),equipment(1002,3153)],
      builds:[build(1001,[3031,3078,3161]),build(1002,[3153,3115,3006])]}};
}

async function harness(load){
  const doc=focusDocument(),root=focusElement(doc,{id:'statistics-root'}),listeners={},calls=[],localCalls=[];
  root.scrollIntoView=()=>{};
  doc.getElementById=id=>id==='statistics-root'?root:null;
  doc.addEventListener=(name,callback)=>{listeners[name]=callback;};
  globalThis.document=doc;
  const view=createStatisticsView({catalog,conditionalClient:{load:options=>{calls.push({...options});return load(options);}},
    fetcher:async url=>{localCalls.push(url);if(url==='./statistics.json')return {ok:true,json:async()=>structuredClone(baseline)};
      if(url==='./items.json')return {ok:true,json:async()=>structuredClone(itemsCatalog)};
      throw Error(`Unexpected network request: ${url}`);}});
  root.innerHTML=view.html();await settle();
  function click(action,id){
    const button={dataset:{statsAction:action,...(id===undefined?{}:{statsId:id})},
      closest:selector=>selector==='#statistics-root'?root:selector==='[data-stats-action]'?button:null};
    listeners.click({target:button});
  }
  const section=()=>root.innerHTML.match(/<section\b[^>]*aria-label="实战联动与出装"[^>]*>[\s\S]*?<\/td><\/tr>/)?.[0]||'';
  return {doc,root,calls,localCalls,click,section};
}

async function withDocument(run){const previous=globalThis.document;try{await run();}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}}

test('conditional requests are lazy and switching augments selects the latest row from one shared hero request',()=>withDocument(async()=>{
  const pending=deferred(),h=await harness(()=>pending.promise);
  assert.deepEqual(h.calls,[]);
  h.click('champion','Ahri');await settle();assert.deepEqual(h.calls,[]);
  h.click('expand','first');await settle();
  assert.deepEqual(h.calls,[{championId:'103',patch:'16.21'}]);
  assert.match(h.section(),/正在查询/);
  h.click('expand','second');await settle();assert.equal(h.calls.length,1);
  pending.resolve(conditionalSnapshot());await settle();
  assert.match(h.section(),/阿狸 · 选项乙/);
  assert.match(h.section(),/乙条件装备/);
  assert.doesNotMatch(h.section(),/甲条件装备|联动110[1-4]/);
  assert.match(h.root.innerHTML,/\+6\.00/,'the original AramHex ranking remains unchanged');
  assert.deepEqual(h.localCalls,['./statistics.json','./items.json']);
}));

test('late results from another hero cannot overwrite the currently expanded hero',()=>withDocument(async()=>{
  const first=deferred(),second=deferred(),h=await harness(({championId})=>championId==='103'?first.promise:second.promise);
  h.click('champion','Ahri');h.click('expand','first');await settle();
  h.click('champion','Jinx');h.click('expand','second');await settle();
  second.resolve(conditionalSnapshot(222));await settle();
  const visible=h.root.innerHTML;
  first.resolve(conditionalSnapshot(103));await settle();
  assert.equal(h.root.innerHTML,visible);
  assert.match(h.section(),/金克丝 · 选项乙/);
  assert.doesNotMatch(h.section(),/阿狸|甲条件装备/);
  assert.deepEqual(h.calls.map(c=>c.championId),['103','222']);
}));

test('late results never reopen a collapsed row or navigate back into a hero detail',()=>withDocument(async()=>{
  for(const exit of ['collapse','back']){
    const pending=deferred(),h=await harness(()=>pending.promise);
    h.click('champion','Ahri');h.click('expand','first');await settle();
    h.click(exit==='collapse'?'expand':'back',exit==='collapse'?'first':undefined);
    const visible=h.root.innerHTML;
    pending.resolve(conditionalSnapshot());await settle();
    assert.equal(h.root.innerHTML,visible,exit);
    assert.equal(h.section(),'');
    if(exit==='back')assert.match(h.root.innerHTML,/英雄胜率榜/);
  }
}));

test('a failed conditional request offers a bounded explicit retry and does not replace the baseline statistics',()=>withDocument(async()=>{
  const first=deferred(),second=deferred();let attempt=0;
  const h=await harness(()=>++attempt===1?first.promise:second.promise);
  h.click('champion','Ahri');h.click('expand','first');await settle();
  first.reject(Error('<img src=x onerror=alert(1)>'));await settle();
  assert.match(h.section(),/实战数据暂未载入/);
  assert.match(h.section(),/data-stats-action="retry-build"/);
  assert.match(h.section(),/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h.section(),/<img src=x/);
  assert.match(h.root.innerHTML,/英雄整体胜率/);
  h.click('retry-build');h.click('retry-build');await settle();
  assert.equal(h.calls.length,2,'a second click while retry is pending is deduplicated');
  assert.match(h.section(),/正在查询/);
  second.resolve(conditionalSnapshot());await settle();
  assert.match(h.section(),/甲条件装备/);
  assert.doesNotMatch(h.section(),/实战数据暂未载入/);
}));

test('expanded cards only append win rates while source and cohort notes are collapsed by default',()=>withDocument(async()=>{
  const h=await harness(async()=>conditionalSnapshot());
  h.click('champion','Ahri');h.click('expand','first');await settle();
  const html=h.section(),pairs=html.match(/<ul class="stats-pair-list">([\s\S]*?)<\/ul>/)?.[1]||'';
  const explanation=html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0]||'';
  const cards=html.replace(explanation,'');
  assert.equal((pairs.match(/<li>/g)||[]).length,3);
  assert.match(pairs,/联动1104/);assert.doesNotMatch(pairs,/联动1101|联动120/);
  assert.match(cards,/常见购买顺序：甲三件套三 → 甲三件套二 → 甲条件装备/);
  assert.match(cards,/造成额外魔法伤害。/);
  assert.match(cards,/组合胜率 <b>62\.00%/);
  assert.match(cards,/胜率 63\.00%/);
  assert.match(cards,/胜率 65\.00%/);
  assert.match(cards,/持有胜率 64\.00%/);
  assert.doesNotMatch(cards,/\d[\d,]*\s*场|样本|低样本|98\.76%|87\.65%|百分点|增幅|\+12\.00/);
  assert.doesNotMatch(cards,/ARAMKit|16\.21|来源更新/,'source metadata belongs to the collapsed explanation');
  assert.match(explanation,/<summary>数据说明<\/summary>/);
  assert.doesNotMatch(explanation.match(/^<details\b[^>]*>/)?.[0]||'',/\bopen(?:\s|=|>)/);
  assert.match(explanation,/发布的 10 组/);
  assert.match(explanation,/未限定上方第二个海克斯/);
  assert.match(explanation,/不能拼作六件套/);
  assert.match(explanation,/ARAMKit · 16\.21/);
  assert.match(explanation,/来源更新/);
  assert.match(explanation,/不与榜单的 AramHex 胜率混算增幅/);
  assert.doesNotMatch(html,/https?:\/\/[^" ]*javascript:|机制出装建议/);
  assert.match(h.root.innerHTML,/海克斯样本/,'the baseline table keeps its existing sample column');
}));

test('missing published pairs are explicitly limited to the ten published combinations',()=>withDocument(async()=>{
  const data=conditionalSnapshot();data.detail.augmentCombinations=[{augmentIds:[1301,1302],sampleCount:50,winRate:0.5}];
  const h=await harness(async()=>data);h.click('champion','Ahri');h.click('expand','first');await settle();
  assert.match(h.section(),/来源已发布的组合中暂无该海克斯/);
  const explanation=h.section().match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0]||'';
  assert.match(explanation,/发布的 10 组/);
  assert.match(explanation,/未发布不代表没有联动/);
  assert.match(h.section(),/甲条件装备/,'pair absence does not suppress the separate A-conditioned build');
}));

test('unknown conditional win rates remain unknown while all sample indicators stay hidden',()=>withDocument(async()=>{
  const data=conditionalSnapshot();
  data.detail.augmentCombinations=[{augmentIds:[1001,1101],sampleCount:null,winRate:null}];
  const item=data.single.items[0],build=data.single.builds[0],profile=build.archetypes[0].profiles[0];
  item.sampleCount=null;item.all[0].sampleCount=null;item.all[0].winRate=null;
  build.sampleCount=null;profile.sampleCount=null;profile.winRate=null;
  profile.routes[0].sampleCount=null;profile.routes[0].winRate=null;
  const h=await harness(async()=>data);h.click('champion','Ahri');h.click('expand','first');await settle();
  const html=h.section();
  const cards=html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/,'');
  assert.doesNotMatch(cards,/\d[\d,]*\s*场|样本|0\.00%|低样本/);
  assert.match(cards,/组合胜率 <b>暂无统计/);
  assert.match(cards,/持有胜率 暂无统计/);
  assert.equal((cards.match(/暂无统计/g)||[]).length,4);
  assert.match(html,/甲条件装备/,'unknown counts do not make the known item identity disappear');
}));

test('raw API presentation fields are escaped and untrusted URLs or IDs never become live markup',()=>withDocument(async()=>{
  const data=conditionalSnapshot();
  data.meta.dataDate='"><img src=x onerror=alert(1)>';
  delete data.meta.buildTimeUnixMs;
  data.meta.sourceUrl='javascript:alert(1)';
  const h=await harness(async()=>data);h.click('champion','Ahri');h.click('expand','first');await settle();
  const html=h.section();
  assert.match(html,/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html,/<img src=x|<svg onload|href="javascript:|src="javascript:/);
  assert.match(html,/href="https:\/\/aramkit\.com\/zh-CN\/champions"/);
}));

test('malformed raw API IDs fail closed without showing generic equipment as conditional evidence',()=>withDocument(async()=>{
  for(const corrupt of [
    data=>{data.detail.augmentCombinations[0].augmentIds[1]='"><img src=x onerror=alert(2)>';},
    data=>{data.single.items[0].all[0].id='"><svg onload=alert(3)>';}
  ]){
    const data=conditionalSnapshot();corrupt(data);
    const h=await harness(async()=>data);h.click('champion','Ahri');h.click('expand','first');await settle();
    assert.match(h.section(),/来源数据格式暂不兼容，未以通用装备补齐/);
    assert.doesNotMatch(h.section(),/<img src=x|<svg onload|甲条件装备|机制出装建议/);
    assert.match(h.root.innerHTML,/英雄整体胜率/);
  }
}));

test('conditional completion preserves focus only when its original document remains foreground',()=>withDocument(async()=>{
  for(const mode of ['foreground','background','hidden','dialog']){
    const pending=deferred(),h=await harness(()=>pending.promise);
    h.click('champion','Ahri');h.click('expand','first');await settle();
    const old=focusElement(h.doc,{id:'stats-augment-search',type:'search',selectionStart:1,selectionEnd:2});
    const next=focusElement(h.doc,{id:'stats-augment-search',type:'search',selectionStart:0,selectionEnd:0});
    h.root.replaceChildren(old);h.root.nextChildren=[next];h.doc.activeElement=old;
    if(mode==='background')h.doc.focused=false;
    if(mode==='hidden')h.doc.visibilityState='hidden';
    const dialog=focusElement(h.doc,{id:'external-dialog'});
    if(mode==='dialog')h.doc.activeElement=dialog;
    pending.resolve(conditionalSnapshot());await settle();
    assert.match(h.section(),/甲条件装备/);
    assert.equal(next.focuses,mode==='foreground'?1:0,mode);
    assert.equal(dialog.focuses,0,mode);
    if(mode==='foreground'){
      assert.deepEqual(next.focusOptions,{preventScroll:true});
      assert.deepEqual([next.selectionStart,next.selectionEnd],[1,2]);
    }
  }
}));

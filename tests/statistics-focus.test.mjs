import test from 'node:test';
import assert from 'node:assert/strict';
import {createStatisticsView} from '../dist/statistics-view.js';
import {focusDocument,focusElement} from './fixtures/focus-dom.mjs';

const catalog={meta:{patch:'4.0'},champions:[{id:'Ahri',name:'阿狸'}],augments:[]};
const snapshot={schemaVersion:1,meta:{mode:'aram-mayhem'},champions:[{championId:'Ahri',games:100,wins:50,augments:[]}]};
const settle=()=>new Promise(resolve=>setImmediate(resolve));

async function statisticsHarness(){
  const doc=focusDocument(),root=focusElement(doc,{id:'statistics-root'}),listeners={};
  doc.getElementById=id=>id==='statistics-root'?root:null;
  doc.addEventListener=(name,callback)=>{listeners[name]=callback;};
  globalThis.document=doc;
  let complete;
  const response=new Promise(resolve=>{complete=resolve;});
  const view=createStatisticsView({catalog,fetcher:async url=>url==='./statistics.json'?response:{ok:true,json:async()=>({data:{}})}});
  root.innerHTML=view.html();
  return {doc,root,listeners,view,async complete(){complete({ok:true,json:async()=>snapshot});await settle();await settle();}};
}

test('statistics asynchronous data redraw never focuses a background, hidden, or unrelated control',async()=>{
  const previous=globalThis.document;
  try{
    for(const mode of ['foreground','background','hidden','dialog']){
      const {doc,root,complete}=await statisticsHarness();
      const old=focusElement(doc,{id:'stats-champion-search',type:'search',selectionStart:1,selectionEnd:2});
      const next=focusElement(doc,{id:'stats-champion-search',type:'search',selectionStart:0,selectionEnd:0});
      root.replaceChildren(old);root.nextChildren=[next];doc.activeElement=old;
      if(mode==='background')doc.focused=false;
      if(mode==='hidden')doc.visibilityState='hidden';
      const dialog=focusElement(doc,{id:'stats-champion-search'});
      if(mode==='dialog')doc.activeElement=dialog;
      await complete();
      assert.match(root.innerHTML,/英雄胜率榜/);
      assert.equal(next.focuses,mode==='foreground'?1:0,mode);
      assert.equal(dialog.focuses,0,mode);
      if(mode==='foreground')assert.deepEqual([next.selectionStart,next.selectionEnd],[1,2]);
    }
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('statistics search redraw preserves the caret without scrolling',async()=>{
  const previous=globalThis.document;
  try{
    const {doc,root,listeners,complete}=await statisticsHarness();
    await complete();
    const old=focusElement(doc,{id:'stats-champion-search',type:'search',value:'阿',selectionStart:1,selectionEnd:1});
    const next=focusElement(doc,{id:'stats-champion-search',type:'search',selectionStart:0,selectionEnd:0});
    root.replaceChildren(old);root.nextChildren=[next];doc.activeElement=old;
    listeners.input({target:old});
    assert.equal(next.focuses,1);
    assert.deepEqual(next.focusOptions,{preventScroll:true});
    assert.deepEqual([next.selectionStart,next.selectionEnd],[1,1]);
    assert.match(root.innerHTML,/value="阿"/);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('statistics hot replacement retains search, sort and focus and rejects invalid snapshots without discarding data',async()=>{
  const previous=globalThis.document;
  try{
    const {doc,root,listeners,view,complete}=await statisticsHarness();
    await complete();
    listeners.input({target:{id:'stats-champion-search',value:'阿'}});
    listeners.change({target:{id:'stats-champion-sort',value:'games'}});
    const old=focusElement(doc,{id:'stats-champion-search',type:'search',value:'阿',selectionStart:1,selectionEnd:1});
    const next=focusElement(doc,{id:'stats-champion-search',type:'search',selectionStart:0,selectionEnd:0});
    root.replaceChildren(old);root.nextChildren=[next];doc.activeElement=old;
    const replacement=structuredClone(snapshot);replacement.champions[0].wins=65;
    view.replaceSnapshot(replacement);
    assert.match(root.innerHTML,/65\.00%/);
    assert.match(root.innerHTML,/value="阿"/);
    assert.match(root.innerHTML,/<option value="games" selected>/);
    assert.equal(next.focuses,1);
    assert.deepEqual([next.selectionStart,next.selectionEnd],[1,1]);
    assert.deepEqual(next.focusOptions,{preventScroll:true});
    assert.throws(()=>view.replaceSnapshot({schemaVersion:99}),TypeError);
    assert.match(view.html(),/65\.00%/);
    assert.match(view.html(),/value="阿"/);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('a replaced snapshot cannot be overwritten by a delayed initial statistics response',async()=>{
  const previous=globalThis.document;
  try{
    const {root,view,complete}=await statisticsHarness();
    const replacement=structuredClone(snapshot);replacement.champions[0].wins=70;
    view.replaceSnapshot(replacement);
    await complete();
    assert.match(root.innerHTML,/70\.00%/);
    assert.doesNotMatch(root.innerHTML,/50\.00%/);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('a statistics refresh keeps the chosen champion and all detail filters',async()=>{
  const previous=globalThis.document;
  try{
    const {root,listeners,view,complete}=await statisticsHarness();await complete();root.scrollIntoView=()=>{};
    const button={dataset:{statsAction:'champion',statsId:'Ahri'},closest:()=>root};
    listeners.click({target:{closest:()=>button}});
    listeners.input({target:{id:'stats-augment-search',value:'闪电'}});
    listeners.change({target:{id:'stats-rarity',value:'gold'}});
    listeners.change({target:{id:'stats-low-sample',checked:true}});
    listeners.change({target:{id:'stats-unavailable',checked:true}});
    const replacement=structuredClone(snapshot);replacement.champions[0].wins=75;
    view.replaceSnapshot(replacement);
    assert.match(root.innerHTML,/返回全部英雄/);
    assert.match(root.innerHTML,/75\.00%/);
    assert.match(root.innerHTML,/value="闪电"/);
    assert.match(root.innerHTML,/<option value="gold" selected>/);
    assert.match(root.innerHTML,/id="stats-low-sample" type="checkbox" checked/);
    assert.match(root.innerHTML,/id="stats-unavailable" type="checkbox" checked/);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

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
  return {doc,root,listeners,async complete(){complete({ok:true,json:async()=>snapshot});await settle();await settle();}};
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

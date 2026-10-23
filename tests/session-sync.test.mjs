import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionSync} from '../dist/session-sync.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('main window hydrates confirmed backend state and publishes later edits',async t=>{
  let state={owned:[],route:'auto'},remote={owned:['firebrand'],route:'spell',revision:2};const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method==='POST'){const value=JSON.parse(options.body);writes.push(value);remote={...value,revision:3};}
    return {ok:true,json:async()=>remote};
  }});t.after(()=>sync.close());await settle();await settle();
  assert.deepEqual(state.owned,['firebrand']);assert.equal(state.route,'spell');assert.equal(writes.length,0);
  state={...state,owned:['firebrand','goliath']};sync.publish();await settle();await settle();
  assert.deepEqual(writes,[{owned:['firebrand','goliath'],route:'spell'}]);
});

test('a stale read and write response cannot overwrite a newer local edit',async t=>{
  let state={owned:[],route:'auto'},releaseRead,releaseFirstWrite;let reads=0;const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method==='POST'){
      const value=JSON.parse(options.body);writes.push(value);
      if(writes.length===1)await new Promise(resolve=>{releaseFirstWrite=resolve;});
      return {ok:true,json:async()=>value};
    }
    if(++reads===2)await new Promise(resolve=>{releaseRead=resolve;});
    return {ok:true,json:async()=>({owned:[],route:'auto'})};
  }});t.after(()=>sync.close());await settle();await settle();
  const stale=sync.pull();await settle();state={owned:['firebrand'],route:'spell'};sync.publish();await settle();
  state={owned:['firebrand','goliath'],route:'tank'};sync.publish();releaseRead();await stale;
  releaseFirstWrite();await settle();await settle();await settle();
  assert.deepEqual(state.owned,['firebrand','goliath']);assert.equal(state.route,'tank');
  assert.equal(writes.length,2);assert.deepEqual(writes[1],{owned:['firebrand','goliath'],route:'tank'});
});

test('an edit made before initial hydration is retained and sent after connection',async t=>{
  let state={owned:[],route:'auto'},releaseRead;const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method==='POST'){const value=JSON.parse(options.body);writes.push(value);return {ok:true,json:async()=>value};}
    await new Promise(resolve=>{releaseRead=resolve;});
    return {ok:true,json:async()=>({owned:['goliath'],route:'tank'})};
  }});t.after(()=>sync.close());await settle();
  state={owned:['firebrand'],route:'spell'};sync.publish();releaseRead();
  await settle();await settle();await settle();
  assert.deepEqual(state.owned,['firebrand']);assert.equal(state.route,'spell');
  assert.deepEqual(writes,[{owned:['firebrand'],route:'spell'}]);
});

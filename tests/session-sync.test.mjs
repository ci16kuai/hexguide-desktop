import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionSync} from '../dist/session-sync.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const session=(value={})=>({owned:[],route:'auto',revision:1,gameEpoch:0,gameId:'fixture-game',...value});
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(value)});
const guards=value=>({expectedRevision:value.revision,expectedGameEpoch:value.gameEpoch,expectedGameId:value.gameId});

test('main window hydrates confirmed backend state and publishes later edits',async t=>{
  let state={owned:[],route:'auto'},remote=session({owned:['firebrand'],route:'spell',revision:2});const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method==='POST'){const value=JSON.parse(options.body);writes.push(value);remote=session({owned:value.owned,route:value.route,revision:3});}
    return response(remote);
  }});t.after(()=>sync.close());await settle();await settle();
  assert.deepEqual(state.owned,['firebrand']);assert.equal(state.route,'spell');assert.equal(writes.length,0);
  state={...state,owned:['firebrand','goliath']};sync.publish();await settle();await settle();
  assert.deepEqual(writes,[{owned:['firebrand','goliath'],route:'spell',...guards(session({revision:2}))}]);
});

test('a stale read and write response cannot overwrite a newer local edit',async t=>{
  let state={owned:[],route:'auto'},releaseRead,releaseFirstWrite,remote=session();let reads=0;const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method==='POST'){
      const value=JSON.parse(options.body);writes.push(value);
      if(writes.length===1)await new Promise(resolve=>{releaseFirstWrite=resolve;});
      remote=session({owned:value.owned,route:value.route,revision:remote.revision+1});
      return response(remote);
    }
    const started=structuredClone(remote);
    if(++reads===2)await new Promise(resolve=>{releaseRead=resolve;});
    return response(started);
  }});t.after(()=>sync.close());await settle();await settle();
  const stale=sync.pull();await settle();state={owned:['firebrand'],route:'spell'};sync.publish();await settle();
  state={owned:['firebrand','goliath'],route:'tank'};sync.publish();releaseRead();await stale;
  releaseFirstWrite();await settle();await settle();await settle();
  assert.deepEqual(state.owned,['firebrand','goliath']);assert.equal(state.route,'tank');
  assert.equal(writes.length,2);assert.deepEqual(writes[1],{owned:['firebrand','goliath'],route:'tank',...guards(session({revision:2}))});
});

test('an explicit edit before hydration is retained when initial owned agrees with the server',async t=>{
  let state={owned:['recursion'],route:'auto'},releaseRead;const writes=[],errors=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},onError:message=>errors.push(message),request:async(_url,options)=>{
    if(options.method==='POST'){const value=JSON.parse(options.body);writes.push(value);return response(session({owned:value.owned,route:value.route,revision:3}));}
    await new Promise(resolve=>{releaseRead=resolve;});
    return response(session({owned:['recursion'],route:'tank',revision:2}));
  }});t.after(()=>sync.close());await settle();
  state={owned:['recursion','firebrand'],route:'spell'};sync.publish();releaseRead();
  await settle();await settle();await settle();
  assert.deepEqual(state.owned,['recursion','firebrand']);assert.equal(state.route,'spell');
  assert.deepEqual(writes,[{owned:['recursion','firebrand'],route:'spell',...guards(session({revision:2}))}]);
  assert.deepEqual(errors,[]);
});

test('first hydration discards an owned edit based on stale UI rather than erasing automatic selections',async t=>{
  let state={owned:['recursion'],route:'auto'},releaseRead;const writes=[],errors=[];
  const remote=session({owned:['goliath'],route:'tank',revision:7});
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},onError:message=>errors.push(message),request:async(_url,options)=>{
    if(options.method==='POST'){writes.push(JSON.parse(options.body));throw Error('An old owned array must not be sent');}
    await new Promise(resolve=>{releaseRead=resolve;});return response(remote);
  }});t.after(()=>sync.close());await settle();
  state={...state,owned:['recursion','firebrand']};sync.publish();releaseRead();
  await settle();await settle();
  assert.deepEqual(state.owned,['goliath']);assert.equal(state.route,'tank');assert.equal(writes.length,0);
  assert.deepEqual(errors,['本局选择已更新，已同步最新记录；请核对后再修改。']);
  sync.publish();await settle();assert.equal(writes.length,0,'applying the authoritative state does not republish stale UI');
});

test('first hydration drops stale ownership but preserves an independent route edit on authoritative owned',async t=>{
  let state={owned:[],route:'auto'},releaseRead;const writes=[],errors=[];
  const remote=session({owned:['goliath'],route:'tank',revision:7});
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},onError:message=>errors.push(message),request:async(_url,options)=>{
    if(options.method==='POST'){
      const value=JSON.parse(options.body);writes.push(value);return response({...remote,route:value.route,revision:8});
    }
    await new Promise(resolve=>{releaseRead=resolve;});return response(remote);
  }});t.after(()=>sync.close());await settle();
  state={owned:['firebrand'],route:'spell'};sync.publish();releaseRead();
  await settle();await settle();
  assert.deepEqual(writes,[{owned:['goliath'],route:'spell',...guards(remote)}]);
  assert.deepEqual(state.owned,['goliath']);assert.equal(state.route,'spell');
  assert.deepEqual(errors,['本局选择已更新，已同步最新记录；请核对后再修改。']);
});

test('a route edit queued before hydration preserves backend automatic confirmations',async t=>{
  let state={owned:[],route:'auto'},releaseRead;const writes=[];
  const remote=session({owned:['firebrand'],revision:7});
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method==='POST'){
      const value=JSON.parse(options.body);writes.push(value);
      return response({...remote,route:value.route,revision:8});
    }
    await new Promise(resolve=>{releaseRead=resolve;});return response(remote);
  }});t.after(()=>sync.close());await settle();
  state={...state,route:'spell'};sync.publish();releaseRead();
  await settle();await settle();
  assert.deepEqual(writes,[{owned:['firebrand'],route:'spell',...guards(remote)}]);
  assert.deepEqual(state.owned,['firebrand']);assert.equal(state.route,'spell');
});

test('automatic confirmation conflicts discard stale full owned arrays and queued owned edits',async t=>{
  let state={owned:[],route:'auto'},releaseWrite;const writes=[],errors=[];
  const automatic=session({owned:['goliath'],revision:2});
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},onError:message=>errors.push(message),request:async(_url,options)=>{
    if(options.method==='POST'){
      writes.push(JSON.parse(options.body));
      await new Promise(resolve=>{releaseWrite=resolve;});
      return response({error:'changed',session:automatic},409);
    }
    return response(session());
  }});t.after(()=>sync.close());await settle();await settle();
  state={...state,owned:['firebrand']};sync.publish();await settle();
  state={...state,owned:['firebrand','recursion']};sync.publish();releaseWrite();
  await settle();await settle();await settle();
  assert.deepEqual(state.owned,['goliath']);assert.equal(writes.length,1,'stale owned edits are never retried with fresh guards');
  assert.deepEqual(errors,['本局选择已更新，已同步最新记录；请核对后再修改。']);
  sync.publish();await settle();assert.equal(writes.length,1,'reconciliation does not create another write');
});

test('a route conflict rebases only the route onto the automatically confirmed owned list',async t=>{
  let state={owned:[],route:'auto'},remote=session();const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method!=='POST')return response(remote);
    const value=JSON.parse(options.body);writes.push(value);
    if(writes.length===1){remote=session({owned:['goliath'],revision:2});return response({session:remote},409);}
    assert.deepEqual(value.owned,['goliath']);assert.equal(value.expectedRevision,2);
    remote={...remote,route:value.route,revision:3};return response(remote);
  }});t.after(()=>sync.close());await settle();await settle();
  state={...state,route:'tank'};sync.publish();await settle();await settle();await settle();
  assert.equal(writes.length,2);assert.deepEqual(state.owned,['goliath']);assert.equal(state.route,'tank');
});

test('a new-game conflict resets local selections and never carries the previous route forward',async t=>{
  let state={owned:[],route:'auto'};const writes=[];
  const next=session({gameId:'next-game',gameEpoch:1,revision:4});
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method!=='POST')return response(session({owned:['firebrand'],revision:3}));
    writes.push(JSON.parse(options.body));return response({session:next},409);
  }});t.after(()=>sync.close());await settle();await settle();
  state={...state,route:'spell'};sync.publish();await settle();await settle();
  assert.deepEqual(state.owned,[]);assert.equal(state.route,'auto');assert.equal(writes.length,1);
});

test('loading authoritative responses clear a pending old selection without retrying it',async t=>{
  let state={owned:[],route:'auto'};const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method!=='POST')return response(session({owned:['firebrand'],revision:3}));
    writes.push(JSON.parse(options.body));return response(session({gameId:'next-game',gameEpoch:1,revision:5}));
  }});t.after(()=>sync.close());await settle();await settle();
  state={...state,owned:['firebrand','recursion']};sync.publish();await settle();await settle();
  assert.deepEqual(state.owned,[]);assert.equal(state.route,'auto');assert.equal(writes.length,1);
});

test('a temporary failed write retains an earlier owned edit when a route edit is already queued',async t=>{
  let state={owned:[],route:'auto'},failWrite;const writes=[];
  const sync=createSessionSync({token:'test',getState:()=>state,applyState:value=>{state=value;},request:async(_url,options)=>{
    if(options.method!=='POST')return response(session());
    const value=JSON.parse(options.body);writes.push(value);
    if(writes.length===1)await new Promise((_,reject)=>{failWrite=()=>reject(Error('temporary connection failure'));});
    return response(session({owned:value.owned,route:value.route,revision:2}));
  }});t.after(()=>sync.close());await settle();await settle();
  state={...state,owned:['firebrand']};sync.publish();await settle();
  state={...state,route:'tank'};sync.publish();failWrite();
  await settle();await settle();await settle();
  assert.equal(writes.length,2);assert.deepEqual(writes[1].owned,['firebrand']);assert.equal(writes[1].route,'tank');
  assert.deepEqual(state.owned,['firebrand']);assert.equal(state.route,'tank');
});

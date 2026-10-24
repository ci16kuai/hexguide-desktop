import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createLocalServer} from '../server/http.mjs';
import {BackgroundSidebar,SessionValidationError} from '../server/sidebar.mjs';

const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const ids=['firebrand','goliath','recursion'];
const guards=value=>({expectedRevision:value.revision,expectedGameEpoch:value.gameEpoch,expectedGameId:value.gameId});
function request(port,target,{headers={},method='GET',body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:target,method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });req.on('error',reject);req.end(body);
  });
}
async function serve(t,sidebar,collector={getSnapshot:()=>({})}){
  const scratch=process.env.HEXGUIDE_TEST_WORK||'H:/Chatgpt/work/2026-10-24/hexguide-desktop/tests';
  await mkdir(scratch,{recursive:true});
  const folder=await mkdtemp(path.join(scratch,'selection-http-'));
  await writeFile(path.join(folder,'index.html'),'<!doctype html><title>fixture</title>');
  const local=await createLocalServer({staticDirectory:folder,sidebar,collector,token:'fixture-selection-token'});
  t.after(async()=>{await local.close();await rm(folder,{recursive:true,force:true});});
  const headers={'X-Hexguide-Session':local.token,'Content-Type':'application/json'};
  return {local,headers,get:target=>request(local.port,target,{headers}),post:(target,value)=>request(local.port,target,{headers,method:'POST',body:JSON.stringify(value)})};
}
function stateFixture(){
  let clock=Date.parse('2026-10-24T00:00:00Z');
  let snapshot={phase:'InProgress',gameId:'game-one',gameTime:600,connection:{status:'connected'},mode:{known:true,isMayhem:true},items:[]};
  const collector={getSnapshot:()=>structuredClone(snapshot)};
  const sidebar=new BackgroundSidebar({collector,data,now:()=>clock,scanner:async()=>({status:'recognized',proposals:ids.map(id=>({id})),selectionCapture:{capturedAt:clock,width:1920,height:1080,originX:0,originY:0,windowHandle:'123456',regions:ids.map((_,column)=>({column,x:100+column*600,y:300,width:300,height:300,signature:Array(192).fill(100+column)}))}})});
  return {sidebar,collector,update:value=>{snapshot={...snapshot,...value};},advance:ms=>{clock+=ms;}};
}

test('selection evidence routes keep native observation behind Host, Origin, token and body limits',async t=>{
  let reads=0,writes=0;
  const observation={provider:'screen',offerToken:'native-private-fixture',capture:{regions:[]}};
  const sidebar={getSelectionObservation:()=>{reads++;return observation;},observeSelectionEvidence:async value=>{writes++;if(value.provider!=='screen')throw new SessionValidationError();return {owned:[{id:'firebrand'}],selection:{status:'waiting'}};},stop:async()=>{}};
  const {local,headers,get,post}=await serve(t,sidebar);
  for(const target of ['/api/selection','/api/selection?token='+local.token]){
    const result=await request(local.port,target);assert.equal(result.status,401);assert.doesNotMatch(JSON.stringify(result.body),/native-private/);
  }
  assert.equal((await request(local.port,'/api/selection',{headers:{...headers,Origin:'null'}})).status,403);
  assert.equal((await request(local.port,'/api/selection',{headers:{...headers,Host:'attacker.example'}})).status,403);
  assert.equal(reads,0);
  assert.deepEqual((await get('/api/selection')).body,observation);
  const body=JSON.stringify({provider:'screen'});
  assert.equal((await request(local.port,'/api/sidebar/selection',{method:'POST',body})).status,401);
  assert.equal((await request(local.port,'/api/sidebar/selection',{headers:{...headers,Origin:'https://foreign.example'},method:'POST',body})).status,403);
  assert.equal((await request(local.port,'/api/sidebar/selection',{headers,method:'POST',body:' '.repeat(4097)})).status,413);
  assert.equal((await request(local.port,'/api/sidebar/selection',{headers,method:'POST',body:'[]'})).status,400);
  assert.equal(writes,0);
  assert.equal((await post('/api/sidebar/selection',{provider:'overwolf'})).status,400);
  const accepted=await post('/api/sidebar/selection',{provider:'screen'});
  assert.equal(accepted.status,200);assert.deepEqual(accepted.body.owned,[{id:'firebrand'}]);assert.equal(writes,2);
});

test('full session HTTP writes require every guard and reject stale state in the same game',async t=>{
  const {sidebar,collector}=stateFixture();
  const {get,post}=await serve(t,sidebar,collector);
  const before=(await get('/api/session')).body;
  const intent={owned:[ids[0]],route:'spell',...guards(before)};
  assert.equal(Number.isSafeInteger(before.gameEpoch),true);
  for(const key of ['expectedRevision','expectedGameEpoch','expectedGameId']){
    const missing={...intent};delete missing[key];assert.equal((await post('/api/session',missing)).status,400,key);
  }
  for(const invalid of [{expectedRevision:-1},{expectedGameEpoch:'0'},{expectedGameId:'../bad'}])assert.equal((await post('/api/session',{...intent,...invalid})).status,400);
  const accepted=await post('/api/session',intent);assert.equal(accepted.status,200);
  const stale=await post('/api/session',{owned:[],route:'tank',...guards(before)});
  assert.equal(stale.status,409);assert.deepEqual(stale.body.session.owned,[ids[0]]);assert.equal(stale.body.session.route,'spell');
  assert.deepEqual((await get('/api/session')).body,stale.body.session);
});

test('screen selection evidence commits once and cannot be erased by an earlier full main-window snapshot',async t=>{
  const {sidebar,collector,advance}=stateFixture();
  const {get,post}=await serve(t,sidebar,collector);
  const stale=(await get('/api/session')).body;
  await sidebar.scan();
  const observation=(await get('/api/selection')).body;
  assert.equal(observation.status,'armed');
  const evidence={provider:observation.provider,offerToken:observation.offerToken,gameId:observation.gameId,gameEpoch:observation.gameEpoch,revision:observation.revision,ids:observation.ids,selectedIndex:0,capturedAt:observation.capturedAt,clickedAt:observation.capturedAt+100,observedAt:observation.capturedAt+400,evidence:{click:true,uniqueFeedback:true,cardsDismissed:true,stableFrames:3,feedbackFrames:1}};
  advance(400);
  const confirmed=await post('/api/sidebar/selection',evidence);
  assert.equal(confirmed.status,200);assert.deepEqual(confirmed.body.owned.map(augment=>augment.id),[ids[0]]);
  assert.equal((await post('/api/sidebar/selection',evidence)).status,409,'native evidence cannot confirm twice');
  const rejected=await post('/api/session',{owned:stale.owned,route:'tank',...guards(stale)});
  assert.equal(rejected.status,409);assert.deepEqual(rejected.body.session.owned,[ids[0]]);
  const route=await post('/api/session',{owned:rejected.body.session.owned,route:'tank',...guards(rejected.body.session)});
  assert.equal(route.status,200);assert.deepEqual(route.body.owned,[ids[0]]);assert.equal(route.body.route,'tank');
});

test('game epoch rejects an old write even when both games have no discovered ID',async t=>{
  const {sidebar,collector,update}=stateFixture();update({gameId:null});
  const {get,post}=await serve(t,sidebar,collector);
  const previous=(await get('/api/session')).body;
  update({stage:'loading',phase:'GameStart',gameTime:0});
  const loading=(await get('/api/session')).body;
  assert.equal(loading.gameId,null);assert.ok(loading.gameEpoch>previous.gameEpoch);
  update({stage:'ingame',phase:'InProgress',gameTime:1});
  // A matching revision alone is insufficient: loading identified a new game.
  const result=await post('/api/session',{owned:[ids[0]],route:'spell',...guards(loading),expectedGameEpoch:previous.gameEpoch});
  assert.equal(result.status,409);assert.deepEqual(result.body.session.owned,[]);assert.equal(result.body.session.route,'auto');
});

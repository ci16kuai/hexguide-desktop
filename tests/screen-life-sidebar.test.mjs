// Synthetic collector/native proofs only. Never read a running game or start a screen scanner.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {BackgroundSidebar,SessionConflictError} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const epoch = Date.parse('2026-10-25T06:00:00Z');
const noCards = {status:'waiting',code:'title-name-unmatched',proposals:[]};
function harness(t) {
  let time = epoch,scans = 0;
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'screen-life-fixture',championId:'Ahri',level:9,gameTime:300,
    mode:{known:true,isMayhem:true},items:[],stats:{},observedAt:new Date(time).toISOString(),life:{status:'unavailable',isDead:null}};
  const collector = {getSnapshot:() => structuredClone(live)};
  const sidebar = new BackgroundSidebar({collector,data,itemsCatalog,now:() => time,scanner:async () => {scans++;return noCards;}});
  t.after(() => sidebar.stop());
  sidebar.getModel();
  const h = {sidebar,collector,time:() => time,scans:() => scans,raw:() => structuredClone(live),
    advance:milliseconds => {time += milliseconds;},update:value => {live = {...live,...value};},refresh:() => {live.observedAt = new Date(time).toISOString();}};
  h.proof = (state,overrides = {}) => ({provider:'screen',gameId:sidebar.session.gameId,gameEpoch:sidebar.gameEpoch,observedAt:time,state,
    code:state === 'dead' ? 'verified-dead-countdown' : state === 'alive' ? 'verified-respawn' : 'unavailable',
    stableFrames:state === 'unknown' ? 0 : 3,countdownSeconds:state === 'dead' ? 10 : null,...overrides});
  return h;
}

test('screen dead and alive proofs between the same collector tick open a single respawn window', async t => {
  const h = harness(t);
  const rawBefore = h.raw();
  assert.equal(h.sidebar.getModel().ocr.schedule.mode,'idle');
  h.advance(500);
  const dead = h.sidebar.observeScreenLife(h.proof('dead'));
  assert.equal(dead.life.source,'screen');
  assert.equal(dead.life.isDead,true);
  assert.equal(dead.ocr.schedule.mode,'dead');
  await h.sidebar.pollOnce();
  assert.equal(h.scans(),0,'death never starts title OCR');
  h.advance(1000);
  const respawn = h.sidebar.observeScreenLife(h.proof('alive'));
  assert.deepEqual(respawn.life,{status:'detected',isDead:false,source:'screen',observedAt:h.time()});
  assert.equal(respawn.ocr.schedule.trigger,'respawn');
  assert.equal(respawn.ocr.schedule.windowRemainingMs,60000);
  assert.equal(respawn.ocr.schedule.intervalMs,500);
  assert.equal(respawn.ocr.schedule.due,true);
  assert.equal(respawn.updatedAt,rawBefore.observedAt,'screen proof never rewrites raw game freshness');
  assert.deepEqual(h.raw(),rawBefore,'collector data and recommendation inputs stay unchanged');
  await h.sidebar.pollOnce();
  assert.equal(h.scans(),1);
  h.advance(500);
  const repeated = h.sidebar.observeScreenLife(h.proof('alive'));
  assert.equal(repeated.ocr.schedule.windowId,respawn.ocr.schedule.windowId);
  assert.equal(repeated.ocr.schedule.windowRemainingMs,59500,'repeat alive cannot renew the deadline');
});

test('fresh API life takes priority and a screen proof cannot override API dead or alive', async t => {
  const h = harness(t);
  h.update({life:{status:'detected',isDead:true}});
  let model = h.sidebar.getModel();
  assert.equal(model.life.source,'live-client');
  assert.equal(model.ocr.schedule.mode,'dead');
  h.advance(500);
  assert.throws(() => h.sidebar.observeScreenLife(h.proof('alive')),SessionConflictError);
  assert.equal(h.sidebar.getModel().life.isDead,true);
  await h.sidebar.pollOnce();
  assert.equal(h.scans(),0);
  h.update({life:{status:'detected',isDead:false}});
  h.refresh();
  model = h.sidebar.getModel();
  assert.equal(model.life.source,'live-client');
  assert.equal(model.life.isDead,false);
  assert.equal(model.ocr.schedule.trigger,'respawn');
  h.advance(1);
  assert.throws(() => h.sidebar.observeScreenLife(h.proof('dead')),SessionConflictError);
  assert.equal(h.sidebar.getModel().life.isDead,false);
});

test('missing LCU game IDs neither discard primary death nor miss a witnessed primary respawn', async t => {
  const h = harness(t);
  h.update({gameId:null,gameTime:5,life:{status:'detected',isDead:true}});
  h.advance(500);
  h.refresh();
  const dead = h.sidebar.getModel();
  assert.equal(dead.life.source,'live-client');
  assert.equal(dead.life.isDead,true);
  assert.equal(dead.ocr.schedule.mode,'dead');
  await h.sidebar.pollOnce();
  assert.equal(h.scans(),0,'a known dead player cannot start opening title OCR just because LCU lost its ID');
  h.advance(500);
  h.update({gameTime:6,life:{status:'detected',isDead:false}});
  h.refresh();
  const respawn = h.sidebar.getModel();
  assert.equal(respawn.life.source,'live-client');
  assert.equal(respawn.ocr.schedule.trigger,'respawn');
  assert.equal(respawn.ocr.schedule.windowRemainingMs,60000);
  assert.equal(respawn.ocr.schedule.intervalMs,500);
  await h.sidebar.pollOnce();
  assert.equal(h.scans(),1);
  assert.throws(() => h.sidebar.observeScreenLife(h.proof('dead',{gameId:'screen-life-fixture'})),SessionConflictError,'screen proof still requires a real matching game ID');
});

test('explicit screen unknown breaks the scheduler chain and cannot turn scope restoration into respawn', t => {
  const h = harness(t);
  h.advance(500);
  h.sidebar.observeScreenLife(h.proof('dead'));
  h.advance(500);
  const unknown = h.sidebar.observeScreenLife(h.proof('unknown'));
  assert.deepEqual(unknown.life,{status:'unavailable',isDead:null,source:'unavailable'});
  assert.equal(unknown.ocr.schedule.due,false);
  h.advance(500);
  assert.throws(() => h.sidebar.observeScreenLife(h.proof('alive')),SessionConflictError);
  h.update({life:{status:'detected',isDead:false}});
  h.refresh();
  const returnedApi = h.sidebar.getModel();
  assert.equal(returnedApi.life.source,'live-client');
  assert.equal(returnedApi.ocr.schedule.mode,'idle');
  assert.equal(returnedApi.ocr.schedule.trigger,null,'a new alive baseline is not a respawn event');
});

test('missing API life never assumes alive or starts title OCR from level and candidate hints', async t => {
  const h = harness(t);
  for (const change of [{}, {life:undefined}, {life:{status:'detected',isDead:'false'}}, {life:{status:'unavailable',isDead:false}}, {level:15}]) {
    h.update(change);
    h.advance(500);
    h.refresh();
    const model = h.sidebar.getModel();
    assert.deepEqual(model.life,{status:'unavailable',isDead:null,source:'unavailable'});
    assert.equal(model.ocr.schedule.due,false);
    await h.sidebar.pollOnce();
  }
  assert.equal(h.scans(),0);
});

test('screen cache display expires without collector keepalives renewing its proof or death timestamp', t => {
  const h = harness(t);
  h.advance(500);
  h.sidebar.observeScreenLife(h.proof('dead'));
  const witnessedDeath = h.sidebar.scanSchedule.lastLife.observedAt;
  h.advance(3001);
  h.refresh();
  assert.equal(h.sidebar.getModel().life.status,'unavailable');
  assert.equal(h.sidebar.scanSchedule.lastLife.observedAt,witnessedDeath);
  h.advance(499);
  const respawn = h.sidebar.observeScreenLife(h.proof('alive'));
  assert.equal(respawn.ocr.schedule.trigger,'respawn','bounded ten-second death history bridges the three-second display expiry');
});

test('old death history and changed games cannot accept a screen alive proof', t => {
  const h = harness(t);
  h.advance(500);
  h.sidebar.observeScreenLife(h.proof('dead'));
  h.advance(10001);
  h.refresh();
  assert.throws(() => h.sidebar.observeScreenLife(h.proof('alive')),SessionConflictError);
  assert.equal(h.sidebar.getModel().ocr.schedule.due,false);
  h.advance(500);
  h.sidebar.observeScreenLife(h.proof('dead'));
  const oldProof = h.proof('alive');
  h.update({gameId:'next-fixture-game',gameTime:300});
  h.advance(500);
  h.refresh();
  const changed = h.sidebar.getModel();
  assert.equal(changed.life.status,'unavailable');
  assert.throws(() => h.sidebar.observeScreenLife({...oldProof,observedAt:h.time()}),SessionConflictError);
  assert.throws(() => h.sidebar.observeScreenLife(h.proof('alive')),SessionConflictError);
});

function request(port,target,{headers = {},method = 'GET',body} = {}) {
  return new Promise((resolve,reject) => {
    const outgoing = http.request({host:'127.0.0.1',port,path:target,method,headers},response => {
      const chunks = [];
      response.on('data',chunk => chunks.push(chunk));
      response.on('end',() => resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });
    outgoing.on('error',reject);
    outgoing.end(body);
  });
}

test('screen-life HTTP endpoint requires the local session, correct host/origin, small JSON and exact proof fields', async t => {
  const h = harness(t);
  const local = await createLocalServer({collector:h.collector,sidebar:h.sidebar,staticDirectory:fileURLToPath(new URL('../dist',import.meta.url)),token:'d'.repeat(64)});
  t.after(() => local.close());
  const headers = {'X-Hexguide-Session':local.token};
  const origin = `http://127.0.0.1:${local.port}`;
  const endpoint = '/api/sidebar/life';
  const body = JSON.stringify(h.proof('dead'));
  assert.equal(local.server.address().address,'127.0.0.1');
  assert.equal((await request(local.port,endpoint,{method:'POST',body})).status,401);
  assert.equal((await request(local.port,endpoint+'?token='+local.token,{method:'POST',body})).status,401);
  assert.equal((await request(local.port,endpoint,{method:'POST',headers:{'X-Hexguide-Session':'wrong'},body})).status,401);
  assert.equal((await request(local.port,endpoint,{method:'POST',headers:{...headers,Host:'attacker.example'},body})).status,403);
  for (const Origin of ['https://attacker.example','null']) assert.equal((await request(local.port,endpoint,{method:'POST',headers:{...headers,Origin},body})).status,403);
  assert.equal((await request(local.port,endpoint,{method:'POST',headers,body:'['})).status,400);
  for (const bad of ['null','[]','false',JSON.stringify({...h.proof('dead'),name:'private text'}),JSON.stringify({...h.proof('dead'),stableFrames:2})]) {
    const response = await request(local.port,endpoint,{method:'POST',headers,body:bad});
    assert.equal(response.status,400);
    assert.ok(!response.body.includes('private text'));
  }
  assert.equal((await request(local.port,endpoint,{method:'POST',headers,body:' '.repeat(4097)})).status,413);
  assert.equal((await request(local.port,endpoint,{method:'PUT',headers,body})).status,405);
  assert.equal((await request(local.port,endpoint,{headers})).status,404);
  assert.equal((await request(local.port,endpoint,{method:'POST',headers,body:JSON.stringify(h.proof('dead',{gameEpoch:99}))})).status,409);
  assert.equal((await request(local.port,endpoint,{method:'POST',headers,body:JSON.stringify(h.proof('dead',{observedAt:h.time()-3001}))})).status,409);
  assert.equal(h.sidebar.getModel().life.status,'unavailable','rejected calls never store a death observation');
  h.advance(500);
  const good = await request(local.port,endpoint,{method:'POST',headers:{...headers,Origin:origin},body:JSON.stringify(h.proof('dead'))});
  assert.equal(good.status,200);
  assert.equal(JSON.parse(good.body).life.source,'screen');
  assert.equal(good.headers['access-control-allow-origin'],undefined);
  assert.equal(good.headers['cache-control'],'no-store');
  assert.equal((await request(local.port,endpoint,{method:'POST',headers,body:JSON.stringify(h.proof('dead'))})).status,409,'replay cannot renew a proof');
  h.advance(1000);
  const returned = await request(local.port,endpoint,{method:'POST',headers,body:JSON.stringify(h.proof('alive'))});
  assert.equal(returned.status,200);
  assert.equal(JSON.parse(returned.body).ocr.schedule.trigger,'respawn');
  assert.equal(h.scans(),0,'proof submission never captures a screen by itself');
});

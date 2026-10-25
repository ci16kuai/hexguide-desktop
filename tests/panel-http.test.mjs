// Local HTTP and synthetic panel classifications only. No game or installed app.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const ids = ['recursion','shrink_engine','jeweled_gauntlet'];

function request(port,target,{headers = {},method = 'GET',body} = {}) {
  return new Promise((resolve,reject) => {
    const outgoing = http.request({host:'127.0.0.1',port,path:target,method,headers},response => {
      const chunks = [];
      response.on('data',chunk => chunks.push(chunk));
      response.on('error',reject);
      response.on('end',() => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({status:response.statusCode,body:text ? JSON.parse(text) : null}); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on('error',reject); outgoing.end(body);
  });
}

function capture(capturedAt) {
  return {capturedAt,width:1920,height:1080,originX:0,originY:0,windowHandle:'12345',
    regions:[0,1,2].map(column => ({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)})),
    identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'synthetic-panel-http',pass:'card-titles-color',
      cards:[0,1,2].map(column => ({column,anchors:[{box:{x:430+column*400,y:350,width:180,height:24},
        feature:Array.from({length:128},(_,index) => index%2 ? 16 : 0)}]}))}};
}

async function harness(t,{candidateIds = ids,recommendationRepository} = {}) {
  let now = Date.parse('2026-10-25T12:00:00Z');
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'panel-http-game',championId:'Ahri',
    gameTime:20,level:3,life:{status:'detected',isDead:false},mode:{known:true,isMayhem:true},
    items:[],stats:{abilityPower:100},observedAt:new Date(now).toISOString()};
  const collector = {getSnapshot:() => structuredClone(live)};
  const sidebar = new BackgroundSidebar({collector,data,itemsCatalog,recommendationRepository,now:() => now,
    scanner:async () => ({status:'recognized',proposals:candidateIds.map(id => ({id})),selectionCapture:capture(now)})});
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-25\\hexguide-panel-http-tests';
  await mkdir(root,{recursive:true});
  const folder = await mkdtemp(path.join(root,'panel-http-'));
  await writeFile(path.join(folder,'index.html'),'<!doctype html><title>Panel HTTP fixture</title>');
  const local = await createLocalServer({staticDirectory:folder,collector,sidebar,token:'synthetic-panel-http-session'});
  t.after(async () => {
    await local.close();
    assert.ok(path.resolve(folder).startsWith(path.resolve(root)+path.sep));
    await rm(folder,{recursive:true,force:true});
  });
  const headers = {'X-Hexguide-Session':local.token,'Content-Type':'application/json'};
  const h = {sidebar,local,headers,
    now:() => now,
    advance(ms) {now += ms;live.observedAt = new Date(now).toISOString();if (typeof live.gameTime === 'number') live.gameTime += ms/1000;},
    update(value) {live = {...live,...value};},
    get:target => request(local.port,target,{headers}),
    post:(target,value) => request(local.port,target,{headers,method:'POST',body:JSON.stringify(value)}),
  };
  h.advance(1);
  assert.equal((await sidebar.scan()).status,'recognized');
  h.scope = (await h.get('/api/sidebar')).body.panelSelection;
  assert.equal(h.scope.status,'watching');
  h.advance(400);
  return h;
}

function proof(h,matching = [0]) {
  const scope = h.scope;
  return {version:2,provider:'panel-icon',glyphs:glyphProof(scope.offers,scope.owned),offerToken:scope.offerToken,gameId:scope.gameId,gameEpoch:scope.gameEpoch,
    revision:scope.revision,ids:[...scope.ids],frames:[0,1,2].map(index => ({captureId:`panel-http-${index}`,
      capturedAt:h.now()-300+index*150,panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,
      geometryKey:'client-1920x1080-hud-100',slots:Array.from({length:6},(_,slotIndex) => ({slotIndex,
        state:slotIndex ? 'empty' : matching.length > 1 ? 'ambiguous' : 'candidate',
        candidateIndices:slotIndex ? [] : [...matching]}))}))};
}

test('panel writes require the local session header and never accept a query-string token',async t => {
  const h = await harness(t), value = proof(h), body = JSON.stringify(value);
  for (const target of ['/api/sidebar/panel','/api/sidebar/panel?token='+h.local.token]) {
    const result = await request(h.local.port,target,{method:'POST',body});
    assert.equal(result.status,401);
    assert.doesNotMatch(JSON.stringify(result.body),/panel-http-game|recursion|synthetic-panel-http-session/);
  }
  assert.equal((await request(h.local.port,'/api/sidebar/panel',{headers:{...h.headers,'X-Hexguide-Session':'wrong'},method:'POST',body})).status,401);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('foreign Host or Origin cannot submit a panel result even with the local token',async t => {
  const h = await harness(t), body = JSON.stringify(proof(h));
  for (const extra of [{Host:'attacker.example'}, {Origin:'https://foreign.example'}, {Origin:'null'}]) {
    const result = await request(h.local.port,'/api/sidebar/panel',{headers:{...h.headers,...extra},method:'POST',body});
    assert.equal(result.status,403);
  }
  const allowed = await request(h.local.port,'/api/sidebar/panel',{
    headers:{...h.headers,Origin:`http://127.0.0.1:${h.local.port}`},method:'POST',body});
  assert.equal(allowed.status,200);
  assert.deepEqual(allowed.body.owned.map(augment => augment.id),[ids[0]]);
});

test('only POST can mutate the panel route; bodyless GET and HEAD do not expose observations',async t => {
  const h = await harness(t);
  for (const method of ['PUT','PATCH','DELETE','OPTIONS']) {
    const response = await request(h.local.port,'/api/sidebar/panel',{headers:h.headers,method});
    assert.equal(response.status,405,method);
  }
  for (const method of ['GET','HEAD']) {
    const response = await request(h.local.port,'/api/sidebar/panel',{headers:h.headers,method});
    assert.equal(response.status,404,method);
  }
  assert.deepEqual(h.sidebar.getSession().owned,[]);
  assert.equal(h.sidebar.getModel().panelSelection.status,'watching');
});

test('panel requests enforce the 4096-byte limit before provider validation',async t => {
  const h = await harness(t);
  const result = await request(h.local.port,'/api/sidebar/panel',{
    headers:h.headers,method:'POST',body:' '.repeat(4097)});
  assert.equal(result.status,413);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
  const value = proof(h);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096,'three bounded classification frames fit the real route');
  assert.equal((await h.post('/api/sidebar/panel',value)).status,200);
});

test('malformed JSON, extra private data and invalid panel classifications return 400 without changing the session',async t => {
  const h = await harness(t), revision = h.sidebar.getSession().revision;
  for (const body of ['not-json','[]','null','{}']) {
    assert.equal((await request(h.local.port,'/api/sidebar/panel',{headers:h.headers,method:'POST',body})).status,400,body);
  }
  for (const change of [value => {value.provider = 'overwolf';},value => {value.rawText = 'private';},
    value => {value.frames[0].image = 'private-pixels';},value => {value.frames[0].slots.pop();},
    value => {value.frames[0].slots[0].candidateIndices = [99];},
    value => {value.glyphs.templates.reverse();},value => {value.glyphs.algorithm = 'different';},
    value => {value.glyphs.templates[0][0] = '0'.repeat(64);},
    value => {delete value.version; delete value.glyphs;}]) {
    const value = proof(h);change(value);
    const response = await h.post('/api/sidebar/panel',value);
    assert.equal(response.status,400);
    assert.doesNotMatch(JSON.stringify(response.body),/private-pixels|rawText|panel-http-game/);
  }
  assert.deepEqual(h.sidebar.getSession().owned,[]);
  assert.equal(h.sidebar.getSession().revision,revision);
});

test('wrong round, game or revision returns a conflict with current session rather than recording stale panel evidence',async t => {
  const h = await harness(t);
  for (const change of [{offerToken:'b'.repeat(32)},{gameId:'other-game'},{gameEpoch:99},{revision:99},
    {ids:[ids[1],ids[0],ids[2]]}]) {
    const result = await h.post('/api/sidebar/panel',{...proof(h),...change});
    assert.equal(result.status,409,JSON.stringify(change));
    assert.deepEqual(result.body.session.owned,[]);
    assert.equal(result.body.session.gameId,'panel-http-game');
  }
  const before = h.sidebar.getSession();
  await h.sidebar.setSession({owned:[],route:'tank',expectedRevision:before.revision,expectedGameEpoch:before.gameEpoch,expectedGameId:before.gameId});
  assert.equal((await h.post('/api/sidebar/panel',proof(h))).status,409,'manual correction revokes the scope before any async write');
  assert.equal(h.sidebar.getSession().route,'tank');
  assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('three stable panel frames update the authoritative plan exactly once and replay conflicts',async t => {
  const h = await harness(t), before = (await h.get('/api/sidebar')).body;
  const value = proof(h,[2]), result = await h.post('/api/sidebar/panel',value);
  assert.equal(result.status,200);
  assert.deepEqual(result.body.owned.map(augment => augment.id),[ids[2]]);
  assert.equal(result.body.owned[0].inferred,undefined);
  assert.equal(result.body.sessionRevision,before.sessionRevision+1);
  assert.deepEqual(result.body.plan.ownedIds,[ids[2]]);
  assert.equal(result.body.plan.sessionRevision,result.body.sessionRevision);
  assert.equal(result.body.plan.gameEpoch,result.body.gameEpoch);
  assert.equal(result.body.plan.gameId,'panel-http-game');
  assert.equal(result.body.plan.championId,'Ahri');
  assert.ok(result.body.plan.nextAugments.every(augment => augment.id !== ids[2]));
  assert.ok(result.body.plan.context.some(line => line.includes(data.augments.find(augment => augment.id === ids[2]).name)));
  assert.equal(result.body.panelSelection.status,'waiting');
  assert.equal(result.body.ocr.schedule.mode,'idle');
  assert.deepEqual(result.body.offers,[]);
  const replay = await h.post('/api/sidebar/panel',value);
  assert.equal(replay.status,409);
  assert.deepEqual(replay.body.session.owned,[ids[2]]);
  assert.equal(replay.body.session.revision,result.body.sessionRevision);
  const after = (await h.get('/api/sidebar')).body;
  assert.equal(after.sessionRevision,result.body.sessionRevision);
  assert.deepEqual(after.plan.ownedIds,[ids[2]]);
});

test('a wrong-champion statistics adapter cannot turn a shared icon into a current-hero inference',async t => {
  const candidateIds = ['eureka','archmage','recursion'];
  const repository = {get:() => ({championId:'Teemo',patch:'16.21',status:'ready',augmentStatistics:{
    eureka:{sampleCount:9000,winRate:.9,patch:'16.21',source:'fixture'},
    archmage:{sampleCount:1000,winRate:.5,patch:'16.21',source:'fixture'},
  }}),ensure:async () => {},close:async () => {}};
  const h = await harness(t,{candidateIds,recommendationRepository:repository});
  assert.equal(data.augments.find(augment => augment.id === candidateIds[0]).icon,data.augments.find(augment => augment.id === candidateIds[1]).icon);
  const result = await h.post('/api/sidebar/panel',proof(h,[0,1]));
  assert.equal(result.status,200);
  assert.deepEqual(result.body.owned,[]);
  assert.equal(result.body.panelSelection.reason,'panel-statistics-unavailable');
  assert.equal(result.body.sessionRevision,h.scope.revision);
});

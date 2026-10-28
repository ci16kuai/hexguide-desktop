// Isolated single-request integration. No real screen, game, player data or app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {BackgroundSidebar, SessionConflictError, SessionValidationError} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const ids = ['recursion','shrink_engine','jeweled_gauntlet'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const capture = capturedAt => ({capturedAt,width:1920,height:1080,originX:0,originY:0,windowHandle:'42',
  regions:[0,1,2].map(column => ({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)})),
  identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'manual-fixture',pass:'card-titles-color',
    cards:[0,1,2].map(column => ({column,anchors:[{box:{x:430+column*400,y:350,width:180,height:24},
      feature:Array.from({length:128},(_,index) => index%2 ? 16 : 0)}]}))}});

function fixture(t) {
  let now = Date.parse('2026-10-28T01:00:00Z'), sequence = 0, scans = 0, writes = 0;
  const timers = new Map();
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'manual-game',championId:'Ahri',
    mode:{known:true,isMayhem:true},gameTime:20,level:3,life:{status:'detected',isDead:false},
    observedAt:new Date(now).toISOString(),items:[],stats:{}};
  const recognized = () => ({status:'recognized',proposals:ids.map(id => ({id})),selectionCapture:capture(now)});
  let scan = recognized;
  const collector = {getSnapshot:() => structuredClone(live)};
  const sidebar = new BackgroundSidebar({collector,data,itemsCatalog,now:() => now,
    timers:{setTimeout(fn,delay) { const id = ++sequence; timers.set(id,{fn,at:now+delay}); return id; },clearTimeout(id) {timers.delete(id);}},
    scanner:async () => { scans++; return scan(); }});
  sidebar.persistRecognition = () => { writes++; return Promise.resolve(); };
  t.after(() => sidebar.stop());
  const advance = ms => {
    now += ms;
    live = {...live,observedAt:new Date(now).toISOString(),gameTime:live.gameTime+ms/1000};
    for (const [id,timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
  };
  return {sidebar,collector,recognized,advance,now:() => now,scans:() => scans,writes:() => writes,
    scan:fn => {scan=fn;},patch:value => {live={...live,...value};}};
}

async function panelRequest(h) {
  h.advance(1); await h.sidebar.scan();
  const original = h.sidebar.getRecognitionModel().panelSelection;
  h.sidebar.setOcr({enabled:false});
  h.scan(() => ({status:'waiting',code:'ocr-no-text',proposals:[]}));
  const pending = h.sidebar.recognizeOnce();
  await settle();
  const model = h.sidebar.getRecognitionModel();
  assert.equal(model.manualRecognition.status,'checking');
  assert.equal(model.panelSelection.status,'watching');
  assert.notEqual(model.panelSelection.offerToken,original.offerToken);
  assert.deepEqual(model.panelSelection.capture,original.capture,'only the independent panel anchor is reused');
  return {pending,scope:model.panelSelection};
}

function proof(h,scope,match = true) {
  return {version:2,provider:'panel-icon',offerToken:scope.offerToken,gameId:scope.gameId,
    gameEpoch:scope.gameEpoch,revision:scope.revision,ids:[...scope.ids],glyphs:glyphProof(scope.offers,scope.owned),
    frames:[0,1,2].map(index => ({captureId:`manual-${index}`,capturedAt:h.now()-300+index*150,
      panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,geometryKey:'manual-1920x1080',
      slots:Array.from({length:6},(_,slotIndex) => ({slotIndex,state:slotIndex || !match ? 'empty' : 'candidate',
        candidateIndices:slotIndex || !match ? [] : [0]}))}))};
}

test('two UI clicks share one promise and OCR capture; three proposals never become owned',async t => {
  const h = fixture(t), gate = deferred(); h.scan(() => gate.promise);
  const first = h.sidebar.recognizeOnce(), second = h.sidebar.recognizeOnce();
  assert.equal(first,second); assert.equal(h.scans(),1);
  const active = h.sidebar.getRecognitionModel().manualRecognition;
  assert.deepEqual(Object.keys(active).sort(),['active','status','message','requestId','startedAt','expiresAt'].sort());
  assert.equal(active.active,true); assert.equal(active.status,'scanning'); assert.equal(active.requestId,1);
  assert.equal(active.expiresAt-active.startedAt,25000);
  h.advance(1); gate.resolve(h.recognized());
  const result = await first;
  assert.equal(result.status,'recognized'); assert.equal(result.proposals.length,3);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
  assert.equal(result.manualRecognition.active,false);
  assert.deepEqual(h.sidebar.getModel().manualRecognition,h.sidebar.getRecognitionModel().manualRecognition);
  assert.equal((await h.sidebar.recognizeOnce()).manualRecognition.requestId,2);
});

test('one manual scan never persists enabled=true or enables direct click observation',async t => {
  const h = fixture(t), gate = deferred(); h.sidebar.setOcr({enabled:false}); h.scan(() => gate.promise);
  const pending = h.sidebar.recognizeOnce();
  const active = h.sidebar.getRecognitionModel();
  assert.equal(active.ocr.enabled,false); assert.equal(active.selection.status,'waiting');
  assert.equal(active.screenObservationScope.eligible,false);
  h.advance(1); gate.resolve(h.recognized()); await pending;
  assert.equal(h.sidebar.getModel().ocr.enabled,false); assert.equal(h.writes(),1);
  assert.equal(h.sidebar.getRecognitionModel().panelSelection.status,'waiting');
});

test('fresh panel proof confirms only after persistence and owned change while auto stays disabled',async t => {
  const h = fixture(t), {pending,scope} = await panelRequest(h), saved = deferred();
  h.sidebar.persist = () => saved.promise;
  h.advance(400);
  const submitted = h.sidebar.observePanelEvidence(proof(h,scope));
  await settle();
  assert.deepEqual(h.sidebar.getSession().owned,[ids[0]]);
  assert.equal(h.sidebar.getRecognitionModel().manualRecognition.active,true,'persistence is still pending');
  saved.resolve(); const model = await submitted, result = await pending;
  assert.equal(result.status,'confirmed'); assert.equal(model.manualRecognition.status,'confirmed');
  assert.equal(model.manualRecognition.active,false); assert.equal(model.ocr.enabled,false);
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h,scope)),SessionConflictError);
});

test('panel confirmation can finish the bounded request while the single OCR capture is still pending',async t => {
  const h = fixture(t); h.advance(1); await h.sidebar.scan(); h.sidebar.setOcr({enabled:false});
  const gate = deferred(); h.scan(() => gate.promise);
  const pending = h.sidebar.recognizeOnce(), scope = h.sidebar.getRecognitionModel().panelSelection;
  h.advance(400); await h.sidebar.observePanelEvidence(proof(h,scope));
  assert.equal((await pending).status,'confirmed');
  gate.resolve(h.recognized()); await settle();
  assert.deepEqual(h.sidebar.getSession().owned,[ids[0]]); assert.deepEqual(h.sidebar.offers,[]);
});

test('accepted panel proof retains completion ownership when OCR returns before persistence finishes',async t => {
  const h = fixture(t); h.advance(1); await h.sidebar.scan(); h.sidebar.setOcr({enabled:false});
  const captureGate = deferred(), saveGate = deferred(); h.scan(() => captureGate.promise);
  const pending = h.sidebar.recognizeOnce(), initial = h.sidebar.getRecognitionModel();
  h.sidebar.persist = () => saveGate.promise; h.advance(400);
  const submitting = h.sidebar.observePanelEvidence(proof(h,initial.panelSelection));
  captureGate.resolve({status:'waiting',proposals:[]}); await settle();
  const saving = h.sidebar.getRecognitionModel();
  assert.deepEqual(h.sidebar.getSession().owned,[ids[0]]);
  assert.equal(saving.manualRecognition.active,true);
  assert.equal(saving.manualRecognition.status,'checking'); assert.match(saving.manualRecognition.message,/保存/);
  assert.equal(saving.manualRecognition.expiresAt,initial.manualRecognition.expiresAt);
  assert.equal(saving.panelSelection.status,'waiting','manual scope cannot accept a second choice while saving');
  saveGate.resolve(); await submitting;
  assert.equal((await pending).status,'confirmed');
});

test('persistence failure cannot report confirmed after accepted panel proof',async t => {
  const h = fixture(t), {pending,scope} = await panelRequest(h);
  h.sidebar.persist = async () => { throw new Error('fixture write failed'); }; h.advance(400);
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h,scope)),/fixture write failed/);
  const result = await pending;
  assert.equal(result.status,'unavailable'); assert.match(result.message,/未能保存/);
  assert.equal(result.manualRecognition.active,false);
});

test('a pending save remains bounded and timeout feedback does not deny already observed owned state',async t => {
  const h = fixture(t), {pending,scope} = await panelRequest(h), saved = deferred();
  h.sidebar.persist = () => saved.promise; h.advance(400);
  const submitting = h.sidebar.observePanelEvidence(proof(h,scope));
  h.advance(5600); const result = await pending;
  assert.equal(result.status,'timeout'); assert.match(result.message,/核对本局已选记录/);
  assert.deepEqual(h.sidebar.getSession().owned,[ids[0]],'timeout never rolls back accepted evidence');
  saved.resolve(); await submitting;
  assert.equal(h.sidebar.getRecognitionModel().manualRecognition.status,'timeout','late persistence cannot rewrite the finished request');
});

test('matching current panel proof rejection is a failure, never a successful selection',async t => {
  const h = fixture(t), {pending,scope} = await panelRequest(h);
  h.advance(400); const bad = proof(h,scope); bad.frames[1].captureId = bad.frames[0].captureId;
  await assert.rejects(h.sidebar.observePanelEvidence(bad),SessionValidationError);
  assert.equal((await pending).status,'unavailable'); assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('accepted shared-icon inference retains its uncertainty in manual feedback and owned labels',async t => {
  const h = fixture(t), collision = ['eureka','archmage','recursion'];
  h.scan(() => ({status:'recognized',proposals:collision.map(id => ({id})),selectionCapture:capture(h.now())}));
  const {pending,scope} = await panelRequest(h); h.advance(400);
  const ambiguous = proof(h,scope);
  for (const frame of ambiguous.frames) frame.slots[0] = {slotIndex:0,state:'ambiguous',candidateIndices:[0,1]};
  const model = await h.sidebar.observePanelEvidence(ambiguous), result = await pending;
  assert.equal(result.status,'confirmed'); assert.match(result.message,/推定已选/);
  assert.equal(model.owned[0].inferred,true); assert.match(model.owned[0].confirmationLabel,/推定/);
});

test('unmatched or unsubmitted panel observations wait at most six seconds and cannot report confirmed',async t => {
  const h = fixture(t), {pending,scope} = await panelRequest(h);
  const expiresAt = h.sidebar.getRecognitionModel().manualRecognition.expiresAt;
  h.advance(400); await h.sidebar.observePanelEvidence(proof(h,scope,false));
  assert.equal(h.sidebar.getRecognitionModel().manualRecognition.active,true);
  for (let index=0;index<4;index++) h.sidebar.getRecognitionModel();
  assert.equal(h.sidebar.getRecognitionModel().manualRecognition.expiresAt,expiresAt,'polling cannot extend authority');
  h.advance(5599); assert.equal(h.sidebar.getRecognitionModel().manualRecognition.active,true);
  h.advance(1); assert.equal((await pending).status,'timeout');
  assert.deepEqual(h.sidebar.getSession().owned,[]);
  assert.equal(h.sidebar.getRecognitionModel().panelSelection.status,'waiting');
});

test('missing references and missing pending rounds produce distinct usable feedback',async t => {
  const h = fixture(t); h.scan(() => ({status:'waiting',proposals:[]}));
  const empty = await h.sidebar.recognizeOnce();
  assert.equal(empty.status,'unavailable'); assert.match(empty.message,/没有待核对/);
  h.scan(() => ({status:'recognized',proposals:ids.map(id => ({id}))})); h.advance(1); await h.sidebar.scan();
  h.scan(() => ({status:'waiting',proposals:[]}));
  const noCapture = await h.sidebar.recognizeOnce();
  assert.equal(noCapture.status,'unavailable'); assert.match(noCapture.message,/先显示三选一卡片/);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('total timeout fences a late OCR result rather than letting it publish new candidates',async t => {
  const h = fixture(t), gate = deferred(); h.scan(() => gate.promise);
  const pending = h.sidebar.recognizeOnce();
  h.advance(25000); assert.equal((await pending).status,'timeout');
  gate.resolve(h.recognized()); await settle();
  assert.deepEqual(h.sidebar.offers,[]); assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('panel wait never extends the original total deadline after slow OCR',async t => {
  const h = fixture(t); h.advance(1); await h.sidebar.scan(); h.sidebar.setOcr({enabled:false});
  const gate = deferred(); h.scan(() => gate.promise);
  const pending = h.sidebar.recognizeOnce();
  const original = h.sidebar.getRecognitionModel().manualRecognition.expiresAt;
  h.advance(22000); gate.resolve({status:'waiting',proposals:[]}); await settle();
  assert.equal(h.sidebar.getRecognitionModel().manualRecognition.status,'checking');
  assert.equal(h.sidebar.getRecognitionModel().manualRecognition.expiresAt,original);
  h.advance(3000); assert.equal((await pending).status,'timeout');
});

test('game boundaries, stale state and life transitions cancel the old capture and authority',async t => {
  for (const patch of [{gameId:'other-game'},{connection:{status:'disconnected'}},{life:{status:'detected',isDead:true}}]) {
    const h = fixture(t), gate = deferred(); h.scan(() => gate.promise);
    const pending = h.sidebar.recognizeOnce();
    h.advance(100); h.patch(patch); h.sidebar.getRecognitionModel();
    assert.equal((await pending).status,'cancelled');
    gate.resolve(h.recognized()); await settle();
    assert.deepEqual(h.sidebar.offers,[]); assert.deepEqual(h.sidebar.getSession().owned,[]);
  }
});

test('completed feedback is cleared at a new game while request IDs remain monotonic',async t => {
  for (const outcome of ['confirmed','unavailable']) {
    const h = fixture(t);
    if (outcome === 'confirmed') {
      const {pending,scope} = await panelRequest(h); h.advance(400);
      await h.sidebar.observePanelEvidence(proof(h,scope)); await pending;
    } else { h.scan(() => ({status:'waiting',proposals:[]})); await h.sidebar.recognizeOnce(); }
    const previous = h.sidebar.getRecognitionModel().manualRecognition;
    assert.equal(previous.status,outcome);
    h.patch({gameId:'new-manual-game'});
    const fresh = h.sidebar.getModel().manualRecognition;
    assert.equal(fresh.active,false); assert.equal(fresh.status,'idle'); assert.equal(fresh.message,'');
    assert.equal(fresh.startedAt,0); assert.equal(fresh.expiresAt,0);
    h.scan(() => ({status:'waiting',proposals:[]}));
    assert.ok((await h.sidebar.recognizeOnce()).manualRecognition.requestId > previous.requestId);
  }
});

test('manual confirmation and settings changes cancel the old request and revoke its proof',async t => {
  for (const action of ['confirm','settings','route']) {
    const h = fixture(t), {pending,scope} = await panelRequest(h);
    if (action === 'confirm') await h.sidebar.confirmOffer({id:ids[1],pendingId:scope.pendingId,gameId:scope.gameId,revision:scope.revision});
    else if (action === 'settings') h.sidebar.setOcr({enabled:false});
    else await h.sidebar.setSession({owned:[],route:'spell'});
    assert.equal((await pending).status,'cancelled'); h.advance(400);
    await assert.rejects(h.sidebar.observePanelEvidence(proof(h,scope)),SessionConflictError);
    assert.deepEqual(h.sidebar.getSession().owned,action === 'confirm' ? [ids[1]] : []);
  }
});

test('manual correction during panel persistence wins and cannot become a delayed confirmed response',async t => {
  const h = fixture(t), {pending,scope} = await panelRequest(h), saved = deferred();
  h.sidebar.persist = () => saved.promise; h.advance(400);
  const submitting = h.sidebar.observePanelEvidence(proof(h,scope));
  const rejected = assert.rejects(submitting,SessionConflictError);
  const correcting = h.sidebar.setSession({owned:[],route:'auto'});
  assert.equal((await pending).status,'cancelled');
  saved.resolve(); await correcting; await rejected;
  assert.deepEqual(h.sidebar.getSession().owned,[]);
  assert.equal(h.sidebar.getRecognitionModel().manualRecognition.status,'cancelled');
});

test('foreground failure ends manual permission without changing the existing capture gates',async t => {
  const h = fixture(t); h.advance(1); await h.sidebar.scan(); h.sidebar.setOcr({enabled:false});
  h.scan(() => ({status:'unavailable',code:'game-not-foreground',proposals:[]}));
  assert.equal((await h.sidebar.recognizeOnce()).status,'unavailable');
  const model = h.sidebar.getRecognitionModel();
  assert.equal(model.manualRecognition.active,false); assert.equal(model.panelSelection.status,'waiting');
  assert.equal(model.selection.status,'waiting'); assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('unknown mode, loading and stale collector data never start manual OCR',async t => {
  for (const patch of [{mode:{known:false,isMayhem:false}},{stage:'loading'},{observedAt:'2020-01-01T00:00:00Z'}]) {
    const h = fixture(t); h.patch(patch);
    assert.equal((await h.sidebar.recognizeOnce()).status,'unavailable'); assert.equal(h.scans(),0);
  }
});

function request(port,{headers = {},method = 'POST',body} = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port,path:'/api/recognize-once',method,headers},res => {
      const chunks = []; res.on('data',chunk => chunks.push(chunk));
      res.on('end',() => resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    }); req.on('error',reject); req.end(body);
  });
}

test('HTTP endpoint preserves authentication, empty-body contract and shared in-flight work',async t => {
  const h = fixture(t), local = await createLocalServer({collector:h.collector,sidebar:h.sidebar,
    staticDirectory:fileURLToPath(new URL('../dist',import.meta.url)),token:'manual-recognition-fixture'});
  t.after(() => local.close());
  const headers = {'X-HexGuide-Session':local.token,'Content-Type':'application/json'};
  assert.equal((await request(local.port)).status,401);
  assert.equal((await request(local.port,{headers:{...headers,Origin:'https://foreign.example'}})).status,403);
  for (const body of ['{"enabled":true}','[]','null','broken']) assert.equal((await request(local.port,{headers,body})).status,400);
  assert.equal(h.scans(),0);
  const gate = deferred(); h.scan(() => gate.promise);
  const first = request(local.port,{headers}), second = request(local.port,{headers,body:'{}'});
  for (let i=0;i<10 && h.scans()===0;i++) await settle();
  await settle(); assert.equal(h.scans(),1);
  h.advance(1); gate.resolve(h.recognized());
  const results = await Promise.all([first,second]);
  assert.equal(results[0].status,200); assert.deepEqual(results[0].body,results[1].body);
  assert.equal(results[0].body.status,'recognized'); assert.equal(h.scans(),1);
});

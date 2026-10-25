// Isolated lifecycle/race fixtures. They never capture, focus, restart or send
// input to a real game; visual classifications below are synthetic attestations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BackgroundSidebar, SessionConflictError} from '../server/sidebar.mjs';
import {OcrScanSchedule} from '../server/ocr-schedule.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const ids = ['recursion','shrink_engine','jeweled_gauntlet'];
const noCards = {status:'waiting',code:'title-name-unmatched',proposals:[]};
const capture = capturedAt => ({capturedAt,width:1920,height:1080,originX:0,originY:0,windowHandle:'12345',
  regions:[0,1,2].map(column => ({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)})),
  identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'lifecycle-fixture',pass:'card-titles-color',
    cards:[0,1,2].map(column => ({column,anchors:[{box:{x:430+column*400,y:350,width:180,height:24},
      feature:Array.from({length:128},(_,index) => index%2 ? 16 : 0)}]}))}});
const cards = time => ({status:'recognized',proposals:ids.map(id => ({id})),selectionCapture:capture(time)});

function fixture({scanner, gameTime = 20} = {}) {
  let now = Date.parse('2026-10-25T12:00:00Z'), scans = 0;
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'lifecycle-fixture',championId:'Ahri',
    gameTime,level:3,life:{status:'detected',isDead:false},mode:{known:true,isMayhem:true},
    items:[],stats:{},observedAt:new Date(now).toISOString()};
  const sidebar = new BackgroundSidebar({collector:{getSnapshot:() => structuredClone(live)},data,itemsCatalog,now:() => now,
    scanner:() => {scans++; return scanner ? scanner({scans,time:() => now}) : Promise.resolve(cards(now));}});
  return {sidebar,time:() => now,scans:() => scans,
    advance(ms, patch = {}) {now += ms; live = {...live,...patch,observedAt:new Date(now).toISOString(),gameTime:live.gameTime+ms/1000};},
    model:() => sidebar.getModel()};
}

function proof(h, scope, selectedIndex = 0) {
  return {version:2,glyphs:glyphProof(scope.offers,scope.owned),provider:'panel-icon',offerToken:scope.offerToken,
    gameId:scope.gameId,gameEpoch:scope.gameEpoch,revision:scope.revision,ids:[...scope.ids],
    frames:[0,1,2].map(index => ({captureId:`lifecycle-panel-${index}`,capturedAt:h.time()-300+index*150,
      panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,geometryKey:'client-1920x1080',
      slots:Array.from({length:6},(_,slotIndex) => ({slotIndex,state:slotIndex ? 'empty' : 'candidate',
        candidateIndices:slotIndex ? [] : [selectedIndex]}))}))};
}

async function offer(h) {
  h.advance(1); assert.equal((await h.sidebar.scan()).status,'recognized');
  const scope = h.model().panelSelection; assert.equal(scope.status,'watching'); return scope;
}

test('lifecycle changes on first death and respawn, independent of pacing and repeated death samples', () => {
  let now = Date.parse('2026-10-25T14:00:00Z');
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameTime:20,
    mode:{known:true,isMayhem:true},life:{status:'detected',isDead:false},observedAt:new Date(now).toISOString()};
  const schedule = new OcrScanSchedule({now:() => now});
  const observe = (ms,patch = {}) => {now += ms; live = {...live,...patch,observedAt:new Date(now).toISOString()}; return schedule.decision({live,gameEpoch:7});};
  const opening = observe(0), lifecycle = schedule.lifecycle;
  assert.equal(observe(60000).mode,'follow-up'); assert.equal(schedule.lifecycle,lifecycle);
  observe(1,{life:{status:'detected',isDead:true}});
  const deadLifecycle = schedule.lifecycle; assert.ok(deadLifecycle > lifecycle);
  assert.equal(schedule.windowId,opening.windowId,'death revokes capture ownership before a new window exists');
  for (let n=0;n<3;n++) {assert.equal(observe(1000).mode,'dead'); assert.equal(schedule.lifecycle,deadLifecycle);}
  schedule.forgetLife(); assert.equal(schedule.lifecycle,deadLifecycle,'focus loss is not a death or a new choice');
  observe(1,{life:{status:'unavailable',isDead:null}}); assert.equal(schedule.lifecycle,deadLifecycle);
  observe(1,{life:{status:'detected',isDead:true}}); const restoredDeath = schedule.lifecycle;
  const respawn = observe(1,{life:{status:'detected',isDead:false}});
  assert.ok(schedule.lifecycle > restoredDeath); assert.notEqual(respawn.windowId,opening.windowId);
  assert.equal(respawn.windowRemainingMs,60000); assert.equal(respawn.intervalMs,500);
});

test('verified death immediately revokes old panel/click proofs and same-ID respawn captures receive a new token', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const old = await offer(h), click = h.sidebar.getSelectionObservation();
  h.advance(400); const oldProof = proof(h,old), cycle = h.model().ocr.schedule.windowId;
  const revision = h.model().sessionRevision, epoch = h.model().gameEpoch;
  h.advance(1000,{life:{status:'detected',isDead:true}});
  assert.equal(h.model().panelSelection.status,'waiting'); assert.deepEqual(h.model().offers,[]);
  await assert.rejects(h.sidebar.observePanelEvidence(oldProof),SessionConflictError);
  h.advance(1000,{life:{status:'detected',isDead:false}});
  const respawn = h.model(); assert.notEqual(respawn.ocr.schedule.windowId,cycle);
  assert.equal(respawn.sessionRevision,revision); assert.equal(respawn.gameEpoch,epoch);
  assert.equal(respawn.panelSelection.status,'waiting');
  await assert.rejects(h.sidebar.observeSelectionEvidence({provider:'screen',offerToken:click.offerToken,
    gameId:click.gameId,gameEpoch:click.gameEpoch,revision:click.revision,ids:click.ids,selectedIndex:0,
    capturedAt:click.capturedAt,clickedAt:click.capturedAt,observedAt:h.time(),
    evidence:{click:true,uniqueFeedback:true,cardsDismissed:true,stableFrames:3,feedbackFrames:1}}),SessionConflictError);
  const fresh = await offer(h); assert.notEqual(fresh.offerToken,old.offerToken);
  await assert.rejects(h.sidebar.observePanelEvidence(oldProof),SessionConflictError);
  assert.equal(h.model().ocr.schedule.mode,'window'); assert.deepEqual(h.model().owned,[]);
  h.advance(400); const confirmed = await h.sidebar.observePanelEvidence(proof(h,fresh,1));
  assert.deepEqual(confirmed.plan.ownedIds,[ids[1]]); assert.equal(confirmed.ocr.schedule.mode,'idle');
});

test('multiple death/respawn cycles revoke every older token even when all three IDs repeat', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); const previous = [];
  for (let cycle=0;cycle<3;cycle++) {
    const current = await offer(h); h.advance(400);
    for (const stale of previous) await assert.rejects(h.sidebar.observePanelEvidence(stale),SessionConflictError);
    previous.push(proof(h,current));
    h.advance(1000,{life:{status:'detected',isDead:true}}); h.model();
    h.advance(1000); const deadLifecycle = h.sidebar.scanSchedule.lifecycle; h.model();
    assert.equal(h.sidebar.scanSchedule.lifecycle,deadLifecycle,'repeated dead snapshots cannot create extra lifecycles');
    h.advance(1000,{life:{status:'detected',isDead:false}}); h.model();
  }
  assert.equal(new Set(previous.map(value => value.offerToken)).size,3); assert.deepEqual(h.model().owned,[]);
});

test('unknown screen/focus evidence preserves the bounded panel lease, while a known mode exit revokes it', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); const current = await offer(h);
  const lifecycle = h.sidebar.scanSchedule.lifecycle;
  h.advance(500,{life:{status:'unavailable',isDead:null}});
  h.sidebar.observeScreenLife({provider:'screen',gameId:current.gameId,gameEpoch:current.gameEpoch,observedAt:h.time(),
    state:'unknown',code:'unavailable',stableFrames:0,countdownSeconds:null});
  assert.equal(h.sidebar.scanSchedule.lifecycle,lifecycle);
  assert.equal(h.model().panelSelection.offerToken,current.offerToken);
  h.advance(60000); const expiredOffers = h.model();
  assert.deepEqual(expiredOffers.offers,[]); assert.equal(expiredOffers.panelSelection.offerToken,current.offerToken);
  h.advance(1,{mode:{known:true,isMayhem:false}}); assert.equal(h.model().panelSelection.status,'waiting');
  const lostLifecycle = h.sidebar.scanSchedule.lifecycle; assert.ok(lostLifecycle > lifecycle);
  h.advance(1,{mode:{known:true,isMayhem:true}}); assert.equal(h.model().panelSelection.status,'waiting');
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h,current)),SessionConflictError);
  assert.deepEqual(h.model().owned,[]); assert.equal(h.model().ocr.schedule.mode,'idle');
});

for (const firstAutomatic of [false,true]) for (const secondAutomatic of [false,true]) {
  for (const boundary of ['death','respawn','other-mode','disconnected','stale-snapshot','inactive-stage']) {
    test(`${firstAutomatic ? 'automatic' : 'manual'} capture shared by ${secondAutomatic ? 'automatic' : 'manual'} caller rejects ${boundary} crossover`, async t => {
      let finish;
      const h = fixture({scanner:({scans}) => scans===1 ? new Promise(resolve => {finish=resolve;}) : Promise.resolve(noCards)});
      t.after(() => h.sidebar.stop()); const capturedAt = h.time();
      const first = h.sidebar.scan({automatic:firstAutomatic}), originalLifecycle = h.sidebar.scanSchedule.lifecycle;
      const patches = {
        death:{life:{status:'detected',isDead:true}},respawn:{life:{status:'detected',isDead:true}},
        'other-mode':{mode:{known:true,isMayhem:false}},disconnected:{connection:{status:'waiting'}},
        'stale-snapshot':{},'inactive-stage':{stage:'waiting'},
      };
      h.advance(1000,patches[boundary]);
      // Even a pending caller must observe and revoke its shared task's scope.
      const second = h.sidebar.scan({automatic:secondAutomatic});
      if (boundary==='respawn' || boundary==='other-mode') {
        h.advance(1000,boundary==='other-mode' ? {mode:{known:true,isMayhem:true}} : {life:{status:'detected',isDead:false}}); h.model();
      }
      if (boundary==='stale-snapshot') {
        // The capture is still fresh; only the collector snapshot has expired.
        h.advance(10001); h.sidebar.collector.getSnapshot = () => ({connection:{status:'connected'},phase:'InProgress',stage:'live',
          gameId:'lifecycle-fixture',championId:'Ahri',gameTime:21,level:3,mode:{known:true,isMayhem:true},
          life:{status:'detected',isDead:false},observedAt:new Date(capturedAt+1000).toISOString()});
      }
      if (['death','respawn','other-mode'].includes(boundary)) assert.ok(h.sidebar.scanSchedule.lifecycle > originalLifecycle);
      else assert.equal(h.sidebar.scanSchedule.lifecycle,originalLifecycle,'temporary eligibility loss cannot create a life event');
      assert.equal(h.scans(),1);
      finish(cards(capturedAt)); const results = await Promise.all([first,second]);
      assert.deepEqual(results[0],results[1]); assert.equal(results[0].status,'waiting'); assert.equal(results[0].code,'scan-context-changed');
      const model = h.model(); assert.deepEqual(model.offers,[]); assert.equal(model.selection.status,'waiting');
      assert.equal(model.panelSelection.status,'waiting'); assert.deepEqual(model.plan.ownedIds,[]);
      assert.equal(h.sidebar.scanSchedule.activeScan,false);
      if (['death','respawn','other-mode'].includes(boundary)) assert.equal(h.sidebar.scanSchedule.lastCompletedAt,null);
      if (boundary==='respawn') {await h.sidebar.pollOnce(); assert.equal(h.scans(),2,'old completion cannot delay a new cycle');}
    });
  }
}

test('manual capture outside automatic windows shares one accepted result without starting automatic work', async t => {
  let finish;
  const h = fixture({gameTime:300,scanner:() => new Promise(resolve => {finish=resolve;})}); t.after(() => h.sidebar.stop());
  const first = h.sidebar.scan(), second = h.sidebar.scan({automatic:true});
  assert.equal(h.scans(),1); finish(cards(h.time()));
  const results = await Promise.all([first,second]); assert.equal(results[0].status,'recognized'); assert.deepEqual(results[0],results[1]);
  const model = h.model(); assert.equal(model.ocr.schedule.mode,'idle'); assert.equal(model.panelSelection.status,'watching');
  await h.sidebar.pollOnce(); assert.equal(h.scans(),1);
});

test('manual and automatic shared capture can cross the fast deadline within the same lifecycle', async t => {
  let finish;
  const h = fixture({scanner:() => new Promise(resolve => {finish=resolve;})}); t.after(() => h.sidebar.stop());
  const initial = h.model(); h.advance(59000); const capturedAt = h.time();
  const manual = h.sidebar.scan(), automatic = h.sidebar.scan({automatic:true}), lifecycle = h.sidebar.scanSchedule.lifecycle;
  h.advance(1001); finish(cards(capturedAt)); const results = await Promise.all([manual,automatic]);
  assert.equal(results[0].status,'recognized'); assert.deepEqual(results[0],results[1]);
  const model = h.model(); assert.equal(h.sidebar.scanSchedule.lifecycle,lifecycle);
  assert.equal(model.ocr.schedule.windowId,initial.ocr.schedule.windowId); assert.equal(model.ocr.schedule.mode,'follow-up');
  assert.equal(model.ocr.schedule.intervalMs,5000); assert.equal(model.panelSelection.status,'watching');
});

test('manual correction defeats an in-flight capture shared with an automatic caller', async t => {
  let finish;
  const h = fixture({scanner:() => new Promise(resolve => {finish=resolve;})}); t.after(() => h.sidebar.stop());
  const first = h.sidebar.scan(), second = h.sidebar.scan({automatic:true});
  await h.sidebar.setSession({owned:[ids[1]],route:'spell'}); finish(cards(h.time()));
  for (const result of await Promise.all([first,second])) assert.equal(result.code,'scan-context-changed');
  const model = h.model(); assert.deepEqual(model.plan.ownedIds,[ids[1]]); assert.equal(model.route,'spell');
  assert.equal(model.ocr.schedule.mode,'idle'); assert.equal(model.panelSelection.status,'waiting');
});

test('a fresh scan cannot establish evidence using a cached capture from before death', async t => {
  let cachedAt;
  const h = fixture({scanner:() => Promise.resolve(cards(cachedAt))}); t.after(() => h.sidebar.stop());
  h.model(); cachedAt = h.time();
  h.advance(1000,{life:{status:'detected',isDead:true}}); h.model();
  h.advance(1000,{life:{status:'detected',isDead:false}}); h.model();
  await h.sidebar.scan(); const model = h.model();
  assert.equal(model.panelSelection.status,'waiting'); assert.equal(model.selection.status,'waiting');
  assert.equal(model.selectionDiagnostics.metadataStatus,'stale'); assert.deepEqual(model.plan.ownedIds,[]);
});

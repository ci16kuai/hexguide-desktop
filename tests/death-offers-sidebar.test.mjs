// Isolated death-card integration; no real game, network, capture or user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BackgroundSidebar, SessionConflictError} from '../server/sidebar.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const firstIds = ['recursion', 'shrink_engine', 'jeweled_gauntlet'];
const nextIds = ['eureka', 'archmage', 'transmute_prismatic'];
const capture = capturedAt => ({capturedAt, width:1920, height:1080, originX:0, originY:0, windowHandle:'12345',
  regions:[0,1,2].map(column => ({column, x:400+column*400, y:200, width:300, height:550, signature:Array(192).fill(80)})),
  identityAnchors:{version:1, algorithm:'luma-sobel-16x8-v1', frameId:'death-display-fixture', pass:'card-titles-color',
    cards:[0,1,2].map(column => ({column, anchors:[{box:{x:430+column*400, y:350, width:180, height:24},
      feature:Array.from({length:128}, (_, index) => index%2 ? 16 : 0)}]}))}});

function harness(t, {dead = true} = {}) {
  let now = Date.parse('2026-10-27T00:00:00Z'), scans = 0, ids = [...firstIds], deferred = false, release = null;
  let live = {connection:{status:'connected'}, phase:'InProgress', stage:'live', gameId:'death-offer-fixture',
    championId:'Ahri', level:3, gameTime:300, life:{status:'detected', isDead:dead}, mode:{known:true, isMayhem:true},
    items:[], stats:{}, observedAt:new Date(now).toISOString()};
  const advance = ms => {now += ms; live.observedAt = new Date(now).toISOString(); live.gameTime += ms/1000;};
  const sidebar = new BackgroundSidebar({collector:{getSnapshot:() => structuredClone(live)}, data, itemsCatalog, now:() => now,
    scanner:async () => {
      scans++; advance(1); // A new capture occurs after the triggering scope boundary.
      const raw = {status:'recognized', proposals:ids.map(id => ({id})), selectionCapture:capture(now)};
      if (deferred) {deferred = false; await new Promise(resolve => {release = resolve;}); release = null;}
      return raw;
    }});
  t.after(async () => {release?.(); await sidebar.stop();});
  return {sidebar, advance, now:() => now, scans:() => scans, model:() => sidebar.getModel(),
    life(isDead) {live.life = {status:'detected', isDead};}, level(value) {live.level = value;}, unknown() {live.life = {status:'unavailable', isDead:null};},
    offers(value) {ids = [...value];}, deferNext() {deferred = true;}, release() {release?.();}};
}

function proof(h, scope, selectedIndex = 0) {
  return {version:2, provider:'panel-icon', glyphs:glyphProof(scope.offers, scope.owned), offerToken:scope.offerToken,
    gameId:scope.gameId, gameEpoch:scope.gameEpoch, revision:scope.revision, ids:[...scope.ids],
    frames:[0,1,2].map(index => ({captureId:`dead-panel-${index}`, capturedAt:h.now()-300+index*150,
      panelVisible:true, gameSurfaceVerified:true, selectionUiVisible:false, geometryKey:'client-1920x1080-hud-100',
      slots:Array.from({length:6}, (_, slotIndex) => ({slotIndex, state:slotIndex ? 'empty' : 'candidate', candidateIndices:slotIndex ? [] : [selectedIndex]}))}))};
}

test('new death cards expose passive panel verification while click routes stay blocked', async t => {
  const h = harness(t);
  await h.sidebar.pollOnce();
  const model = h.model();
  assert.equal(h.scans(), 1);
  assert.deepEqual(model.offers.map(offer => offer.id), firstIds);
  assert.equal(model.ocr.schedule.trigger, 'death');
  assert.deepEqual(model.owned, []);
  assert.equal(model.selection.status, 'waiting');
  assert.equal(model.selectionResult.status, 'waiting');
  assert.equal(model.screenObservationScope.eligible, false);
  assert.equal(model.panelSelection.status, 'watching');
  assert.equal(model.selectionDiagnostics.metadataStatus, 'accepted');
  assert.ok(h.sidebar.pendingOffers.latest.capture, 'validated dead-card geometry is retained as a future anchor');
});

test('new death cards become latest without discarding an older unanswered alive round', async t => {
  const h = harness(t, {dead:false});
  await h.sidebar.scan();
  const old = h.model().pendingOffers[0];
  h.advance(1000); h.level(11); h.life(true); h.offers(nextIds);
  await h.sidebar.pollOnce();
  const model = h.model();
  assert.deepEqual(model.offers.map(offer => offer.id), nextIds);
  assert.equal(model.pendingOffers.length, 2);
  assert.equal(model.pendingOffers[0].pendingId, old.pendingId);
  assert.deepEqual(model.pendingOffers.map(group => group.active), [false, true]);
  assert.deepEqual(model.owned, []);
});

test('dead model polling cannot invalidate a valid asynchronous candidate anchor', async t => {
  const h = harness(t); h.deferNext();
  const reading = h.sidebar.pollOnce();
  const capturedAt = h.now();
  for (let index = 0; index < 8; index++) {h.advance(25); h.model();}
  assert.ok(h.sidebar.selectionObserver.invalidatedAt > capturedAt, 'fixture crossed the selection-only invalidation watermark');
  h.release(); await reading;
  assert.deepEqual(h.model().offers.map(offer => offer.id), firstIds);
  assert.equal(h.sidebar.pendingOffers.latest.capture.capturedAt, capturedAt);
  assert.equal(h.model().selectionDiagnostics.metadataStatus, 'accepted');
  assert.equal(h.model().selection.status, 'waiting');
});

test('an alive OCR completing after death cannot overwrite the fresh death opportunity', async t => {
  const h = harness(t, {dead:false}); h.deferNext();
  const reading = h.sidebar.scan();
  h.advance(1000); h.life(true); h.model(); h.offers(nextIds);
  h.release();
  assert.equal((await reading).code, 'scan-context-changed');
  assert.deepEqual(h.model().offers, []);
  await h.sidebar.pollOnce();
  assert.deepEqual(h.model().offers.map(offer => offer.id), nextIds);
  assert.equal(h.model().selection.status, 'waiting');
});

test('a death OCR completing after respawn is rejected instead of becoming alive click proof', async t => {
  const h = harness(t); h.deferNext();
  const reading = h.sidebar.scan();
  h.advance(1000); h.life(false); h.model();
  h.release();
  assert.equal((await reading).code, 'scan-context-changed');
  assert.deepEqual(h.model().offers, []);
  assert.equal(h.model().selection.status, 'waiting');
  h.offers(nextIds); await h.sidebar.pollOnce();
  assert.deepEqual(h.model().offers.map(offer => offer.id), nextIds);
});

test('a death anchor supports a newly fenced panel after respawn without replaying the original click', async t => {
  const h = harness(t);
  await h.sidebar.pollOnce();
  const anchor = structuredClone(h.sidebar.pendingOffers.latest.capture), scans = h.scans();
  h.advance(1000); h.life(false);
  const alive = h.model(), scope = alive.panelSelection;
  assert.equal(scope.status, 'watching');
  assert.deepEqual(scope.capture, anchor);
  assert.equal(scope.offeredAt, anchor.capturedAt);
  assert.ok(scope.evidenceNotBefore > anchor.capturedAt);
  assert.equal(alive.selection.status, 'waiting', 'the old descriptor is not an alive click observation');
  assert.equal(h.scans(), scans);
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h, scope, 1)), /Invalid panel evidence/);
  h.advance(400);
  const confirmed = await h.sidebar.observePanelEvidence(proof(h, scope, 1));
  assert.deepEqual(confirmed.plan.ownedIds, [firstIds[1]]);
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation, false, 'confirming the same logical round completes the respawn scan');
  assert.deepEqual(confirmed.pendingOffers, []);
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h, scope, 1)), SessionConflictError);
});

test('manual confirmation while dead stays closed across respawn and a later death can open another round', async t => {
  const h = harness(t); await h.sidebar.pollOnce();
  const model = h.model(), group = model.pendingOffers[0];
  await h.sidebar.confirmOffer({id:firstIds[0], pendingId:group.pendingId, gameId:model.gameId, revision:model.sessionRevision});
  const scans = h.scans();
  h.advance(1000); h.life(false); await h.sidebar.pollOnce();
  assert.equal(h.scans(), scans);
  assert.equal(h.model().ocr.schedule.mode, 'idle');
  h.advance(1000); h.life(true); h.offers(nextIds); await h.sidebar.pollOnce();
  assert.equal(h.scans(), scans+1);
  assert.deepEqual(h.model().offers.map(offer => offer.id), nextIds);
});

test('confirming an older round does not stop scanning the newer death round', async t => {
  const h = harness(t, {dead:false}); await h.sidebar.scan();
  const old = h.model().pendingOffers[0];
  h.advance(1000); h.level(11); h.life(true); h.offers(nextIds); await h.sidebar.pollOnce();
  const current = h.model(), scans = h.scans();
  await h.sidebar.confirmOffer({id:firstIds[0], pendingId:old.pendingId, gameId:current.gameId, revision:current.sessionRevision});
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation, true);
  h.advance(500); await h.sidebar.pollOnce();
  assert.equal(h.scans(), scans+1);
  assert.deepEqual(h.model().offers.map(offer => offer.id), nextIds);
  assert.equal(h.model().pendingOffers.length, 1);
});

test('reroll immediately after respawn replaces its dead round before another original-title scan', async t => {
  const h = harness(t); await h.sidebar.pollOnce();
  const dead = h.model(), cycle = h.sidebar.scanSchedule.offerCycle;
  h.advance(1000); h.life(false); h.model(); h.offers(nextIds);
  await h.sidebar.scan();
  const rerolled = h.model();
  assert.equal(h.sidebar.scanSchedule.offerCycle, cycle);
  assert.equal(rerolled.pendingOffers.length, 1);
  assert.equal(rerolled.pendingOffers[0].sequence, dead.pendingOffers[0].sequence);
  assert.notEqual(rerolled.pendingOffers[0].pendingId, dead.pendingOffers[0].pendingId);
  assert.deepEqual(rerolled.offers.map(offer => offer.id), nextIds);
});

test('unknown death continuity pauses candidate and click scans while retaining passive panel verification', async t => {
  const h = harness(t); await h.sidebar.pollOnce();
  const original = h.model(), cycle = h.sidebar.scanSchedule.offerCycle, scans = h.scans();
  h.sidebar.scanSchedule.forgetLife(); h.advance(100); h.unknown();
  await h.sidebar.pollOnce();
  assert.equal(h.scans(), scans);
  assert.equal(h.model().ocr.schedule.mode, 'unknown');
  assert.equal(h.model().screenObservationScope.eligible, false);
  assert.equal(h.model().panelSelection.status, 'watching');
  h.advance(65000); h.life(true); await h.sidebar.pollOnce();
  const resumed = h.model();
  assert.equal(h.sidebar.scanSchedule.offerCycle, cycle);
  assert.equal(resumed.ocr.schedule.windowId, original.ocr.schedule.windowId);
  assert.equal(resumed.ocr.schedule.mode, 'follow-up');
  assert.equal(resumed.ocr.schedule.intervalMs, 5000);
  assert.equal(resumed.selection.status, 'waiting');
});

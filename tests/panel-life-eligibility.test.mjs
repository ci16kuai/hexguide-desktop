// Synthetic collector, OCR metadata and native panel proofs only. No game,
// screen capture, user state, filesystem writes or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BackgroundSidebar, SessionConflictError, SessionValidationError} from '../server/sidebar.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const ids = ['recursion', 'shrink_engine', 'jeweled_gauntlet'];
const nextIds = ['eureka', 'archmage', 'transmute_prismatic'];
const unknownLife = () => ({status:'unavailable', isDead:null});
const apiLife = isDead => ({status:'detected', isDead});

function capture(capturedAt) {
  return {capturedAt, width:1920, height:1080, originX:0, originY:0, windowHandle:'12345',
    regions:[0,1,2].map(column => ({column, x:400+column*400, y:200, width:300, height:550, signature:Array(192).fill(80)})),
    identityAnchors:{version:1, algorithm:'luma-sobel-16x8-v1', frameId:'panel-life-fixture', pass:'card-titles-color',
      cards:[0,1,2].map(column => ({column, anchors:[{box:{x:430+column*400, y:350, width:180, height:24},
        feature:Array.from({length:128}, (_, index) => index%2 ? 16 : 0)}]}))}};
}

function harness(t, {life = apiLife(false)} = {}) {
  let now = Date.parse('2026-10-27T00:00:00Z'), offers = [...ids], scans = 0;
  let live = {connection:{status:'connected'}, phase:'InProgress', stage:'live', gameId:'panel-life-fixture',
    championId:'Ahri', level:7, gameTime:300, life, mode:{known:true, isMayhem:true}, items:[], stats:{},
    observedAt:new Date(now).toISOString()};
  const advance = (milliseconds, refresh = true) => {
    now += milliseconds;
    if (refresh) {live.observedAt = new Date(now).toISOString(); live.gameTime += milliseconds/1000;}
  };
  const sidebar = new BackgroundSidebar({collector:{getSnapshot:() => structuredClone(live)}, data, itemsCatalog,
    now:() => now, scanner:async () => {
      scans++; advance(1);
      return {status:'recognized', proposals:offers.map(id => ({id})), selectionCapture:capture(now)};
    }});
  t.after(() => sidebar.stop());
  return {sidebar, advance, now:() => now, scans:() => scans, model:() => sidebar.getModel(),
    update(value) {live = {...live, ...value};}, offers(value) {offers = [...value];},
    lifeProof(state) {return {provider:'screen', gameId:sidebar.session.gameId, gameEpoch:sidebar.gameEpoch,
      observedAt:now, state, code:state === 'dead' ? 'verified-dead-countdown' : state === 'alive' ? 'verified-respawn' : 'unavailable',
      stableFrames:state === 'unknown' ? 0 : 3, countdownSeconds:state === 'dead' ? 10 : null};}};
}

async function recognize(h) {
  assert.equal((await h.sidebar.scan()).status, 'recognized');
  const model = h.model();
  assert.equal(model.selectionDiagnostics.metadataStatus, 'accepted');
  assert.ok(h.sidebar.pendingOffers.latest.capture);
  return model;
}

function proof(h, scope, selectedIndex = 1) {
  return {version:2, provider:'panel-icon', glyphs:glyphProof(scope.offers, scope.owned), offerToken:scope.offerToken,
    gameId:scope.gameId, gameEpoch:scope.gameEpoch, revision:scope.revision, ids:[...scope.ids],
    frames:[0,1,2].map(index => ({captureId:`panel-life-${h.now()}-${index}`, capturedAt:h.now()-300+index*150,
      panelVisible:true, gameSurfaceVerified:true, selectionUiVisible:false, geometryKey:'client-1920x1080-hud-100',
      slots:Array.from({length:6}, (_, slotIndex) => ({slotIndex, state:slotIndex ? 'empty' : 'candidate',
        candidateIndices:slotIndex ? [] : [selectedIndex]}))}))};
}

function assertClickBlocked(model) {
  assert.equal(model.selection.status, 'waiting');
  assert.equal(model.selectionResult.status, 'waiting');
  assert.equal(model.screenObservationScope.eligible, false);
}

test('fresh death candidates allow a passive panel confirmation while click and screen routes stay blocked', async t => {
  const h = harness(t, {life:apiLife(true)}), model = await recognize(h);
  assertClickBlocked(model);
  assert.equal(model.panelSelection.status, 'watching');
  assert.deepEqual(model.owned, []);
  h.advance(400);
  const confirmed = await h.sidebar.observePanelEvidence(proof(h, model.panelSelection));
  assert.deepEqual(confirmed.plan.ownedIds, [ids[1]]);
  assertClickBlocked(confirmed);
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation, false);
});

test('unknown life after a verified death permits retained panel evidence without inventing an alive state', async t => {
  const h = harness(t, {life:apiLife(true)});
  await recognize(h);
  h.advance(1000); h.update({life:unknownLife()});
  const model = h.model();
  assert.equal(model.life.isDead, null);
  assert.equal(model.ocr.schedule.mode, 'unknown');
  assertClickBlocked(model);
  assert.equal(model.panelSelection.status, 'watching');
  h.advance(400);
  const confirmed = await h.sidebar.observePanelEvidence(proof(h, model.panelSelection));
  assert.deepEqual(confirmed.plan.ownedIds, [ids[1]]);
  assert.equal(confirmed.life.isDead, null);
  assertClickBlocked(confirmed);
});

test('death and respawn each fence old panel tokens while accepting only new independent frames', async t => {
  const h = harness(t), alive = await recognize(h), original = alive.panelSelection;
  h.advance(400); const beforeDeath = proof(h, original);
  h.advance(1000); h.update({life:apiLife(true)});
  const dead = h.model(), deadScope = dead.panelSelection;
  assertClickBlocked(dead);
  assert.equal(deadScope.status, 'watching');
  assert.notEqual(deadScope.offerToken, original.offerToken);
  assert.deepEqual(deadScope.capture, original.capture);
  await assert.rejects(h.sidebar.observePanelEvidence(beforeDeath), SessionConflictError);
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h, deadScope)), SessionValidationError);
  h.advance(400); const beforeRespawn = proof(h, deadScope);
  h.advance(1000); h.update({life:apiLife(false)});
  const respawn = h.model(), respawnScope = respawn.panelSelection;
  assert.equal(respawnScope.status, 'watching');
  assert.notEqual(respawnScope.offerToken, deadScope.offerToken);
  await assert.rejects(h.sidebar.observePanelEvidence(beforeRespawn), SessionConflictError);
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h, respawnScope)), SessionValidationError);
  assert.equal(respawn.selection.status, 'waiting', 'a retained anchor is not new click evidence');
  h.advance(400);
  const confirmed = await h.sidebar.observePanelEvidence(proof(h, respawnScope));
  assert.deepEqual(confirmed.plan.ownedIds, [ids[1]]);
});

test('a panel choice confirmed while dead remains closed through respawn and permits a later new death round', async t => {
  const h = harness(t, {life:apiLife(true)}), model = await recognize(h);
  assert.equal(model.panelSelection.status, 'watching');
  const cycle = h.sidebar.scanSchedule.offerCycle;
  h.advance(400);
  await h.sidebar.observePanelEvidence(proof(h, model.panelSelection));
  assert.equal(h.sidebar.scanSchedule.confirmedOfferCycle, cycle);
  h.advance(1000); h.update({life:apiLife(false)});
  const respawn = h.model();
  assert.equal(h.sidebar.scanSchedule.offerCycle, cycle);
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation, false);
  assert.deepEqual(respawn.pendingOffers, []);
  assert.equal(respawn.panelSelection.status, 'waiting');
  h.advance(1000); h.update({life:apiLife(true)}); h.offers(nextIds);
  const next = await recognize(h);
  assert.notEqual(h.sidebar.scanSchedule.offerCycle, cycle);
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation, true);
  assert.deepEqual(next.offers.map(offer => offer.id), nextIds);
  assert.equal(next.panelSelection.status, 'watching');
  assert.deepEqual(next.plan.ownedIds, [ids[1]]);
});

test('explicit screen-life scope loss rotates panel evidence without requiring a recovered alive flag', async t => {
  const h = harness(t, {life:unknownLife()});
  await recognize(h);
  h.advance(500);
  const dead = h.sidebar.observeScreenLife(h.lifeProof('dead'));
  assert.equal(dead.panelSelection.status, 'watching');
  assertClickBlocked(dead);
  h.advance(400); const stale = proof(h, dead.panelSelection), lifecycle = h.sidebar.scanSchedule.lifecycle;
  h.advance(100);
  const unknown = h.sidebar.observeScreenLife(h.lifeProof('unknown'));
  assert.ok(h.sidebar.scanSchedule.lifecycle > lifecycle);
  assert.equal(unknown.panelSelection.status, 'watching');
  assert.notEqual(unknown.panelSelection.offerToken, dead.panelSelection.offerToken);
  assertClickBlocked(unknown);
  await assert.rejects(h.sidebar.observePanelEvidence(stale), SessionConflictError);
  h.advance(400);
  assert.deepEqual((await h.sidebar.observePanelEvidence(proof(h, unknown.panelSelection))).plan.ownedIds, [ids[1]]);
});

for (const boundary of ['disconnected', 'inactive-stage', 'stale-snapshot', 'unknown-mode', 'other-mode', 'unknown-champion', 'paused']) {
  test(`passive panel observation stays closed for ${boundary} and recovery requires a fresh evidence fence`, async t => {
    const h = harness(t), original = (await recognize(h)).panelSelection;
    h.advance(400); const stale = proof(h, original);
    if (boundary === 'stale-snapshot') h.advance(11001, false);
    else {
      h.advance(1000);
      if (boundary === 'disconnected') h.update({connection:{status:'waiting'}});
      if (boundary === 'inactive-stage') h.update({stage:'waiting'});
      if (boundary === 'unknown-mode') h.update({mode:{known:false, isMayhem:false}});
      if (boundary === 'other-mode') h.update({mode:{known:true, isMayhem:false}});
      if (boundary === 'unknown-champion') h.update({championId:'not-a-catalog-champion'});
      if (boundary === 'paused') h.sidebar.setOcr({enabled:false});
    }
    assert.equal(h.model().panelSelection.status, 'waiting');
    await assert.rejects(h.sidebar.observePanelEvidence(stale), SessionConflictError);
    assert.deepEqual(h.model().plan?.ownedIds || [], []);
    h.advance(1000);
    h.update({connection:{status:'connected'}, stage:'live', mode:{known:true, isMayhem:true}, championId:'Ahri'});
    if (boundary === 'paused') h.sidebar.setOcr({enabled:true});
    const recovered = h.model().panelSelection;
    assert.equal(recovered.status, 'watching');
    assert.notEqual(recovered.offerToken, original.offerToken);
    await assert.rejects(h.sidebar.observePanelEvidence(stale), SessionConflictError);
    await assert.rejects(h.sidebar.observePanelEvidence(proof(h, recovered)), SessionValidationError);
    h.advance(400);
    assert.deepEqual((await h.sidebar.observePanelEvidence(proof(h, recovered))).plan.ownedIds, [ids[1]]);
  });
}

test('fresh raw game context remains eligible when screen evidence is newer, then closes when raw context expires', async t => {
  const h = harness(t, {life:unknownLife()});
  await recognize(h);
  h.advance(500, false);
  const dead = h.sidebar.observeScreenLife(h.lifeProof('dead'));
  assert.equal(dead.panelSelection.status, 'watching');
  assertClickBlocked(dead);
  h.advance(10001, false);
  assert.equal(h.model().panelSelection.status, 'waiting');
});

for (const restriction of ['panel-hidden', 'selection-ui-visible', 'unverified-game', 'unstable-slots', 'too-few-frames']) {
  test(`allowing dead panel observation still refuses ${restriction} evidence`, async t => {
    const h = harness(t, {life:apiLife(true)}), model = await recognize(h);
    assert.equal(model.panelSelection.status, 'watching');
    h.advance(400); const evidence = proof(h, model.panelSelection);
    if (restriction === 'panel-hidden') for (const frame of evidence.frames) frame.panelVisible = false;
    if (restriction === 'selection-ui-visible') for (const frame of evidence.frames) frame.selectionUiVisible = true;
    if (restriction === 'unverified-game') for (const frame of evidence.frames) frame.gameSurfaceVerified = false;
    if (restriction === 'unstable-slots') evidence.frames[1].slots[0].candidateIndices = [2];
    if (restriction === 'too-few-frames') evidence.frames.pop();
    if (restriction === 'too-few-frames') await assert.rejects(h.sidebar.observePanelEvidence(evidence), SessionValidationError);
    else assert.deepEqual((await h.sidebar.observePanelEvidence(evidence)).plan.ownedIds, []);
    assert.deepEqual(h.model().owned, []);
    assertClickBlocked(h.model());
  });
}

test('a new game discards the old pending panel scope even while its player is dead', async t => {
  const h = harness(t), original = (await recognize(h)).panelSelection;
  h.advance(400); const stale = proof(h, original);
  h.advance(1000); h.update({gameId:'another-panel-life-game', life:apiLife(true)});
  const model = h.model();
  assert.notEqual(model.gameEpoch, original.gameEpoch);
  assert.equal(model.panelSelection.status, 'waiting');
  assert.deepEqual(model.pendingOffers, []);
  await assert.rejects(h.sidebar.observePanelEvidence(stale), SessionConflictError);
});

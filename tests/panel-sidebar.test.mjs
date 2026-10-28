// Isolated player-opened panel integration. No game capture, input or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar, SessionConflictError, SessionValidationError} from '../server/sidebar.mjs';
import {RecommendationRepository} from '../server/recommendation-repository.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const ordinaryIds = ['recursion', 'shrink_engine', 'jeweled_gauntlet'];
const collisionIds = ['eureka', 'archmage', 'recursion'];
const definition = id => data.augments.find(augment => augment.id === id);
const metrics = (value = {}) => ({sampleCount:1000, winRate:.55, pickRate:.25, ...value});

function capture(capturedAt, anchors = true) {
  return {capturedAt, width:1920, height:1080, originX:0, originY:0, windowHandle:'12345',
    regions:[0,1,2].map(column => ({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)})),
    ...(anchors ? {identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'isolated-panel-round',pass:'card-titles-color',
      cards:[0,1,2].map(column => ({column,anchors:[{box:{x:430+column*400,y:350,width:180,height:24},
        feature:Array.from({length:128},(_,index) => index%2 ? 16 : 0)}]}))}} : {})};
}

function fixture({ids = ordinaryIds, dataDirectory, recommendationRepository} = {}) {
  let now = Date.parse('2026-10-25T12:00:00Z'), offers = [...ids], anchors = true;
  let mutateCapture = value => value;
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'panel-custom-one',championId:'Ahri',
    gameTime:20,level:3,life:{status:'detected',isDead:false},mode:{known:true,isMayhem:true},
    items:[],stats:{abilityPower:100},observedAt:new Date(now).toISOString()};
  const collector = {getSnapshot:() => structuredClone(live)};
  const sidebar = new BackgroundSidebar({collector,data,itemsCatalog,dataDirectory,recommendationRepository,now:() => now,
    scanner:async () => ({status:'recognized',proposals:offers.map(id => ({id})),selectionCapture:mutateCapture(capture(now,anchors))})});
  return {sidebar,collector,now:() => now,
    advance(ms) {now += ms;live.observedAt = new Date(now).toISOString();if (typeof live.gameTime === 'number') live.gameTime += ms/1000;},
    update(value) {live = {...live,...value};},
    setOffers(value) {offers = [...value];}, setAnchors(value) {anchors = value;},
    setCaptureTransform(value) {mutateCapture = value;}};
}

async function recognized(h) {
  h.advance(1); assert.equal((await h.sidebar.scan()).status,'recognized');
  const scope = h.sidebar.getModel().panelSelection;
  assert.equal(scope.status,'watching');
  return scope;
}

test('unanswered result scopes retain their original time and do not expire while polled',async()=>{
  const h=fixture();
  const first=await recognized(h);
  h.advance(150000);
  h.sidebar.getModel();
  const renewed=await recognized(h);
  assert.equal(renewed.offeredAt,first.offeredAt,'a recheck does not pretend the original scope was newly captured');
  h.advance(200000);
  assert.equal(h.sidebar.getModel().panelSelection.status,'watching','renewal covers later player-opened panel');
  h.advance(100001);
  assert.equal(h.sidebar.getModel().panelSelection.status,'watching','logical unanswered rounds remain eligible');
});

test('fresh OCR geometry replaces the pending panel scope and requires independent proof in the new layout', async t => {
  for (const transform of [
    value => ({...value,originX:100}),
    value => ({...value,originY:80}),
    value => ({...value,width:2560,height:1440}),
    value => ({...value,windowHandle:'98765'}),
    value => ({...value,regions:value.regions.map(region => ({...region,y:region.y+10}))}),
    value => ({...value,identityAnchors:{...value.identityAnchors,cards:value.identityAnchors.cards.map(card => ({...card,
      anchors:card.anchors.map(anchor => ({...anchor,box:{...anchor.box,y:anchor.box.y+10}}))}))}}),
  ]) {
    const h = fixture(); t.after(() => h.sidebar.stop()); const first = await recognized(h);
    h.advance(400); const oldProof = proof(h,first,[1]);
    h.setCaptureTransform(transform); h.advance(100); const refreshed = await recognized(h);
    assert.notEqual(refreshed.offerToken,first.offerToken,'old geometry cannot remain the native capture reference');
    assert.deepEqual(refreshed.capture,h.sidebar.pendingOffers.latest.capture);
    assert.equal(refreshed.evidenceNotBefore,h.now());
    await assert.rejects(h.sidebar.observePanelEvidence(oldProof),SessionConflictError);
    h.advance(400);
    const confirmed = await h.sidebar.observePanelEvidence(proof(h,refreshed,[1]));
    assert.deepEqual(confirmed.plan.ownedIds,[ordinaryIds[1]]);
  }
});

test('same-geometry OCR refreshes do not reset panel tokens or starve multi-frame stability', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); const first = await recognized(h);
  h.setCaptureTransform(value => ({...value,
    regions:value.regions.map(region => ({...region,signature:Array(192).fill(90)})),
    identityAnchors:{...value.identityAnchors,frameId:'different-capture',pass:'card-titles-contrast',
      cards:value.identityAnchors.cards.map(card => ({...card,anchors:card.anchors.map(anchor => ({...anchor,
        feature:Array.from({length:128},(_,index) => index%2 ? 24 : 0)}))}))}}));
  h.advance(150); await recognized(h); h.advance(150); const refreshed = await recognized(h);
  assert.equal(refreshed.offerToken,first.offerToken);
  assert.equal(refreshed.evidenceNotBefore,first.evidenceNotBefore);
  assert.deepEqual(refreshed.capture,first.capture,'updated pixels and timestamps do not replace a stable geometry lease');
  const confirmed = await h.sidebar.observePanelEvidence(proof(h,first,[1]));
  assert.deepEqual(confirmed.plan.ownedIds,[ordinaryIds[1]]);
});

test('stale, future and manually invalidated OCR cannot establish a panel result scope', async()=>{
  for (const offset of [-31000,1001,0]) {
    const now=Date.parse('2026-10-25T15:00:00Z');
    const live={connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'fresh-panel',championId:'Ahri',
      gameTime:10,mode:{known:true,isMayhem:true},observedAt:new Date(now).toISOString()};
    const sidebar=new BackgroundSidebar({collector:{getSnapshot:()=>live},data,itemsCatalog,now:()=>now,
      scanner:async()=>({status:'recognized',proposals:ordinaryIds.map(id=>({id})),selectionCapture:capture(now+offset)})});
    if(offset===0) await sidebar.setSession({owned:[],route:'spell'});
    await sidebar.scan();
    assert.equal(sidebar.getModel().panelSelection.status,'waiting',String(offset));
  }
});

function proof(h, scope, matching = [0]) {
  return {version:2,glyphs:glyphProof(scope.offers,scope.owned),provider:'panel-icon',offerToken:scope.offerToken,gameId:scope.gameId,gameEpoch:scope.gameEpoch,
    revision:scope.revision,ids:[...scope.ids],frames:[0,1,2].map(index => ({captureId:`isolated-panel-${index}`,
      capturedAt:h.now()-300+index*150,panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,
      geometryKey:'client-1920x1080-hud-100',slots:Array.from({length:6},(_,slotIndex) => ({slotIndex,
        state:slotIndex ? 'empty' : matching.length > 1 ? 'ambiguous' : 'candidate',
        candidateIndices:slotIndex ? [] : [...matching]}))}))};
}

async function folder(t) {
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-25\\hexguide-panel-sidebar-tests';
  await mkdir(root,{recursive:true});
  const directory = await mkdtemp(path.join(root,'panel-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(root)+path.sep));
    await rm(directory,{recursive:true,force:true});
  });
  return directory;
}

function aggregate(h, usages = [1000,800], rates = [.4,.8]) {
  const augments = collisionIds.map((id,index) => metrics({id:definition(id).gameDataId,
    sampleCount:usages[index] || 600,winRate:rates[index] || .55}));
  const itemGroup = id => metrics({all:[metrics({id})],slots:{1:[metrics({id})]}});
  return {championId:103,
    meta:{sourceName:'ARAMKit',sourceUrl:'https://aramkit.com/',patch:'16.21',dataDate:'2026-10-25',
      buildTimeUnixMs:h.now()-3600000,fetchedAt:new Date(h.now()).toISOString(),dataPath:'data/16.21-panel-fixture',scope:'all',pairCoverage:'published-top-10'},
    detail:{champion:{id:103,stats:metrics()},augmentCombinations:[metrics({augmentIds:[definition('eureka').gameDataId,definition('recursion').gameDataId]})],
      augments:{all:augments},items:{filtered:itemGroup(3100),unfiltered:itemGroup(3100)}},
    single:{items:collisionIds.map((id,index) => ({augmentId:definition(id).gameDataId,...itemGroup([3089,3116,3135][index])})),builds:[]}};
}

async function repositoryFor(h, usages, rates) {
  const repository = new RecommendationRepository({champions:data.champions,augments:data.augments,now:h.now,
    client:{async load() {return aggregate(h,usages,rates);}},referenceClient:{async load() {return null;}}});
  await repository.ensure('Ahri');
  assert.equal(repository.get('Ahri').mayhemStatus,'ready','fixture must pass the real source validator');
  return repository;
}

test('stable panel icon uses the authoritative selection boundary and updates the shared plan once', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h), before = h.sidebar.getModel(); h.advance(400);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[2]));
  assert.deepEqual(result.owned.map(augment => augment.id),[ordinaryIds[2]]);
  assert.equal(result.owned[0].inferred,undefined);
  assert.equal(result.sessionRevision,before.sessionRevision+1);
  assert.deepEqual(result.plan.ownedIds,[ordinaryIds[2]]);
  assert.equal(result.plan.sessionRevision,result.sessionRevision);
  assert.equal(result.plan.gameEpoch,result.gameEpoch);
  assert.equal(result.plan.gameId,result.gameId);
  assert.equal(result.plan.championId,'Ahri');
  assert.equal(result.plan.statistics.status,'unavailable','missing source data is not invented by panel confirmation');
  assert.ok(result.plan.context.some(line => line.includes(definition(ordinaryIds[2]).name)));
  assert.ok(result.plan.nextAugments.every(augment => augment.id !== ordinaryIds[2]));
  assert.deepEqual(result.offers,[]); assert.equal(result.ocr.schedule.mode,'idle');
  assert.equal(result.panelSelection.status,'waiting');
});

test('replayed panel proof conflicts rather than duplicating the already confirmed choice', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(400); const value = proof(h,scope);
  await h.sidebar.observePanelEvidence(value);
  const revision = h.sidebar.getModel().sessionRevision;
  await assert.rejects(h.sidebar.observePanelEvidence(value),SessionConflictError);
  assert.deepEqual(h.sidebar.getSession().owned,[ordinaryIds[0]]);
  assert.equal(h.sidebar.getModel().sessionRevision,revision);
});

test('game, epoch and revision mismatches cannot commit stale panel evidence', async t => {
  for (const change of [{gameId:'other-game'},{gameEpoch:999},{revision:999}]) {
    const h = fixture(); t.after(() => h.sidebar.stop());
    const scope = await recognized(h); h.advance(400);
    await assert.rejects(h.sidebar.observePanelEvidence({...proof(h,scope),...change}),SessionConflictError);
    assert.deepEqual(h.sidebar.getSession().owned,[]);
  }
});

test('a real game boundary invalidates the previous panel scope', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(400); const value = proof(h,scope);
  h.update({gameId:'panel-custom-two',gameTime:1});
  await assert.rejects(h.sidebar.observePanelEvidence(value),SessionConflictError);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
  assert.equal(h.sidebar.getModel().gameId,'panel-custom-two');
});

test('manual correction and route revision invalidate earlier panel evidence', async t => {
  for (const update of [{owned:[ordinaryIds[1]],route:'auto'},{owned:[],route:'spell'}]) {
    const h = fixture(); t.after(() => h.sidebar.stop());
    const scope = await recognized(h); h.advance(400); const value = proof(h,scope);
    await h.sidebar.setSession(update);
    await assert.rejects(h.sidebar.observePanelEvidence(value),SessionConflictError);
    assert.deepEqual(h.sidebar.getSession().owned,update.owned);
  }
});

test('reroll and physical candidate order fence off a prior same-game panel proof', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(400); const value = proof(h,scope);
  h.setOffers([...ordinaryIds].reverse()); const rerolled = await recognized(h);
  assert.notEqual(rerolled.offerToken,scope.offerToken);
  await assert.rejects(h.sidebar.observePanelEvidence(value),SessionConflictError);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('unanswered three-card suggestions stay visible after one minute until panel confirmation', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(60001);
  const expired = h.sidebar.getModel();
  assert.deepEqual(expired.offers.map(offer => offer.id),ordinaryIds); assert.equal(expired.panelSelection.status,'watching');
  assert.equal(expired.panelSelection.offerToken,scope.offerToken);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[1]));
  assert.deepEqual(result.owned.map(augment => augment.id),[ordinaryIds[1]]);
});

test('a result panel opened after five minutes still requires fresh independent frames', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(300001);
  assert.equal(h.sidebar.getModel().panelSelection.status,'watching');
  const result = await h.sidebar.observePanelEvidence(proof(h,scope));
  assert.deepEqual(result.owned.map(augment => augment.id),[ordinaryIds[0]]);
});

test('pausing recognition revokes the result scope, and resuming does not revive an old proof', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(400); const value = proof(h,scope);
  h.sidebar.setOcr({enabled:false});
  await assert.rejects(h.sidebar.observePanelEvidence(value),SessionConflictError);
  h.sidebar.setOcr({enabled:true});
  await assert.rejects(h.sidebar.observePanelEvidence(value),SessionConflictError);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('missing title anchors never enables panel result capture or confirmation', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); h.setAnchors(false);
  h.advance(1); await h.sidebar.scan();
  const model = h.sidebar.getModel();
  assert.equal(model.offers.length,3); assert.equal(model.panelSelection.status,'waiting');
  const fake = {...model,offerToken:'a'.repeat(32),revision:model.sessionRevision,ids:ordinaryIds};
  h.advance(400); await assert.rejects(h.sidebar.observePanelEvidence(proof(h,fake)),SessionConflictError);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('loading, missing current champion, disconnected and unknown modes never accept a panel proof', async t => {
  for (const patch of [{stage:'loading',phase:'GameStart'},{championId:null},{connection:{status:'waiting'}},
    {mode:{known:false,isMayhem:false}},{mode:{known:true,isMayhem:false}}]) {
    const h = fixture(); t.after(() => h.sidebar.stop());
    const scope = await recognized(h); h.advance(400); const value = proof(h,scope); h.update(patch);
    await assert.rejects(h.sidebar.observePanelEvidence(value),SessionConflictError);
    assert.deepEqual(h.sidebar.getSession().owned,[]);
  }
});

test('unstable or unverified panel observations do not change selection or close scanning', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(400); const value = proof(h,scope);
  value.frames[1].panelVisible = false;
  const result = await h.sidebar.observePanelEvidence(value);
  assert.deepEqual(result.owned,[]); assert.equal(result.panelSelection.reason,'panel-not-visible');
  assert.equal(result.ocr.schedule.mode,'window');
  const malformed = proof(h,scope); malformed.extra = true;
  await assert.rejects(h.sidebar.observePanelEvidence(malformed),SessionValidationError);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
});

test('optional excluded skill icons do not become owned augments regardless of panel position', async t => {
  for (const skillSlot of [0,2,5]) {
    const h = fixture(); t.after(() => h.sidebar.stop());
    const scope = await recognized(h); h.advance(400); const value = proof(h,scope);
    for (const frame of value.frames) {
      frame.slots[0] = {slotIndex:0,state:'empty',candidateIndices:[]};
      frame.slots[skillSlot] = {slotIndex:skillSlot,state:'excluded',candidateIndices:[]};
      const selectedSlot = (skillSlot+1)%6;
      frame.slots[selectedSlot] = {slotIndex:selectedSlot,state:'candidate',candidateIndices:[1]};
    }
    const result = await h.sidebar.observePanelEvidence(value);
    assert.deepEqual(result.owned.map(augment => augment.id),[ordinaryIds[1]]);
    assert.deepEqual(result.plan.ownedIds,[ordinaryIds[1]]);
  }
});

test('a previous owned augment with the same glyph requires an extra visible occurrence', async t => {
  const h = fixture({ids:['archmage','recursion','shrink_engine']}); t.after(() => h.sidebar.stop());
  await h.sidebar.setSession({owned:['eureka'],route:'auto'});
  const scope = await recognized(h); h.advance(400);
  assert.equal(scope.owned[0].icon,scope.offers[0].icon);
  const pending = await h.sidebar.observePanelEvidence(proof(h,scope,[0]));
  assert.deepEqual(pending.owned.map(augment => augment.id),['eureka']);
  assert.equal(pending.panelSelection.reason,'panel-no-new-match');
  const additional = proof(h,scope,[0]);
  for (const frame of additional.frames) frame.slots[1] = {slotIndex:1,state:'candidate',candidateIndices:[0]};
  const confirmed = await h.sidebar.observePanelEvidence(additional);
  assert.deepEqual(confirmed.owned.map(augment => augment.id),['eureka','archmage']);
});

test('shared glyph follows displayed recommendation despite higher usage for another candidate and recomputes equipment', async t => {
  const h = fixture({ids:collisionIds}); const repository = await repositoryFor(h);
  h.sidebar.recommendationRepository = repository; t.after(() => h.sidebar.stop());
  assert.equal(definition(collisionIds[0]).icon,definition(collisionIds[1]).icon);
  const scope = await recognized(h), before = h.sidebar.getModel(); h.advance(400);
  assert.equal(before.plan.statistics.conditionAugmentId,null);
  assert.ok(before.plan.buildItems.some(item => item.id === '3100'));
  assert.ok(before.offers.find(offer => offer.id === 'archmage').rank < before.offers.find(offer => offer.id === 'eureka').rank);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[0,1]));
  assert.deepEqual(result.owned.map(augment => augment.id),['archmage']);
  assert.equal(result.owned[0].inferred,true); assert.match(result.owned[0].confirmationLabel,/推定/);
  assert.equal(result.plan.statistics.conditionAugmentId,'archmage');
  assert.ok(result.plan.buildItems.some(item => item.id === '3116'));
  assert.ok(!result.plan.buildItems.some(item => item.id === '3100'));
  assert.match(result.ocr.message,/推定/);
});

test('statistics or mechanism fallback follow the same displayed recommendation for shared icons', async t => {
  const h = fixture({ids:collisionIds}); const repository = await repositoryFor(h,[1000,950],[.5,.6]);
  h.sidebar.recommendationRepository = repository; t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(400);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[0,1]));
  assert.deepEqual(result.owned.map(augment => augment.id),['archmage']);
  assert.equal(result.owned[0].inferred,true);
  const missing = fixture({ids:collisionIds}); t.after(() => missing.sidebar.stop());
  const pendingScope = await recognized(missing);
  const preferred = missing.sidebar.getModel().offers.filter(offer => collisionIds.slice(0,2).includes(offer.id)).sort((a,b)=>a.rank-b.rank)[0].id;
  missing.advance(400);
  const pending = await missing.sidebar.observePanelEvidence(proof(missing,pendingScope,[0,1]));
  assert.deepEqual(pending.owned.map(offer => offer.id),[preferred]); assert.equal(pending.owned[0].inferred,true);
});

test('inferred provenance survives persistence and reload but manual replacement removes its label', async t => {
  const directory = await folder(t), h = fixture({ids:collisionIds,dataDirectory:directory});
  const repository = await repositoryFor(h); h.sidebar.recommendationRepository = repository;
  await h.sidebar.load(); const scope = await recognized(h); h.advance(400);
  await h.sidebar.observePanelEvidence(proof(h,scope,[0,1])); await h.sidebar.stop();
  const saved = JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.deepEqual(saved.selectionSources.inferredChoices,['archmage']);
  assert.deepEqual(saved.owned,['archmage']);
  const restored = await new BackgroundSidebar({collector:h.collector,data,itemsCatalog,dataDirectory:directory,now:h.now}).load();
  t.after(() => restored.stop());
  const loaded = restored.getModel();
  assert.equal(loaded.owned[0].inferred,true); assert.match(loaded.owned[0].confirmationLabel,/推定/);
  await restored.setSession({owned:['eureka'],route:'auto'});
  const corrected = restored.getModel(); assert.equal(corrected.owned[0].inferred,undefined);
  const correctedFile = JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.equal(correctedFile.selectionSources.inferredChoices,undefined);
});

test('a shared glyph without any eligible recommendation remains unanswered', async t => {
  const h = fixture({ids:collisionIds}); t.after(() => h.sidebar.stop());
  h.sidebar.recommendationPolicy = {championOverrides:{Ahri:{excludedAugmentIds:collisionIds.slice(0,2)}}};
  const scope = await recognized(h); h.advance(400);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[0,1]));
  assert.deepEqual(result.owned,[]);
  assert.equal(result.panelSelection.reason,'panel-recommendation-unavailable');
  assert.equal(h.sidebar.pendingOffers.entries.length,1);
});

test('an older shared-glyph round uses its own candidates while newer cards stay displayed', async t => {
  const h = fixture({ids:collisionIds}); t.after(() => h.sidebar.stop());
  const first = await recognized(h);
  const preferred = h.sidebar.getModel().offers.filter(offer => collisionIds.slice(0,2).includes(offer.id)).sort((a,b)=>a.rank-b.rank)[0].id;
  await nextRound(h,['shrink_engine','jeweled_gauntlet','goliath']);
  const scope = h.sidebar.getModel().panelSelection;
  assert.equal(scope.pendingId,first.pendingId);
  h.advance(400);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[0,1]));
  assert.deepEqual(result.owned.map(offer => offer.id),[preferred]);
  assert.deepEqual(result.offers.map(offer => offer.id),['shrink_engine','jeweled_gauntlet','goliath']);
});

async function nextRound(h, ids) {
  h.advance(1000); h.update({level:7,life:{status:'detected',isDead:true}}); h.sidebar.getModel();
  h.advance(1000); h.update({life:{status:'detected',isDead:false}}); h.sidebar.getModel();
  h.setOffers(ids); await recognized(h);
  return h.sidebar.getModel();
}

test('newest round stays on the left, older unanswered rounds remain scoped, and late answers preserve chronology', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const oldest = h.sidebar.getModel().pendingOffers[0];
  const newerIds = ['eureka','archmage','transmute_prismatic'];
  const two = await nextRound(h,newerIds), newest = two.pendingOffers[1];
  assert.deepEqual(two.offers.map(offer => offer.id),newerIds);
  assert.deepEqual(two.pendingOffers.map(group => group.active),[false,true]);
  assert.deepEqual(two.pendingOffers.map(group => group.previousRound),[true,false]);
  assert.equal(two.panelSelection.pendingId,oldest.pendingId,'panel checks unanswered rounds independently of left display');
  const confirmedNewer = await h.sidebar.confirmOffer({id:newerIds[2],pendingId:newest.pendingId,gameId:two.gameId,revision:two.sessionRevision});
  assert.deepEqual(confirmedNewer.offers.map(offer => offer.id),ordinaryIds);
  assert.deepEqual(confirmedNewer.pendingOffers.map(group => group.pendingId),[oldest.pendingId]);
  assert.equal(confirmedNewer.pendingOffers[0].active,true,'older pending returns to the main cards');
  assert.equal(confirmedNewer.pendingOffers[0].previousRound,true,'returning to the main cards must not relabel an old round as new');
  h.advance(400);
  const complete = await h.sidebar.observePanelEvidence(proof(h,confirmedNewer.panelSelection,[1]));
  assert.deepEqual(complete.plan.ownedIds,[ordinaryIds[1],newerIds[2]],'late older choice is inserted in its original round order');
  assert.deepEqual(complete.pendingOffers,[]);
  assert.equal(complete.ocr.schedule.mode,'idle','a late older confirmation cannot reopen the completed current cycle');
});

test('confirming an older round preserves the current OCR deadline and rebuilds current click evidence', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const oldest = h.sidebar.getModel().pendingOffers[0];
  const newerIds = ['eureka','archmage','transmute_prismatic'];
  const before = await nextRound(h,newerIds), windowUntil = h.sidebar.scanSchedule.windowUntil;
  assert.equal(before.selection.status,'armed');
  const after = await h.sidebar.confirmOffer({id:ordinaryIds[1],pendingId:oldest.pendingId,
    gameId:before.gameId,revision:before.sessionRevision});
  assert.deepEqual(after.pendingOffers.map(group => group.sequence),[2]);
  assert.equal(after.ocr.schedule.mode,'window','answering a previous round does not answer the current one');
  assert.equal(after.ocr.schedule.windowId,before.ocr.schedule.windowId);
  assert.equal(h.sidebar.scanSchedule.windowUntil,windowUntil,'confirmation never extends the existing deadline');
  assert.notEqual(after.selection.status,'armed','the revision change still revokes old click evidence');
  h.advance(500); await h.sidebar.pollOnce();
  const refreshed = h.sidebar.getModel();
  assert.equal(refreshed.selection.status,'armed','the next due OCR can obtain fresh current-round evidence');
  assert.deepEqual(refreshed.selection.ids,newerIds);
  assert.equal(refreshed.selection.revision,after.sessionRevision);
});

test('late old-round confirmation does not cancel a respawn window before its first new offer capture', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const oldest = h.sidebar.getModel().pendingOffers[0];
  h.advance(1000); h.update({life:{status:'detected',isDead:true}}); h.sidebar.getModel();
  h.advance(1000); h.update({life:{status:'detected',isDead:false}});
  const before = h.sidebar.getModel(), deadline = h.sidebar.scanSchedule.windowUntil;
  const after = await h.sidebar.confirmOffer({id:ordinaryIds[0],pendingId:oldest.pendingId,
    gameId:before.gameId,revision:before.sessionRevision});
  assert.equal(after.pendingOffers.length,0,'no current offer has been recognized yet');
  assert.equal(after.ocr.schedule.mode,'window');
  assert.equal(h.sidebar.scanSchedule.windowUntil,deadline);
  h.setOffers(['eureka','archmage','transmute_prismatic']); h.advance(500); await h.sidebar.pollOnce();
  assert.deepEqual(h.sidebar.getModel().offers.map(offer => offer.id),['eureka','archmage','transmute_prismatic']);
});

test('a previously unanswered round seen again in the current life can still complete its scanning cycle', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const oldest = h.sidebar.getModel().pendingOffers[0];
  const before = await nextRound(h,ordinaryIds);
  assert.equal(before.pendingOffers.length,1);
  assert.equal(before.pendingOffers[0].pendingId,oldest.pendingId);
  const after = await h.sidebar.confirmOffer({id:ordinaryIds[1],pendingId:oldest.pendingId,
    gameId:before.gameId,revision:before.sessionRevision});
  assert.equal(after.ocr.schedule.mode,'idle','fresh OCR associates this logical offer with the current cycle');
});

test('restored pending metadata cannot cancel a new respawn window without a current-cycle capture', async t => {
  const directory = await folder(t), h = fixture({dataDirectory:directory}); await h.sidebar.load(); await recognized(h);
  await h.sidebar.stop(); h.advance(120000);
  const restored = await new BackgroundSidebar({collector:h.collector,data,itemsCatalog,dataDirectory:directory,now:h.now}).load();
  t.after(() => restored.stop()); restored.getModel();
  h.advance(1000); h.update({life:{status:'detected',isDead:true}}); restored.getModel();
  h.advance(1000); h.update({life:{status:'detected',isDead:false}});
  const before = restored.getModel(), oldest = before.pendingOffers[0], deadline = restored.scanSchedule.windowUntil;
  const after = await restored.confirmOffer({id:ordinaryIds[1],pendingId:oldest.pendingId,
    gameId:before.gameId,revision:before.sessionRevision});
  assert.equal(after.ocr.schedule.mode,'window');
  assert.equal(restored.scanSchedule.windowUntil,deadline);
});

test('same-life rerolls replace one round with a new pending guard; repeated identical captures remain stable', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const initial = h.sidebar.getModel(), first = initial.pendingOffers[0];
  h.advance(400); await recognized(h);
  assert.equal(h.sidebar.getModel().pendingOffers[0].pendingId,first.pendingId);
  assert.equal(h.sidebar.getModel().pendingRevision,initial.pendingRevision,'capture refresh is not a logical pending change');
  const rerollIds = ['eureka',ordinaryIds[1],ordinaryIds[2]]; h.setOffers(rerollIds); await recognized(h);
  const model = h.sidebar.getModel(), reroll = model.pendingOffers[0];
  assert.equal(model.pendingOffers.length,1); assert.equal(reroll.sequence,first.sequence);
  assert.ok(model.pendingRevision > initial.pendingRevision,'rerolls publish a monotonic pending generation at the same session revision');
  assert.notEqual(reroll.pendingId,first.pendingId);
  await assert.rejects(h.sidebar.confirmOffer({id:ordinaryIds[1],pendingId:first.pendingId,gameId:model.gameId,revision:model.sessionRevision}),SessionConflictError);
});

test('validated pending panel checks rotate after a dwell so an older unreadable result cannot block a newer round', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const model = await nextRound(h,['eureka','archmage','transmute_prismatic']);
  const oldScope = model.panelSelection; h.advance(1300);
  const noMatch = proof(h,oldScope);
  for (const frame of noMatch.frames) for (const slot of frame.slots) {slot.state='empty';slot.candidateIndices=[];}
  const rotated = await h.sidebar.observePanelEvidence(noMatch);
  assert.equal(rotated.panelSelection.pendingId,model.pendingOffers[1].pendingId);
  assert.notEqual(rotated.panelSelection.offerToken,oldScope.offerToken);
  await assert.rejects(h.sidebar.observePanelEvidence(noMatch),SessionConflictError);
  h.advance(400);
  const recorded = await h.sidebar.observePanelEvidence(proof(h,rotated.panelSelection,[2]));
  assert.deepEqual(recorded.plan.ownedIds,['transmute_prismatic']);
  assert.equal(recorded.pendingOffers.length,1);
});

test('panel scope rotates after a full four-second capture dwell even when an unmatched older round submits no proof', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const model = await nextRound(h,['eureka','archmage','transmute_prismatic']), first = model.panelSelection;
  for (let tick=0;tick<9;tick++) {
    h.advance(400); assert.equal(h.sidebar.getModel().panelSelection.offerToken,first.offerToken);
  }
  h.advance(400); const next = h.sidebar.getModel().panelSelection;
  assert.equal(next.pendingId,model.pendingOffers[1].pendingId); assert.notEqual(next.offerToken,first.offerToken);
  assert.ok(next.evidenceNotBefore >= first.evidenceNotBefore+4000);
  h.advance(400);
  const selected = await h.sidebar.observePanelEvidence(proof(h,next,[2]));
  assert.deepEqual(selected.plan.ownedIds,['transmute_prismatic']);
});

test('a later confirmed candidate overlapping an older group does not disable the older panel; owned shared glyph is subtracted', async t => {
  const h = fixture({ids:collisionIds}); t.after(() => h.sidebar.stop()); await recognized(h);
  const model = await nextRound(h,['eureka','shrink_engine','jeweled_gauntlet']);
  const newest = model.pendingOffers[1];
  const after = await h.sidebar.confirmOffer({id:'eureka',pendingId:newest.pendingId,gameId:model.gameId,revision:model.sessionRevision});
  assert.equal(after.panelSelection.status,'watching'); assert.equal(after.panelSelection.pendingId,model.pendingOffers[0].pendingId);
  h.advance(400);
  const one = await h.sidebar.observePanelEvidence(proof(h,after.panelSelection,[0,1]));
  assert.deepEqual(one.plan.ownedIds,['eureka'],'the existing shared glyph alone proves no new selection');
  const extra = proof(h,after.panelSelection,[0,1]);
  for (const frame of extra.frames) frame.slots[1] = {slotIndex:1,state:'ambiguous',candidateIndices:[0,1]};
  const done = await h.sidebar.observePanelEvidence(extra);
  assert.deepEqual(done.plan.ownedIds,['archmage','eureka']);
  assert.equal(done.owned.find(augment => augment.id === 'archmage').inferred,undefined,'only one unowned identity remains after subtraction');
});

test('a candidate shared by multiple unanswered rounds cannot be assigned to a round by panel evidence alone', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  const model = await nextRound(h,['recursion','archmage','transmute_prismatic']); h.advance(400);
  const pending = await h.sidebar.observePanelEvidence(proof(h,model.panelSelection,[0]));
  assert.deepEqual(pending.owned,[]); assert.equal(pending.pendingOffers.length,2);
  assert.equal(pending.panelSelection.reason,'panel-round-ambiguous');
});

test('pending rounds persist only catalog metadata and restore for manual confirmation without resurrecting capture proof', async t => {
  const directory = await folder(t), h = fixture({dataDirectory:directory}); await h.sidebar.load(); await recognized(h);
  const before = h.sidebar.getModel(); await h.sidebar.stop();
  const saved = JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.deepEqual(Object.keys(saved.pendingOffers.entries[0]).sort(),['createdAt','ids','pendingId','roundContext','sequence']);
  assert.ok(!JSON.stringify(saved).includes('windowHandle')); assert.ok(!JSON.stringify(saved).includes('identityAnchors'));
  const restored = await new BackgroundSidebar({collector:h.collector,data,itemsCatalog,dataDirectory:directory,now:h.now}).load();
  t.after(() => restored.stop()); const model = restored.getModel();
  assert.equal(model.pendingOffers[0].pendingId,before.pendingOffers[0].pendingId);
  assert.deepEqual(model.offers.map(offer => offer.id),ordinaryIds); assert.equal(model.panelSelection.status,'waiting');
  const manual = await restored.confirmOffer({id:ordinaryIds[1],pendingId:model.pendingOffers[0].pendingId,gameId:model.gameId,revision:model.sessionRevision});
  assert.deepEqual(manual.plan.ownedIds,[ordinaryIds[1]]); assert.deepEqual(manual.pendingOffers,[]);
});

test('death and pause retain the unanswered display; fresh post-respawn panel proof succeeds without another OCR capture', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); const original = await recognized(h);
  h.advance(400); const beforeDeath = proof(h,original);
  h.advance(1000); h.update({life:{status:'detected',isDead:true}});
  const dead = h.sidebar.getModel(); assert.equal(dead.offers.length,3); assert.equal(dead.panelSelection.status,'watching');
  assert.notEqual(dead.panelSelection.offerToken,original.offerToken);
  h.advance(1000); h.update({life:{status:'detected',isDead:false}});
  const alive = h.sidebar.getModel(); assert.equal(alive.offers.length,3); assert.equal(alive.panelSelection.status,'watching');
  assert.notEqual(alive.panelSelection.offerToken,original.offerToken);
  assert.deepEqual(alive.panelSelection.capture,original.capture); assert.equal(alive.panelSelection.offeredAt,original.offeredAt);
  await assert.rejects(h.sidebar.observePanelEvidence(beforeDeath),SessionConflictError);
  h.sidebar.setOcr({enabled:false}); assert.equal(h.sidebar.getModel().offers.length,3);
  assert.equal(h.sidebar.getModel().panelSelection.status,'waiting');
  h.advance(1000); const resumed = h.sidebar.setOcr({enabled:true});
  assert.notEqual(resumed.panelSelection.offerToken,alive.panelSelection.offerToken);
  const tooEarly = proof(h,resumed.panelSelection);
  await assert.rejects(h.sidebar.observePanelEvidence(tooEarly),SessionValidationError);
  h.advance(400);
  const result = await h.sidebar.observePanelEvidence(proof(h,resumed.panelSelection,[2]));
  assert.deepEqual(result.plan.ownedIds,[ordinaryIds[2]]); assert.deepEqual(result.pendingOffers,[]);
});

test('route changes retain pending rounds while full owned corrections and definitive new games clear them', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop()); await recognized(h);
  await h.sidebar.setSession({owned:[],route:'spell'});
  assert.equal(h.sidebar.getModel().pendingOffers.length,1);
  await h.sidebar.setSession({owned:['eureka'],route:'spell'});
  assert.deepEqual(h.sidebar.getModel().pendingOffers,[]);
  h.setOffers(['archmage','transmute_prismatic','big_shot']); h.advance(1); await recognized(h);
  const old = h.sidebar.getModel(); h.update({gameId:'definitive-new-game'});
  const next = h.sidebar.getModel(); assert.deepEqual(next.pendingOffers,[]); assert.deepEqual(next.offers,[]);
  assert.ok(next.gameEpoch > old.gameEpoch);
});

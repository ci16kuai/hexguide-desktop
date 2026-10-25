// Isolated player-opened panel integration. No game capture, input or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar, SessionConflictError, SessionValidationError} from '../server/sidebar.mjs';
import {RecommendationRepository} from '../server/recommendation-repository.mjs';

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
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'panel-custom-one',championId:'Ahri',
    gameTime:20,level:3,life:{status:'detected',isDead:false},mode:{known:true,isMayhem:true},
    items:[],stats:{abilityPower:100},observedAt:new Date(now).toISOString()};
  const collector = {getSnapshot:() => structuredClone(live)};
  const sidebar = new BackgroundSidebar({collector,data,itemsCatalog,dataDirectory,recommendationRepository,now:() => now,
    scanner:async () => ({status:'recognized',proposals:offers.map(id => ({id})),selectionCapture:capture(now,anchors)})});
  return {sidebar,collector,now:() => now,
    advance(ms) {now += ms;live.observedAt = new Date(now).toISOString();if (typeof live.gameTime === 'number') live.gameTime += ms/1000;},
    update(value) {live = {...live,...value};},
    setOffers(value) {offers = [...value];}, setAnchors(value) {anchors = value;}};
}

async function recognized(h) {
  h.advance(1); assert.equal((await h.sidebar.scan()).status,'recognized');
  const scope = h.sidebar.getModel().panelSelection;
  assert.equal(scope.status,'watching');
  return scope;
}

test('only another accepted card capture renews the five-minute result lifetime',async()=>{
  const h=fixture();
  const first=await recognized(h);
  h.advance(150000);
  h.sidebar.getModel(); // Expire UI offers before the independent new capture.
  const renewed=await recognized(h);
  assert.ok(renewed.offeredAt > first.offeredAt);
  h.advance(200000);
  assert.equal(h.sidebar.getModel().panelSelection.status,'watching','renewal covers later player-opened panel');
  h.advance(100001);
  assert.equal(h.sidebar.getModel().panelSelection.status,'waiting','polling the model cannot renew the result scope');
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
  return {provider:'panel-icon',offerToken:scope.offerToken,gameId:scope.gameId,gameEpoch:scope.gameEpoch,
    revision:scope.revision,ids:[...scope.ids],frames:[0,1,2].map(index => ({captureId:`isolated-panel-${index}`,
      capturedAt:h.now()-300+index*150,panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,
      geometryKey:'client-1920x1080-hud-100',slots:Array.from({length:6},(_,slotIndex) => ({slotIndex,
        state:slotIndex ? 'empty' : matching.length > 1 ? 'ambiguous' : 'candidate',
        candidateIndices:slotIndex ? [] : [...matching]}))}))};
}

async function folder(t) {
  const root = 'H:\\Chatgpt\\work\\2026-10-25\\hexguide-panel-sidebar-tests';
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

test('the player can open the result panel after visible three-card suggestions expire', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(60001);
  const expired = h.sidebar.getModel();
  assert.deepEqual(expired.offers,[]); assert.equal(expired.panelSelection.status,'watching');
  assert.equal(expired.panelSelection.offerToken,scope.offerToken);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[1]));
  assert.deepEqual(result.owned.map(augment => augment.id),[ordinaryIds[1]]);
});

test('five-minute panel result scope expires without recording stale icons', async t => {
  const h = fixture(); t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(300001);
  assert.equal(h.sidebar.getModel().panelSelection.status,'waiting');
  await assert.rejects(h.sidebar.observePanelEvidence(proof(h,scope)),SessionConflictError);
  assert.deepEqual(h.sidebar.getSession().owned,[]);
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

test('real repository aggregates resolve a shared glyph by champion usage and recalculate conditional equipment', async t => {
  const h = fixture({ids:collisionIds}); const repository = await repositoryFor(h);
  h.sidebar.recommendationRepository = repository; t.after(() => h.sidebar.stop());
  assert.equal(definition(collisionIds[0]).icon,definition(collisionIds[1]).icon);
  const scope = await recognized(h), before = h.sidebar.getModel(); h.advance(400);
  assert.equal(before.plan.statistics.conditionAugmentId,null);
  assert.ok(before.plan.buildItems.some(item => item.id === '3100'));
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[0,1]));
  assert.deepEqual(result.owned.map(augment => augment.id),['eureka']);
  assert.equal(result.owned[0].inferred,true); assert.match(result.owned[0].confirmationLabel,/推定/);
  assert.equal(result.plan.statistics.conditionAugmentId,'eureka');
  assert.ok(result.plan.buildItems.some(item => item.id === '3089'));
  assert.ok(!result.plan.buildItems.some(item => item.id === '3100'));
  assert.ok(result.plan.nextAugments.some(augment => augment.id === 'recursion'));
  assert.match(result.ocr.message,/推定/);
});

test('similar champion usage selects higher win rate, while absent statistics keeps the collision pending', async t => {
  const h = fixture({ids:collisionIds}); const repository = await repositoryFor(h,[1000,950],[.5,.6]);
  h.sidebar.recommendationRepository = repository; t.after(() => h.sidebar.stop());
  const scope = await recognized(h); h.advance(400);
  const result = await h.sidebar.observePanelEvidence(proof(h,scope,[0,1]));
  assert.deepEqual(result.owned.map(augment => augment.id),['archmage']);
  assert.equal(result.owned[0].inferred,true);
  const missing = fixture({ids:collisionIds}); t.after(() => missing.sidebar.stop());
  const pendingScope = await recognized(missing); missing.advance(400);
  const pending = await missing.sidebar.observePanelEvidence(proof(missing,pendingScope,[0,1]));
  assert.deepEqual(pending.owned,[]); assert.equal(pending.panelSelection.reason,'panel-statistics-unavailable');
});

test('inferred provenance survives persistence and reload but manual replacement removes its label', async t => {
  const directory = await folder(t), h = fixture({ids:collisionIds,dataDirectory:directory});
  const repository = await repositoryFor(h); h.sidebar.recommendationRepository = repository;
  await h.sidebar.load(); const scope = await recognized(h); h.advance(400);
  await h.sidebar.observePanelEvidence(proof(h,scope,[0,1])); await h.sidebar.stop();
  const saved = JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.deepEqual(saved.selectionSources.inferredChoices,['eureka']);
  assert.deepEqual(saved.owned,['eureka']);
  const restored = await new BackgroundSidebar({collector:h.collector,data,itemsCatalog,dataDirectory:directory,now:h.now}).load();
  t.after(() => restored.stop());
  const loaded = restored.getModel();
  assert.equal(loaded.owned[0].inferred,true); assert.match(loaded.owned[0].confirmationLabel,/推定/);
  await restored.setSession({owned:['archmage'],route:'auto'});
  const corrected = restored.getModel(); assert.equal(corrected.owned[0].inferred,undefined);
  const correctedFile = JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.equal(correctedFile.selectionSources.inferredChoices,undefined);
});

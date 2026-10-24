// Synthetic provider evidence tests authoritative state/races, not real game animation accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BackgroundSidebar, SessionConflictError, SessionValidationError} from '../server/sidebar.mjs';
import {matchOcrProposals} from '../server/ocr.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const ids = data.augments.filter(a => a.availability === 'current' && !a.retiredPatch && a.recommendable !== false && !a.isInternalTemplate).slice(0,6).map(a => a.id);
const initial = Date.parse('2026-10-24T01:00:00Z');
const capture = time => ({capturedAt:time,width:1920,height:1080,originX:0,originY:0,windowHandle:'12345',
  regions:[0,1,2].map(column => ({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)}))});
function setup() {
  let clock = initial;
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'playing',gameId:'custom-one',championId:'Ahri',level:9,gameTime:300,
    stats:{},items:[],mode:{known:true,isMayhem:true}};
  let response;
  const scanner = async () => response || {status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionCapture:capture(clock)};
  const sidebar = new BackgroundSidebar({collector:{getSnapshot:()=>structuredClone(live)},scanner,data,itemsCatalog,now:()=>clock});
  return {sidebar,advance:ms=>{clock+=ms;},update:values=>{live={...live,...values};},setResponse:value=>{response=value;}};
}
const guards = session => ({expectedRevision:session.revision,expectedGameEpoch:session.gameEpoch,expectedGameId:session.gameId});
function evidence(observation,selectedIndex=1) {
  return {provider:'screen',offerToken:observation.offerToken,gameId:observation.gameId,gameEpoch:observation.gameEpoch,revision:observation.revision,
    ids:[...observation.ids],selectedIndex,capturedAt:observation.capturedAt,clickedAt:observation.capturedAt,observedAt:observation.capturedAt,
    evidence:{click:true,uniqueFeedback:true,cardsDismissed:true,stableFrames:3,feedbackFrames:1}};
}

test('synthetic automatic confirmation uses authoritative ordered IDs and refreshes the build', async () => {
  const {sidebar} = setup();
  await sidebar.scan();
  const observation = sidebar.getSelectionObservation();
  assert.equal(observation.status,'armed');
  assert.deepEqual(observation.ids,ids.slice(0,3));
  const model = await sidebar.observeSelectionEvidence(evidence(observation,2));
  assert.deepEqual(model.owned.map(a=>a.id),[ids[2]]);
  assert.deepEqual(model.offers,[]);
  assert.equal(model.selection.status,'waiting');
  assert.match(model.plan.summary,/1 个已确认海克斯/);
  assert.match(model.ocr.message,/实验性/);
  await assert.rejects(sidebar.observeSelectionEvidence(evidence(observation,2)),SessionConflictError);
  assert.deepEqual(sidebar.getSession().owned,[ids[2]]);
});

test('synthetic failed capture retains UI offers but cancels automatic eligibility', async () => {
  const {sidebar,setResponse} = setup();
  await sidebar.scan();
  const previous = sidebar.getSelectionObservation();
  setResponse({status:'waiting',proposals:[],message:'not foreground'});
  await sidebar.scan();
  assert.equal(sidebar.getModel().offers.length,3);
  assert.equal(sidebar.getSelectionObservation().status,'waiting');
  await assert.rejects(sidebar.observeSelectionEvidence(evidence(previous)),SessionConflictError);
});

test('synthetic recognized offers without capture identity stay available only for manual confirmation', async () => {
  const {sidebar,setResponse} = setup();
  setResponse({status:'recognized',proposals:ids.slice(0,3).map(id=>({id}))});
  await sidebar.scan();
  assert.equal(sidebar.getSelectionObservation().status,'waiting');
  const session = sidebar.getSession();
  const model = await sidebar.confirmOffer({id:ids[0],gameId:session.gameId,revision:session.revision});
  assert.deepEqual(model.owned.map(a=>a.id),[ids[0]],'the existing three-field manual payload remains supported');
});

test('synthetic reroll changes the offer token and rejects old column evidence', async () => {
  const {sidebar,setResponse} = setup();
  await sidebar.scan(); const old = sidebar.getSelectionObservation();
  setResponse({status:'recognized',proposals:[ids[3],ids[1],ids[2]].map(id=>({id})),selectionCapture:capture(initial)});
  await sidebar.scan(); const current = sidebar.getSelectionObservation();
  assert.notEqual(current.offerToken,old.offerToken);
  assert.equal(current.revision,old.revision,'offer identity is independent of the session revision');
  await assert.rejects(sidebar.observeSelectionEvidence(evidence(old)),SessionConflictError);
  assert.equal(sidebar.getSelectionObservation().status,'armed');
  await assert.rejects(sidebar.confirmOffer({id:ids[1],gameId:old.gameId,revision:old.revision,offerToken:old.offerToken}),SessionConflictError);
});

test('synthetic pause, game boundary, inactive phase and stale age reject previous evidence', async () => {
  for (const scenario of ['pause','new-game','loading','lost-connection','stale']) {
    const {sidebar,update,advance} = setup();
    await sidebar.scan(); const observation = sidebar.getSelectionObservation();
    if(scenario==='pause')sidebar.setOcr({enabled:false});
    if(scenario==='new-game')update({gameId:'custom-two',gameTime:1});
    if(scenario==='loading')update({stage:'loading'});
    if(scenario==='lost-connection')update({phase:'None',connection:{status:'waiting'}});
    if(scenario==='stale')advance(30001);
    await assert.rejects(sidebar.observeSelectionEvidence(evidence(observation)),SessionConflictError,scenario);
    assert.deepEqual(sidebar.getSession().owned,[]);
  }
});

test('synthetic manual changes win over captured evidence, and a consumed triple cannot undo later corrections', async () => {
  const {sidebar,advance} = setup();
  await sidebar.scan(); const observation = sidebar.getSelectionObservation();
  await sidebar.setSession({owned:[ids[0]],route:'spell',...guards(sidebar.getSession())});
  await assert.rejects(sidebar.observeSelectionEvidence(evidence(observation,2)),SessionConflictError);
  assert.deepEqual(sidebar.getSession().owned,[ids[0]]);
  await sidebar.setSession({owned:[],route:'spell',...guards(sidebar.getSession())});
  advance(1000); await sidebar.scan();
  assert.equal(sidebar.getSelectionObservation().status,'waiting','same consumed triple cannot auto-add a manually removed choice');
  assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'scan-offer-consumed');
  assert.deepEqual(sidebar.getSession().owned,[]);
});

test('synthetic stale full-session UI writes cannot erase a newer automatic selection', async () => {
  const {sidebar} = setup();
  await sidebar.scan();
  const old = sidebar.getSession();
  await sidebar.observeSelectionEvidence(evidence(sidebar.getSelectionObservation()));
  await assert.rejects(sidebar.setSession({owned:[],route:'tank',...guards(old)}),SessionConflictError);
  assert.deepEqual(sidebar.getSession().owned,[ids[1]]);
  assert.equal(sidebar.getSession().route,'auto');
  const current = sidebar.getSession();
  await sidebar.setSession({owned:current.owned,route:'tank',...guards(current)});
  assert.equal(sidebar.getSession().route,'tank');
  await assert.rejects(sidebar.setSession({owned:[],route:'auto',expectedGameEpoch:'wrong'}),SessionValidationError);
});

test('synthetic pending OCR is cancelled when a manual edit changes the session', async () => {
  const {sidebar} = setup();
  let finish;
  sidebar.scanner = () => new Promise(resolve=>{finish=resolve;});
  const pending = sidebar.scan();
  await sidebar.setSession({owned:[],route:'tank'});
  finish({status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionCapture:capture(initial)});
  assert.equal((await pending).status,'waiting');
  assert.equal(sidebar.getSelectionObservation().status,'waiting');
  assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'scan-context-changed');
});

test('synthetic same-offer scan refresh cannot interrupt already observed selection evidence', async () => {
  const {sidebar,advance} = setup();
  await sidebar.scan();
  const pending = evidence(sidebar.getSelectionObservation(),2);
  advance(1000); await sidebar.scan();
  assert.equal(sidebar.getSelectionObservation().capturedAt,initial+1000);
  const model = await sidebar.observeSelectionEvidence({...pending,observedAt:initial+1000});
  assert.deepEqual(model.owned.map(augment=>augment.id),[ids[2]]);
  assert.match(model.plan.summary,/1 个已确认海克斯/);
});

test('synthetic diagnostic snapshots distinguish new failed attempts from retained old offers without exposing identity', async () => {
  const {sidebar,setResponse,advance} = setup();
  assert.deepEqual(sidebar.getModel().selectionDiagnostics,{metadataStatus:'not-scanned',scanCode:'not-scanned',captureAgeMs:null,backendArmed:false,lastScanAgeMs:null});
  await sidebar.scan();
  assert.deepEqual(sidebar.getModel().selectionDiagnostics,{metadataStatus:'accepted',scanCode:'title-layout-confirmed',captureAgeMs:0,backendArmed:true,lastScanAgeMs:0});
  advance(1200);
  setResponse({status:'unavailable',selectionMetadataStatus:'title-incomplete',privateName:'do not expose',message:'failed latest frame'});
  await sidebar.scan();
  const model=sidebar.getModel();
  assert.equal(model.offers.length,3);
  assert.equal(model.ocr.status,'recognized','candidate display is preserved independently of the last diagnostic attempt');
  assert.deepEqual(model.selectionDiagnostics,{metadataStatus:'title-incomplete',scanCode:'ocr-unavailable',captureAgeMs:null,backendArmed:false,lastScanAgeMs:0});
  advance(90000);
  const diagnostic=sidebar.getModel().selectionDiagnostics;
  assert.equal(diagnostic.lastScanAgeMs,60000);
  assert.deepEqual(Object.keys(diagnostic).sort(),['backendArmed','captureAgeMs','lastScanAgeMs','metadataStatus','scanCode']);
  assert.doesNotMatch(JSON.stringify(diagnostic),/do not expose|privateName|12345|offerToken|regions/);
});

test('synthetic diagnostics distinguish missing, malformed, out-of-region, stale and ineligible metadata', async () => {
  for(const [expected,response] of [
    ['missing',{status:'recognized',proposals:ids.slice(0,3).map(id=>({id}))}],
    ['shape-invalid',{status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionCapture:{...capture(initial),windowHandle:'private-path'}}],
    ['title-outside-region',{status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionMetadataStatus:'title-outside-region'}],
    ['stale',{status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionCapture:capture(initial-30001)}],
  ]) {
    const {sidebar,setResponse}=setup(); setResponse(response); await sidebar.scan();
    assert.equal(sidebar.getModel().selectionDiagnostics.metadataStatus,expected);
    if(expected==='stale')assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'scan-capture-stale');
    assert.equal(sidebar.getModel().selectionDiagnostics.backendArmed,false);
    assert.equal(sidebar.getModel().offers.length,3);
  }
  const {sidebar,update,setResponse}=setup();
  setResponse({status:'waiting',selectionMetadataStatus:'private arbitrary text'});
  await sidebar.scan();
  assert.equal(sidebar.getModel().selectionDiagnostics.metadataStatus,'title-incomplete');
  assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'ocr-unavailable');
  update({stage:'loading'}); await sidebar.scan();
  assert.equal(sidebar.getModel().selectionDiagnostics.metadataStatus,'context-ineligible');
  assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'scan-context-ineligible');
});

test('latest scan codes distinguish foreground, empty OCR, partial titles and capture failures while retaining old offers', async () => {
  const heading=(id,column)=>({text:data.augments.find(augment=>augment.id===id).name,x:250+column*600,y:350,width:240,height:28});
  const recognized=lines=>({status:'recognized',diagnostics:{width:1920,height:1080},lines});
  for(const [expected,raw] of [
    ['game-not-foreground',{status:'waiting',code:'game-not-foreground',stage:'foreground-check'}],
    ['foreground-changed',{status:'waiting',code:'foreground-changed',stage:'foreground-check'}],
    ['ocr-no-text',recognized([])],
    ['title-name-unmatched',recognized([{text:'Private Player Name and C:/private/window',x:250,y:350,width:240,height:28}])],
    ['title-layout-incomplete',recognized(ids.slice(0,2).map(heading))],
    ['capture-size-invalid',{...recognized([]),diagnostics:{width:0,height:1080}}],
    ['ocr-capture-failed',{status:'unavailable',code:'ocr-capture-failed',stage:'capture'}],
    ['ocr-passes-incomplete',{status:'unavailable',code:'ocr-passes-incomplete',stage:'result'}],
    ['ocr-unavailable',{status:'unavailable',code:'Private Player Name and C:/private/window',stage:'private'}],
  ]){
    const {sidebar,advance,setResponse}=setup();
    await sidebar.scan();advance(1000);
    const matched=matchOcrProposals(raw,data.augments);
    assert.equal(matched.selectionMetadataStatus,'title-incomplete');
    setResponse(matched);await sidebar.scan();
    const model=sidebar.getModel();
    assert.equal(model.offers.length,3,expected);
    assert.equal(model.ocr.status,'recognized','displayed old offers do not describe the new failed capture');
    assert.equal(model.selectionDiagnostics.scanCode,expected);
    assert.equal(model.selectionDiagnostics.metadataStatus,'title-incomplete');
    assert.equal(model.selectionDiagnostics.backendArmed,false);
    assert.doesNotMatch(JSON.stringify(model.selectionDiagnostics),/Private|private|window|Player/);
  }
});

test('scanner exceptions expose a fixed latest code and cannot leak error details', async () => {
  const {sidebar}=setup();
  sidebar.scanner=async()=>{throw Error('Private Player Name C:/secret credentials');};
  await sidebar.scan();
  assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'scan-execution-failed');
  assert.doesNotMatch(JSON.stringify(sidebar.getModel().selectionDiagnostics),/Private|secret|credentials/);
});

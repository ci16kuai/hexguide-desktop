// Synthetic timing and state-transition checks only, never a real game capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BackgroundSidebar,SessionConflictError,SessionValidationError} from '../server/sidebar.mjs';
import {SelectionObserver,SelectionConflictError} from '../server/selection.mjs';

const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const ids=data.augments.filter(row=>row.availability==='current'&&row.recommendable!==false&&!row.retiredPatch&&!row.isInternalTemplate).slice(0,6).map(row=>row.id);
const initial=Date.parse('2026-10-24T12:00:00Z');
function capture(time){
  return {capturedAt:time,width:1920,height:1080,originX:0,originY:0,windowHandle:'42',
    regions:[0,1,2].map(column=>({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)})),
    identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'synthetic-continuation',pass:'card-titles-color',
      cards:[0,1,2].map(column=>({column,anchors:[{box:{x:430+column*400,y:350,width:180,height:24},feature:Array.from({length:128},(_,index)=>index%2?16:0)}]}))}};
}
function setup(){
  let clock=initial;
  let live={connection:{status:'connected'},phase:'InProgress',stage:'playing',gameId:'fixture-game',championId:'Ahri',level:9,gameTime:300,items:[],stats:{},mode:{known:true,isMayhem:true}};
  const sidebar=new BackgroundSidebar({collector:{getSnapshot:()=>structuredClone(live)},data,now:()=>clock,
    scanner:async()=>({status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionCapture:capture(clock)})});
  return {sidebar,advance:time=>{clock+=time;},update:change=>{live={...live,...change};},
    miss:async(code='ocr-no-text')=>{sidebar.scanner=async()=>({status:'unavailable',code,proposals:[]});return sidebar.scan();},
    resume:async()=>{sidebar.scanner=async()=>({status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionCapture:capture(clock)});return sidebar.scan();}};
}
const proof=(observation,clickedAt=initial+100,observedAt=initial+500)=>({provider:'screen',offerToken:observation.offerToken,
  gameId:observation.gameId,gameEpoch:observation.gameEpoch,revision:observation.revision,ids:[...observation.ids],selectedIndex:1,
  capturedAt:observation.capturedAt,clickedAt,observedAt,evidence:{click:true,uniqueFeedback:true,cardsDismissed:true,stableFrames:3,feedbackFrames:1}});

test('anchored no-FX transition commits through the unified session after OCR closes, and manual correction wins',async()=>{
  for(const manual of [false,true]) {
    const {sidebar,advance,miss}=setup(); await sidebar.scan(); const original=sidebar.getSelectionObservation();
    const value={...proof(original,initial+378,initial+790),evidence:{version:2,kind:'verified-click-transition',click:true,
      titleIdentity:true,cardsTransitioned:true,baselineStartedAt:initial+200,lastBaselineAt:initial+270,
      pressedAt:initial+300,firstTransitionAt:initial+440,stableFrames:6,maxFrameGapMs:78}};
    advance(600); await miss();
    if(manual) await sidebar.confirmOffer({gameId:original.gameId,revision:original.revision,
      offerToken:original.offerToken,id:ids[2]});
    advance(200);
    if(manual) {
      await assert.rejects(sidebar.observeSelectionEvidence(value),SessionConflictError);
      assert.deepEqual(sidebar.getModel().owned.map(row=>row.id),[ids[2]]);
    } else {
      const model=await sidebar.observeSelectionEvidence(value);
      assert.deepEqual(model.owned.map(row=>row.id),[ids[1]]);
      assert.equal(model.pendingOffers.length,0);
      assert.match(model.plan.summary,/1 个已确认海克斯/);
      await assert.rejects(sidebar.observeSelectionEvidence(value),SessionConflictError);
    }
  }
});

test('a concurrent OCR miss lets the earlier click finish FX confirmation without arming another click',async()=>{
  const {sidebar,advance}=setup();
  await sidebar.scan();const original=sidebar.getSelectionObservation();
  let finish;
  sidebar.scanner=()=>new Promise(resolve=>{finish=resolve;});
  const inFlight=sidebar.scan();
  advance(200);finish({status:'unavailable',code:'ocr-no-text',proposals:[]});await inFlight;
  const suspended=sidebar.getModel();
  assert.equal(suspended.selection.status,'waiting');
  assert.equal(suspended.selectionResult.status,'leased');
  assert.equal(suspended.selectionResult.suspendedAt,initial+200);
  advance(300);
  const model=await sidebar.observeSelectionEvidence(proof(original));
  assert.deepEqual(model.owned.map(row=>row.id),[ids[1]]);
  assert.equal(model.selectionResult.status,'waiting');
  assert.match(model.plan.summary,/1 个已确认海克斯/);
});

test('a new click after soft suspension cannot borrow the earlier capture or result lease',async()=>{
  const {sidebar,advance,miss}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
  advance(200);await miss();advance(300);
  await assert.rejects(sidebar.observeSelectionEvidence(proof(original,initial+201)),SessionConflictError);
  assert.deepEqual(sidebar.getSession().owned,[]);
  assert.equal(sidebar.getModel().selectionResult.status,'waiting');
});

test('a same-offer OCR recovery cannot replace the frozen earlier click history',async()=>{
  const {sidebar,advance,miss,resume}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
  advance(200);await miss();advance(100);await resume();
  assert.equal(sidebar.getSelectionObservation().capturedAt,initial+300);
  advance(200);
  assert.deepEqual((await sidebar.observeSelectionEvidence(proof(original))).owned.map(row=>row.id),[ids[1]]);
});

test('a resumed fresh capture permits its own new click while an old capture cannot start one',async()=>{
  for(const oldCapture of [false,true]){
    const {sidebar,advance,miss,resume}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
    advance(200);await miss();advance(100);await resume();const current=sidebar.getSelectionObservation();
    advance(300);
    const value=proof(oldCapture?original:current,initial+400,initial+600);
    if(oldCapture){
      await assert.rejects(sidebar.observeSelectionEvidence(value),SessionConflictError);
      assert.deepEqual(sidebar.getSession().owned,[]);
    }else assert.deepEqual((await sidebar.observeSelectionEvidence(value)).owned.map(row=>row.id),[ids[1]]);
  }
});

test('same ordered candidates with missing or malformed identity preserve only the old result lease',async()=>{
  for(const kind of ['missing','shape-invalid']){
    const {sidebar,advance}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
    advance(200);
    const metadata=capture(initial+200);
    if(kind==='missing')delete metadata.identityAnchors;
    else metadata.identityAnchors.cards[0].anchors[0].feature.pop();
    sidebar.scanner=async()=>({status:'recognized',proposals:ids.slice(0,3).map(id=>({id})),selectionCapture:metadata});
    await sidebar.scan();const model=sidebar.getModel();
    assert.equal(model.selection.status,'waiting');assert.equal(model.selectionResult.offerToken,original.offerToken);
    assert.equal(model.selectionDiagnostics.metadataStatus,kind);
    advance(300);assert.deepEqual((await sidebar.observeSelectionEvidence(proof(original))).owned.map(row=>row.id),[ids[1]]);
  }
});

test('repeated misses and read access do not renew a frozen continuation or its result lease',async()=>{
  const {sidebar,advance,miss}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
  advance(200);await miss();const first=sidebar.getModel().selectionResult;
  advance(1800);await miss('scan-output-invalid');
  assert.equal(sidebar.getModel().selectionResult.suspendedAt,first.suspendedAt);
  assert.equal(sidebar.getModel().selectionResult.expiresAt,first.expiresAt);
  advance(6000);
  await assert.rejects(sidebar.observeSelectionEvidence(proof(original,initial+100,initial+2500)),SessionConflictError);
  assert.deepEqual(sidebar.getSession().owned,[]);
});

test('manual edits, game or mode changes, pause, foreground loss and new triples revoke the earlier click',async()=>{
  for(const action of ['manual','manual-confirm','game','mode','pause','game-not-foreground','foreground-changed','new-triple','new-triple-missing']){
    const {sidebar,advance,miss,update}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
    advance(200);await miss();
    if(action==='manual')await sidebar.setSession({owned:[],route:'tank'});
    if(action==='manual-confirm')await sidebar.confirmOffer({id:ids[0],gameId:original.gameId,revision:original.revision,offerToken:original.offerToken});
    if(action==='game')update({gameId:'new-fixture-game',gameTime:1});
    if(action==='mode')update({mode:{known:true,isMayhem:false}});
    if(action==='pause'){sidebar.setOcr({enabled:false});sidebar.setOcr({enabled:true});}
    if(action==='game-not-foreground'||action==='foreground-changed')await miss(action);
    if(action.startsWith('new-triple')){
      advance(100);
      sidebar.scanner=async()=>({status:'recognized',proposals:[ids[3],ids[1],ids[2]].map(id=>({id})),
        ...(action==='new-triple'?{selectionCapture:capture(initial+300)}:{})});
      await sidebar.scan();
    }
    advance(300);
    await assert.rejects(sidebar.observeSelectionEvidence(proof(original)),SessionConflictError,action);
    assert.deepEqual(sidebar.getSession().owned,action==='manual-confirm'?[ids[0]]:[],action);
    if(action==='new-triple-missing')assert.equal(sidebar.getModel().selectionResult.status,'waiting');
  }
});

test('format and transport failures never clear confirmed history or become selection evidence',async()=>{
  const {sidebar,advance,miss}=setup();await sidebar.setSession({owned:[ids[5]],route:'spell'});advance(1);await sidebar.scan();
  const original=sidebar.getSelectionObservation();advance(200);await miss('scan-output-invalid');
  await assert.rejects(sidebar.observeSelectionEvidence({...proof(original),privateText:'not allowed'}),SessionValidationError);
  assert.deepEqual(sidebar.getSession().owned,[ids[5]]);
  sidebar.scanner=async()=>{throw Error('synthetic private failure');};await sidebar.scan();
  assert.deepEqual(sidebar.getSession().owned,[ids[5]]);
  assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'scan-execution-failed');
  assert.doesNotMatch(JSON.stringify(sidebar.getModel().selectionDiagnostics),/private failure/);
  advance(300);
  const model=await sidebar.observeSelectionEvidence(proof(original,initial+100,initial+501));
  assert.deepEqual(model.owned.map(row=>row.id),[ids[5],ids[1]]);
});

test('a late failed OCR result cannot undo a choice committed while that scan was in flight',async()=>{
  const {sidebar,advance}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
  let finish;sidebar.scanner=()=>new Promise(resolve=>{finish=resolve;});
  const pending=sidebar.scan();advance(500);
  await sidebar.observeSelectionEvidence(proof(original));
  finish({status:'unavailable',code:'scan-output-invalid',proposals:[]});await pending;
  assert.deepEqual(sidebar.getSession().owned,[ids[1]]);
  assert.equal(sidebar.getModel().selectionResult.status,'waiting');
});

test('a consumed or already-owned triple cannot recreate a suspended automatic lease',async()=>{
  const {sidebar,advance,resume}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
  await sidebar.confirmOffer({id:ids[0],gameId:original.gameId,revision:original.revision});
  advance(200);await resume();
  assert.equal(sidebar.getModel().selectionResult.status,'waiting');
  assert.deepEqual(sidebar.getSession().owned,[ids[0]]);
  await assert.rejects(sidebar.observeSelectionEvidence(proof(original)),SessionConflictError);
});

test('a geometry change after suspension revokes old evidence without consuming the new arm',()=>{
  let clock=initial;const observer=new SelectionObserver({now:()=>clock});
  const context={gameId:'fixture',gameEpoch:1,revision:1},token='a'.repeat(32);
  observer.arm({...context,offerToken:token,ids:ids.slice(0,3),capture:capture(clock)});
  const original=observer.get(context);clock+=200;observer.suspendForResultCheck(context);
  clock+=100;const moved=capture(clock);moved.originX=100;
  observer.arm({...context,offerToken:token,ids:ids.slice(0,3),capture:moved});
  clock+=200;
  assert.throws(()=>observer.consume(proof(original),context),SelectionConflictError);
  assert.equal(observer.get(context).capturedAt,initial+300);
});

test('soft continuation preserves every original click, FX and multi-frame evidence requirement',async()=>{
  for(const missing of [{click:false},{uniqueFeedback:false},{cardsDismissed:false},{stableFrames:2},{feedbackFrames:0}]){
    const {sidebar,advance,miss}=setup();await sidebar.scan();const original=sidebar.getSelectionObservation();
    advance(200);await miss();advance(300);
    const value=proof(original);Object.assign(value.evidence,missing);
    await assert.rejects(sidebar.observeSelectionEvidence(value),SessionConflictError);
    assert.deepEqual(sidebar.getSession().owned,[]);
  }
});

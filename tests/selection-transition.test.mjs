// Synthetic contract tests, not live-game acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionObserver, SelectionConflictError, SelectionValidationError} from '../server/selection.mjs';

const stamp = 1793110089702;
const context = {gameId:'fixture', gameEpoch:2, revision:3};
const ids = ['pursuit_of_haste','ok_boomerang','phenomenal_evil'];
const token = 'a'.repeat(32);
const capture = (at = stamp, anchored = true) => ({capturedAt:at,width:1920,height:1080,originX:0,originY:0,windowHandle:'42',
  regions:[0,1,2].map(column => ({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(25)})),
  ...(anchored ? {identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'fixture',pass:'card-titles-color',
    cards:[0,1,2].map(column => ({column,anchors:[{box:{x:410+column*400,y:360,width:100,height:32},
      feature:Array.from({length:128},(_,i)=>i%2?24:0)}]}))}} : {})});
function harness(anchored = true) {
  let now = stamp+1000;
  const observer = new SelectionObserver({now:()=>now});
  const arm = (at, anchors, overrides = {}) => observer.arm({...context,offerToken:token,ids,capture:capture(at,anchors),...overrides});
  arm(stamp,anchored);
  return {observer,arm,setNow:value=>{now=value;}};
}
const proof = () => ({provider:'screen',offerToken:token,...context,ids:[...ids],selectedIndex:0,capturedAt:stamp,
  clickedAt:stamp+378,observedAt:stamp+790,evidence:{version:2,kind:'verified-click-transition',click:true,
    titleIdentity:true,cardsTransitioned:true,baselineStartedAt:stamp+200,lastBaselineAt:stamp+270,
    pressedAt:stamp+300,firstTransitionAt:stamp+440,stableFrames:6,maxFrameGapMs:78}});

test('anchored actual column and sustained transition can commit without fabricating FX',()=>{
  const {observer}=harness(); const value=proof();
  assert.equal('uniqueFeedback' in value.evidence,false);
  assert.equal(observer.consume(value,context).id,ids[0]);
  assert.throws(()=>observer.consume(value,context),SelectionConflictError);
});
test('short, discontinuous, unverified or incorrectly ordered transition evidence fails closed',()=>{
  for(const change of [{click:false},{titleIdentity:false},{cardsTransitioned:false},{stableFrames:4},
    {maxFrameGapMs:181},{maxFrameGapMs:0},{maxFrameGapMs:1},{maxFrameGapMs:69},{stableFrames:352},
    {stableFrames:5,maxFrameGapMs:78},{baselineStartedAt:stamp-1},{lastBaselineAt:stamp+201},
    {lastBaselineAt:stamp+381},{pressedAt:stamp+270},{pressedAt:stamp+451},
    {firstTransitionAt:stamp+377},{firstTransitionAt:stamp+879},{firstTransitionAt:stamp+441}]) {
    const {observer}=harness(); const value=proof(); Object.assign(value.evidence,change);
    assert.throws(()=>observer.consume(value,context),SelectionConflictError,JSON.stringify(change));
  }
  for(const change of [{clickedAt:stamp+300},{clickedAt:stamp+801},{observedAt:stamp+3300}]) {
    const {observer}=harness(); assert.throws(()=>observer.consume({...proof(),...change},context),SelectionConflictError);
  }
});
test('new evidence is a strict versioned contract, not an extension of legacy FX booleans',()=>{
  for(const change of [{version:3},{kind:'click-only'},{stableFrames:5.5},{rawText:'private'},
    {uniqueFeedback:true},{pressedAt:'300'}]) {
    const {observer}=harness(); const value=proof(); Object.assign(value.evidence,change);
    assert.throws(()=>observer.consume(value,context),SelectionValidationError);
  }
});
test('anchor eligibility belongs to original capture, not a later same-offer refresh',()=>{
  for(const originalAnchored of [false,true]) for(const suspended of [false,true]) {
    const {observer,arm}=harness(originalAnchored);
    arm(stamp+500,!originalAnchored);
    if(suspended) observer.suspendForResultCheck(context);
    if(originalAnchored) assert.equal(observer.consume(proof(),context).id,ids[0]);
    else assert.throws(()=>observer.consume(proof(),context),SelectionConflictError);
  }
});
test('frozen continuation accepts only a click started before suspension',()=>{
  const {observer,setNow}=harness(); setNow(stamp+600); observer.suspendForResultCheck(context); setNow(stamp+1000);
  assert.equal(observer.consume(proof(),context).id,ids[0]);
  const next=harness(); next.setNow(stamp+250); next.observer.suspendForResultCheck(context); next.setNow(stamp+1000);
  assert.throws(()=>next.observer.consume(proof(),context),SelectionConflictError);
});
test('manual invalidation, game/revision/offer changes, geometry and expired captures reject old transition',()=>{
  for(const change of [{gameId:'new'},{gameEpoch:3},{revision:4},{offerToken:'b'.repeat(32)},
    {ids:[ids[1],ids[0],ids[2]]},{capture:{...capture(stamp+500),originX:10}}]) {
    const {observer,arm}=harness(); arm(stamp+500,true,change);
    const nextContext={...context,...Object.fromEntries(Object.entries(change).filter(([key])=>key in context))};
    assert.throws(()=>observer.consume(proof(),nextContext),SelectionConflictError);
    assert.equal(observer.get(nextContext).status,'armed');
  }
  const h=harness(); h.observer.invalidate(); assert.throws(()=>h.observer.consume(proof(),context),SelectionConflictError);
  const stale=harness(); stale.setNow(stamp+31001); assert.throws(()=>stale.observer.consume(proof(),context),SelectionConflictError);
});
test('anchor history stays bounded and cannot resurrect pruned captures',()=>{
  const {observer,arm}=harness();
  for(let i=1;i<=12;i++) arm(stamp+i*10,true);
  assert.equal(observer.anchorCaptureTimes.length,8); assert.equal(observer.resultAnchorCaptureTimes.length,8);
  assert.throws(()=>observer.consume(proof(),context),SelectionConflictError);
  observer.invalidate(); assert.deepEqual(observer.anchorCaptureTimes,[]); assert.deepEqual(observer.resultAnchorCaptureTimes,[]);
});

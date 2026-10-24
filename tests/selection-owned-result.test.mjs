// Synthetic protocol checks only; these fixtures do not validate real HUD recognition.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionObserver, SelectionValidationError, SelectionConflictError} from '../server/selection.mjs';

const stamp = Date.parse('2026-10-24T12:00:00Z');
const context = {gameId:'custom-game',gameEpoch:4,revision:12};
const ids = ['left-id','middle-id','right-id'];
const token = 'a'.repeat(32);
const capture = (capturedAt = stamp) => ({capturedAt,width:1920,height:1080,originX:0,originY:0,windowHandle:'1234',
  regions:[0,1,2].map(column => ({column,x:300+column*400,y:200,width:300,height:500,signature:Array(192).fill(60)}))});
const slot = (slotIndex,state = 'empty',candidateIndices = []) => ({slotIndex,state,candidateIndices});
function setup() {
  let clock = stamp+1000;
  const observer = new SelectionObserver({now:() => clock});
  observer.arm({...context,offerToken:token,ids,capture:capture()});
  return {observer,advance:milliseconds => {clock += milliseconds;}};
}
function proof(lease, selectedIndex = 1) {
  return {provider:'screen',offerToken:lease.offerToken,gameId:lease.gameId,gameEpoch:lease.gameEpoch,
    revision:lease.revision,ids:[...lease.ids],selectedIndex,capturedAt:lease.capturedAt,
    clickedAt:stamp+400,observedAt:stamp+900,evidence:{version:1,kind:'owned-slot-delta',surface:'hud',
      cardsDismissedAt:stamp+500,baseline:{capturedAt:stamp+200,slots:[slot(0,'unmatched'),slot(1),slot(2),slot(3)]},
      frames:[600,750,900].map(offset => ({capturedAt:stamp+offset,baselinePreserved:true,
        slots:[slot(0,'unmatched'),slot(1,'unmatched'),slot(2,'candidate',[selectedIndex]),slot(3)]}))}};
}
const currentProof = observer => proof(observer.getResultLease(context));

test('synthetic clicked column is confirmed by one stable slot delta; unmatched changes are never counted', () => {
  for (const initialUnmatched of [true,false]) {
    const {observer} = setup();
    const value = currentProof(observer);
    if (!initialUnmatched) {
      value.evidence.baseline.slots[0] = slot(0);
      for (const frame of value.evidence.frames) frame.slots[0] = slot(0);
    }
    assert.deepEqual(observer.consumeOwnedResult(value,context),{
      id:ids[1],provider:'screen',experimental:true,offerToken:token,observedAt:stamp+900});
    assert.equal(observer.get(context).status,'waiting');
    assert.equal(observer.getResultLease(context).status,'waiting');
    assert.throws(() => observer.consumeOwnedResult(value,context),SelectionConflictError);
  }
});

test('synthetic result proof has its own versioned schema and never borrows click-FX flags', () => {
  const {observer} = setup();
  const original = currentProof(observer);
  const mutations = [value => {delete value.clickedAt;},value => {value.provider='overwolf';},
    value => {value.evidence.version=2;},value => {value.evidence.kind='click-feedback';},
    value => {value.evidence.uniqueFeedback=true;},value => {value.playerName='private';},
    value => {value.evidence.frames[0].rawText='private';},
    value => {value.evidence.baseline.slots[0].state='skill';},
    value => {value.evidence.frames[0].slots[0].state='unknown';},
    value => {delete value.evidence.frames[1];},
    value => {value.evidence.frames=Array.from({length:9},() => structuredClone(value.evidence.frames[0]));},
    value => {value.evidence.frames[0].slots[2].candidateIndices=[1,1];}];
  for (const mutate of mutations) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => observer.consumeOwnedResult(value,context),SelectionValidationError);
    assert.equal(observer.getResultLease(context).status,'leased');
  }
  assert.throws(() => observer.consume(original,context),SelectionValidationError,'legacy path does not accept result proof');
  const legacy = {...original,evidence:{click:true,uniqueFeedback:true,cardsDismissed:true,stableFrames:3,feedbackFrames:1}};
  assert.throws(() => observer.consumeOwnedResult(legacy,context),SelectionValidationError);
});

test('synthetic result evidence is bound to current game, epoch, revision, token, ordered candidates and capture', () => {
  const {observer} = setup();
  const value = currentProof(observer);
  for (const override of [{gameId:'different'},{gameEpoch:5},{revision:13},{offerToken:'b'.repeat(32)},
    {ids:[ids[1],ids[0],ids[2]]},{capturedAt:stamp-1}]) {
    assert.throws(() => observer.consumeOwnedResult({...value,...override},context),SelectionConflictError);
    assert.equal(observer.getResultLease(context).offerToken,token);
  }
  observer.arm({...context,offerToken:'b'.repeat(32),ids:['new',...ids.slice(1)],capture:capture()});
  assert.throws(() => observer.consumeOwnedResult(value,context),SelectionConflictError);
  assert.equal(observer.getResultLease(context).offerToken,'b'.repeat(32),'stale proof cannot cancel a new offer');
});

test('synthetic temporary card loss suspends legacy capture but retains only a bounded result lease', () => {
  const {observer,advance} = setup();
  const value = currentProof(observer);
  const lease = observer.suspendForResultCheck(context);
  assert.equal(lease.status,'leased');
  assert.equal(lease.suspendedAt,stamp+1000);
  assert.equal(lease.expiresAt,stamp+16000);
  assert.equal(observer.get(context).status,'waiting');
  advance(1000);
  assert.equal(observer.suspendForResultCheck(context).expiresAt,stamp+16000,'unknown frames cannot renew the lease');
  assert.equal(observer.consumeOwnedResult(value,context).id,ids[1]);
  const second = setup();
  second.observer.suspendForResultCheck(context);
  second.advance(15001);
  assert.equal(second.observer.getResultLease(context).status,'waiting');
});

test('synthetic a late temporary suspension cannot extend the original absolute thirty-second limit', () => {
  const {observer,advance} = setup();
  advance(24000);
  assert.equal(observer.suspendForResultCheck(context).expiresAt,stamp+30000);
  advance(5001);
  assert.equal(observer.getResultLease(context).status,'waiting');
});

test('synthetic manual invalidation, pause and context changes revoke suspended result eligibility', () => {
  for (const cancel of [observer => observer.invalidate(),observer => observer.get(context,false),
    observer => observer.get({...context,gameEpoch:5}),observer => observer.getResultLease(context,false),
    observer => observer.getResultLease({...context,revision:13})]) {
    const {observer} = setup();
    const value = currentProof(observer);
    observer.suspendForResultCheck(context);
    cancel(observer);
    assert.equal(observer.getResultLease(context).status,'waiting');
    assert.throws(() => observer.consumeOwnedResult(value,context),SelectionConflictError);
  }
});

test('synthetic unknown, ambiguous, nonchosen or multiple new candidates never append an owned result', () => {
  const mutations = [
    value => {for (const frame of value.evidence.frames) frame.slots[2]=slot(2,'unmatched');},
    value => {for (const frame of value.evidence.frames) frame.slots[2]=slot(2,'candidate',[0]);},
    value => {for (const frame of value.evidence.frames) frame.slots[2]=slot(2,'ambiguous',[0,1]);},
    value => {for (const frame of value.evidence.frames) frame.slots[3]=slot(3,'candidate',[1]);},
    value => {for (const frame of value.evidence.frames) frame.slots[3]=slot(3,'ambiguous',[0,2]);},
    value => {value.evidence.frames[1].slots[2]=slot(2);value.evidence.frames[1].slots[3]=slot(3,'candidate',[1]);},
    value => {value.evidence.baseline.slots[2]=slot(2,'candidate',[1]);},
    value => {value.evidence.frames[0].baselinePreserved=false;},
    value => {value.evidence.frames[0].slots[0]=slot(0);},
    value => {for (const frame of value.evidence.frames) frame.slots.pop();}
  ];
  for (const mutate of mutations) {
    const {observer} = setup();
    const value = currentProof(observer); mutate(value);
    assert.throws(() => observer.consumeOwnedResult(value,context),SelectionConflictError);
    assert.equal(observer.getResultLease(context).status,'leased','uncertainty does not clear or renew the bounded lease');
  }
});

test('synthetic three result frames must be independent and follow this offer click and card dismissal', () => {
  const mutations = [
    value => {value.clickedAt=stamp-1;},
    value => {value.clickedAt=stamp+100;},
    value => {value.evidence.cardsDismissedAt=stamp+300;},
    value => {value.evidence.cardsDismissedAt=stamp+700;},
    value => {value.evidence.baseline.capturedAt=stamp-1;},
    value => {value.evidence.frames[1].capturedAt=value.evidence.frames[0].capturedAt;},
    value => {value.evidence.frames[1].capturedAt=stamp+699;},
    value => {value.evidence.frames[1].capturedAt=stamp+700;value.evidence.frames[2].capturedAt=stamp+800;value.observedAt=stamp+800;},
    value => {value.observedAt=stamp+901;},
    value => {for (const frame of value.evidence.frames) frame.capturedAt+=16000;value.observedAt+=16000;}
  ];
  for (const mutate of mutations) {
    const {observer} = setup();
    const value = currentProof(observer); mutate(value);
    assert.throws(() => observer.consumeOwnedResult(value,context),SelectionConflictError);
  }
  const {observer,advance} = setup();
  const stale = currentProof(observer); advance(5000);
  assert.throws(() => observer.consumeOwnedResult(stale,context),SelectionConflictError);
});

test('synthetic lease snapshots are copied and a geometry change revokes earlier capture bindings', () => {
  const {observer,advance} = setup();
  const old = currentProof(observer);
  const copy = observer.getResultLease(context);
  copy.ids[0]='private-change';copy.capture.regions[0].signature[0]=0;
  assert.equal(observer.getResultLease(context).ids[0],ids[0]);
  assert.equal(observer.getResultLease(context).capture.regions[0].signature[0],60);
  advance(1000);
  const moved = capture(stamp+1500);moved.originX=100;
  observer.arm({...context,offerToken:token,ids,capture:moved});
  assert.throws(() => observer.consumeOwnedResult(old,context),SelectionConflictError);
});

test('synthetic sparse candidate IDs cannot create a result or legacy observation', () => {
  const {observer} = setup();
  const value = currentProof(observer);delete value.ids[1];
  assert.throws(() => observer.consumeOwnedResult(value,context),SelectionValidationError);
});

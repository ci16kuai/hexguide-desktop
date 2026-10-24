// These inputs are synthetic evidence. They do not validate any real selection animation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionObserver, SelectionValidationError, SelectionConflictError, sanitizeSelectionCapture} from '../server/selection.mjs';

const stamp = Date.parse('2026-10-24T01:00:00Z');
const context = {gameId:'custom-game', gameEpoch:2, revision:7};
const ids = ['left-id','middle-id','right-id'];
const token = 'a'.repeat(32);
const capture = (capturedAt = stamp) => ({capturedAt, width:1920, height:1080, originX:-1920, originY:0, windowHandle:'123456',
  regions:[0,1,2].map(column => ({column, x:400 + column * 400, y:200, width:300, height:550, signature:Array(192).fill(60 + column)}))});
const evidence = (observation, selectedIndex = 1) => ({provider:'screen', offerToken:observation.offerToken,
  gameId:observation.gameId, gameEpoch:observation.gameEpoch, revision:observation.revision, ids:[...observation.ids], selectedIndex,
  capturedAt:observation.capturedAt, clickedAt:stamp + 500, observedAt:stamp + 1000,
  evidence:{click:true, uniqueFeedback:true, cardsDismissed:true, stableFrames:3, feedbackFrames:1}});
function setup() {
  let clock = stamp + 1000;
  const observer = new SelectionObserver({now:() => clock});
  observer.arm({...context, offerToken:token, ids, capture:capture()});
  return {observer, advance:milliseconds => {clock += milliseconds;}};
}

test('synthetic capture metadata copies only bounded geometry and numeric RGB signatures', () => {
  const input = {...capture(), playerName:'private-name', text:'private OCR text', image:'private pixels'};
  input.regions[0].extra = 'private';
  const safe = sanitizeSelectionCapture(input, {width:1920, height:1080});
  assert.equal(safe.regions.length,3);
  assert.equal(safe.regions[0].signature.length,192);
  assert.doesNotMatch(JSON.stringify(safe),/private/);
  safe.regions[0].signature[0] = 255;
  assert.equal(input.regions[0].signature[0],60);
  assert.equal(sanitizeSelectionCapture(input,{width:2560}),null);
  for (const mutate of [value => value.regions[0].signature.pop(), value => value.regions[0].signature[0] = 0.5,
    value => value.regions[0].x = -1, value => value.regions[1].x = 500,
    value => value.width = 99999, value => value.windowHandle = 'C:/private-path',
    value => value.windowHandle = '0x0', value => { delete value.regions[0].signature[5]; }]) {
    const invalid = capture(); mutate(invalid);
    assert.equal(sanitizeSelectionCapture(invalid),null);
  }
});

test('synthetic complete screen evidence selects the physical column once, never recommendation rank', () => {
  const {observer} = setup();
  const observation = observer.get(context);
  const result = observer.consume(evidence(observation,2),context);
  assert.deepEqual(result,{id:'right-id',provider:'screen',experimental:true,offerToken:token,observedAt:stamp+1000});
  assert.equal(observer.get(context).status,'waiting');
  assert.throws(() => observer.consume(evidence(observation,2),context),SelectionConflictError);
});

test('synthetic uncertainty, a missing feedback frame, or a click alone cannot confirm', () => {
  for (const change of [{click:false},{uniqueFeedback:false},{cardsDismissed:false},{stableFrames:2},{feedbackFrames:0}]) {
    const {observer} = setup();
    const value = evidence(observer.get(context));
    Object.assign(value.evidence,change);
    assert.throws(() => observer.consume(value,context),SelectionConflictError);
    assert.equal(observer.get(context).status,'waiting','uncertain evidence requires a new capture');
  }
});

test('synthetic wrong game, epoch, revision, token or ordered IDs cannot consume the current observation', () => {
  const {observer} = setup();
  const original = evidence(observer.get(context));
  for (const override of [{gameId:'other-game'},{gameEpoch:3},{revision:8},{offerToken:'b'.repeat(32)},
    {ids:[ids[1],ids[0],ids[2]]},{capturedAt:stamp-1}]) {
    assert.throws(() => observer.consume({...original,...override},context),SelectionConflictError);
    assert.equal(observer.get(context).status,'armed');
  }
});

test('synthetic stale captures, changed context and unavailable capture eligibility cancel arming', () => {
  const {observer,advance} = setup();
  advance(30000);
  assert.equal(observer.get(context).status,'waiting');
  observer.arm({...context,offerToken:token,ids,capture:capture(stamp+31000)});
  assert.equal(observer.get({...context,revision:8}).status,'waiting');
  observer.arm({...context,offerToken:token,ids,capture:capture(stamp+31000)});
  assert.equal(observer.get(context,false).status,'waiting');
});

test('synthetic timing evidence is bounded around capture, release and receipt', () => {
  for (const override of [{clickedAt:stamp-1},{observedAt:stamp+499},{observedAt:stamp+4001},
    {observedAt:stamp+2001},{clickedAt:stamp,observedAt:stamp}]) {
    const {observer,advance} = setup();
    if (override.observedAt === stamp) advance(6000);
    assert.throws(() => observer.consume({...evidence(observer.get(context)),...override},context),SelectionConflictError);
  }
});

test('synthetic provider and field validation does not expose or accept unapproved Overwolf inputs', () => {
  const {observer} = setup();
  const value = evidence(observer.get(context));
  for (const override of [{provider:'overwolf'},{playerName:'private'},{selectedIndex:3},{observedAt:'2026-10-24'},
    {evidence:{...value.evidence,rawText:'private'}}]) {
    assert.throws(() => observer.consume({...value,...override},context),SelectionValidationError);
  }
  const copy = observer.get(context); copy.capture.regions[0].signature[0] = 0;
  assert.equal(observer.get(context).capture.regions[0].signature[0],60);
});

test('synthetic newer offer invalidates the old token without allowing old evidence to cancel the new offer', () => {
  const {observer} = setup();
  const old = evidence(observer.get(context));
  observer.arm({...context,offerToken:'b'.repeat(32),ids:['new-left',...ids.slice(1)],capture:capture()});
  assert.throws(() => observer.consume(old,context),SelectionConflictError);
  assert.equal(observer.get(context).offerToken,'b'.repeat(32));
});

test('synthetic invalidation requires a genuinely newer capture, even with a new token', () => {
  const {observer,advance} = setup();
  observer.invalidate();
  observer.arm({...context,offerToken:'b'.repeat(32),ids,capture:capture()});
  assert.equal(observer.get(context).status,'waiting');
  advance(1001);
  observer.arm({...context,offerToken:'c'.repeat(32),ids,capture:capture(stamp+2001)});
  assert.equal(observer.get(context).status,'armed');
});

test('synthetic same-offer OCR refresh retains a pending observation without exposing capture history', () => {
  const {observer,advance} = setup();
  const pending = evidence(observer.get(context));
  advance(1000);
  observer.arm({...context,offerToken:token,ids,capture:capture(stamp+1500)});
  assert.equal(observer.get(context).capturedAt,stamp+1500);
  assert.equal('captureTimes' in observer.get(context),false);
  assert.equal(observer.consume({...pending,observedAt:stamp+2000},context).id,ids[1]);
});

test('synthetic retained captures are bounded by age and eight timestamps, and reset on identity changes', () => {
  const {observer,advance} = setup();
  const first = evidence(observer.get(context));
  for(let index=1;index<=8;index++) {
    advance(1000);
    observer.arm({...context,offerToken:token,ids,capture:capture(stamp+index*1000)});
  }
  assert.equal(observer.captureTimes.length,8);
  assert.throws(()=>observer.consume({...first,clickedAt:stamp+8500,observedAt:stamp+9000},context),SelectionConflictError);
  const previous = evidence(observer.get(context));
  const changed = capture(stamp+8500); changed.originX=0;
  observer.arm({...context,offerToken:token,ids,capture:changed});
  assert.throws(()=>observer.consume({...previous,clickedAt:stamp+8500,observedAt:stamp+9000},context),SelectionConflictError);
  advance(31001);
  observer.arm({...context,offerToken:token,ids,capture:{...changed,capturedAt:stamp+40001}});
  assert.deepEqual(observer.captureTimes,[stamp+40001]);
});

test('synthetic capture history is cleared for a new token, revision or ordered triple', () => {
  for(const change of [{offerToken:'b'.repeat(32)},{revision:8},{ids:[ids[1],ids[0],ids[2]]}]) {
    const {observer,advance} = setup();
    const old = evidence(observer.get(context));
    advance(1000);
    const next = {...context,offerToken:token,ids,...change};
    observer.arm({...next,capture:capture(stamp+1500)});
    const currentContext = {gameId:next.gameId,gameEpoch:next.gameEpoch,revision:next.revision};
    const current = observer.get(currentContext);
    assert.deepEqual(observer.captureTimes,[stamp+1500]);
    assert.throws(()=>observer.consume({...old,offerToken:current.offerToken,revision:current.revision,ids:current.ids,
      clickedAt:stamp+1800,observedAt:stamp+2000},currentContext),SelectionConflictError);
  }
});

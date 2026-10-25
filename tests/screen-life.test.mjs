import test from 'node:test';
import assert from 'node:assert/strict';
import {ScreenLifeSource,ScreenLifeValidationError,ScreenLifeConflictError} from '../server/screen-life.mjs';

const epoch = 1_000_000;
const unavailable = {status:'unavailable',isDead:null,source:'unavailable'};
const context = () => ({gameId:'fixture-game',gameEpoch:2});
const live = () => ({phase:'InProgress',stage:'live',gameId:'fixture-game',connection:{status:'connected'},
  mode:{known:true,isMayhem:true},observedAt:new Date(epoch).toISOString(),life:{status:'unavailable',isDead:null}});
const dead = overrides => ({provider:'screen',gameId:'fixture-game',gameEpoch:2,observedAt:epoch,
  state:'dead',code:'verified-dead-countdown',stableFrames:3,countdownSeconds:15,...overrides});
const alive = overrides => dead({state:'alive',code:'verified-respawn',countdownSeconds:null,...overrides});
const unknown = overrides => dead({state:'unknown',code:'unavailable',stableFrames:0,countdownSeconds:null,...overrides});
const throwsCode = (operation, ErrorType, code) => assert.throws(operation,error => error instanceof ErrorType && error.code === code);
function harness() {
  const h = {time:epoch,context:context(),live:live()};
  h.source = new ScreenLifeSource({now:() => h.time});
  h.accept = value => h.source.accept(value,h.context,h.live);
  h.resolve = () => h.source.resolve(h.live,h.context);
  h.advance = delta => {h.time += delta;h.live.observedAt = new Date(h.time).toISOString();};
  return h;
}

test('screen proof establishes dead then verified alive with only whitelisted output', () => {
  const h = harness();
  assert.deepEqual(h.resolve(),unavailable);
  assert.deepEqual(h.accept(dead()),{status:'detected',isDead:true,source:'screen',observedAt:epoch});
  h.advance(500);
  const result = h.accept(alive({observedAt:h.time,stableFrames:5}));
  assert.deepEqual(result,{status:'detected',isDead:false,source:'screen',observedAt:h.time});
  assert.deepEqual(Object.keys(result).sort(),['isDead','observedAt','source','status']);
  result.isDead = true;
  assert.equal(h.resolve().isDead,false);
});

test('unknown-to-alive and an explicit reset never manufacture a respawn', () => {
  const h = harness();
  throwsCode(() => h.accept(alive()),ScreenLifeConflictError,'missing-dead-baseline');
  h.advance(1);
  h.accept(dead({observedAt:h.time}));
  h.source.reset();
  h.advance(1);
  throwsCode(() => h.accept(alive({observedAt:h.time})),ScreenLifeConflictError,'missing-dead-baseline');
  assert.deepEqual(h.resolve(),unavailable);
});

test('screen cache expires at three seconds but dead history bridges an OCR gap up to ten seconds', () => {
  const h = harness();
  h.accept(dead());
  h.advance(3000);
  assert.equal(h.resolve().isDead,true);
  h.advance(1);
  assert.deepEqual(h.resolve(),unavailable);
  h.advance(999);
  assert.deepEqual(h.accept(alive({observedAt:h.time})),{status:'detected',isDead:false,source:'screen',observedAt:h.time});
  h.advance(6001);
  assert.deepEqual(h.resolve(),unavailable);
  throwsCode(() => h.accept(alive({observedAt:h.time})),ScreenLifeConflictError,'missing-dead-baseline');
});

test('unknown clears the screen and dead history, retains monotonic protection and exports no reason text', () => {
  const h = harness();
  h.accept(dead());
  h.advance(500);
  assert.deepEqual(h.accept(unknown({observedAt:h.time})),unavailable);
  assert.deepEqual(h.resolve(),unavailable);
  throwsCode(() => h.accept(dead()),ScreenLifeConflictError,'observation-replayed');
  h.advance(500);
  throwsCode(() => h.accept(alive({observedAt:h.time})),ScreenLifeConflictError,'missing-dead-baseline');
});

test('fresh explicit API life has priority and revokes all previous screen evidence', () => {
  const h = harness();
  h.accept(dead());
  h.advance(500);
  h.live.life = {status:'detected',isDead:false};
  assert.deepEqual(h.resolve(),{status:'detected',isDead:false,source:'live-client',observedAt:h.time});
  throwsCode(() => h.accept(dead({observedAt:h.time})),ScreenLifeConflictError,'live-client-preferred');
  h.advance(1);
  assert.equal(h.accept(alive({observedAt:h.time})).source,'live-client');
  h.live.life = {status:'unavailable',isDead:null};
  h.advance(1);
  throwsCode(() => h.accept(alive({observedAt:h.time})),ScreenLifeConflictError,'missing-dead-baseline');
  assert.deepEqual(h.resolve(),unavailable);
});

test('accept sees a returning API even before resolve and never stores its competing screen proof', () => {
  const h = harness();
  h.accept(dead());
  h.advance(500);
  h.live.life = {status:'detected',isDead:true};
  assert.equal(h.accept(dead({observedAt:h.time})).source,'live-client');
  h.advance(1);
  h.live.life = {status:'unavailable',isDead:null};
  throwsCode(() => h.accept(alive({observedAt:h.time})),ScreenLifeConflictError,'missing-dead-baseline');
});

test('API observation must be a fresh explicit boolean, never a missing or coerced alive default', () => {
  const h = harness();
  for (const value of [undefined,null,'false',0,1,{}]) {
    h.live.life = {status:'detected',isDead:value};
    assert.deepEqual(h.resolve(),unavailable);
  }
  h.live.life = {status:'unavailable',isDead:false};
  assert.deepEqual(h.resolve(),unavailable);
  h.live.life = {status:'detected',isDead:false};
  h.live.observedAt = new Date(h.time - 10000).toISOString();
  assert.equal(h.resolve().source,'live-client');
  h.live.observedAt = new Date(h.time - 10001).toISOString();
  assert.deepEqual(h.resolve(),unavailable);
  h.live.observedAt = new Date(h.time + 1001).toISOString();
  assert.deepEqual(h.resolve(),unavailable);
});

test('fresh primary API life does not depend on the LCU game ID while screen proof remains strictly scoped', () => {
  for (const gameId of [null,undefined]) {
    const h = harness();
    h.live.gameId = gameId;
    h.live.life = {status:'detected',isDead:true};
    assert.deepEqual(h.resolve(),{status:'detected',isDead:true,source:'live-client',observedAt:epoch});
    h.advance(500);
    h.live.life.isDead = false;
    assert.deepEqual(h.resolve(),{status:'detected',isDead:false,source:'live-client',observedAt:h.time});
    throwsCode(() => h.accept(dead({observedAt:h.time})),ScreenLifeConflictError,'context-ineligible');
  }
  const h = harness();
  h.live.life = {status:'detected',isDead:true};
  h.live.gameId = null;
  h.context.gameId = null;
  assert.equal(h.resolve().source,'live-client');
  for (const change of [
    value => {value.stage='loading';},
    value => {value.connection.status='waiting';},
    value => {value.mode={known:true,isMayhem:false};},
    value => {value.observedAt=new Date(epoch-10001).toISOString();},
  ]) {
    const current = structuredClone(h.live);
    change(current);
    assert.deepEqual(h.source.resolve(current,h.context),unavailable);
  }
});

test('unrelated phase, loading, disconnect, stale live context and explicit non-Mayhem revoke all screen history', () => {
  for (const change of [
    value => {value.phase = 'GameStart';},
    value => {value.stage = 'loading';},
    value => {value.connection.status = 'waiting';},
    value => {value.mode = {known:true,isMayhem:false};},
    value => {value.mode = {known:true};},
    value => {value.observedAt = new Date(epoch - 10001).toISOString();},
    value => {value.observedAt = 'invalid date';},
    value => {delete value.observedAt;},
    value => {value.gameId = 'other-game';},
  ]) {
    const h = harness();
    h.accept(dead());
    change(h.live);
    assert.deepEqual(h.resolve(),unavailable);
    throwsCode(() => h.accept(dead({observedAt:h.time + 1})),ScreenLifeConflictError,'context-ineligible');
    h.live = live();
    h.advance(2);
    throwsCode(() => h.accept(alive({observedAt:h.time})),ScreenLifeConflictError,'missing-dead-baseline');
  }
});

test('unknown game mode permits fallback without guessing an explicitly different mode', () => {
  const h = harness();
  h.live.mode = {known:false,isMayhem:false};
  assert.equal(h.accept(dead()).source,'screen');
});

test('game identity and epoch changes revoke history and never import previous-game observations', () => {
  for (const next of [{gameId:'other-game',gameEpoch:2},{gameId:'fixture-game',gameEpoch:3}]) {
    const h = harness();
    h.accept(dead());
    h.context = next;
    h.live.gameId = next.gameId;
    assert.deepEqual(h.resolve(),unavailable);
    throwsCode(() => h.accept(dead({observedAt:h.time + 1})),ScreenLifeConflictError,'context-changed');
    h.advance(1);
    throwsCode(() => h.accept(alive({...next,observedAt:h.time})),ScreenLifeConflictError,'missing-dead-baseline');
  }
});

test('only complete exact fixed proof fields are accepted; arbitrary text, pixels and names never enter storage', () => {
  const changes = [
    value => {value.extra = 'private player name';},
    value => {value.pixels = [1,2,3];},
    value => {delete value.code;},
    value => {value.provider = 'overwolf';},
    value => {value.gameId = '';},
    value => {value.gameId = null;},
    value => {value.gameEpoch = -1;},
    value => {value.gameEpoch = 1.5;},
    value => {value.observedAt = '1000000';},
    value => {value.stableFrames = 2;},
    value => {value.stableFrames = '3';},
    value => {value.stableFrames = 3.5;},
    value => {value.stableFrames = 10001;},
    value => {value.countdownSeconds = 0;},
    value => {value.countdownSeconds = 181;},
    value => {value.countdownSeconds = null;},
    value => {value.countdownSeconds = '15';},
    value => {value.code = 'arbitrary private error';},
    value => {value.state = 'alive';value.code = 'verified-respawn';},
    value => {value.state = 'unknown';value.code = 'unavailable';},
  ];
  for (const change of changes) {
    const h = harness();
    const value = dead();
    change(value);
    throwsCode(() => h.accept(value),ScreenLifeValidationError,'invalid-proof');
    assert.deepEqual(h.resolve(),unavailable);
    assert.ok(!JSON.stringify(h.source).includes('private'));
  }
  const h = harness();
  for (const value of [null,[],{},false,'proof']) throwsCode(() => h.accept(value),ScreenLifeValidationError,'invalid-proof');
});

test('proof timestamps are bounded and strictly monotonic, including after unknown clearing', () => {
  for (const observedAt of [epoch - 3001,epoch + 1001]) {
    const h = harness();
    throwsCode(() => h.accept(dead({observedAt})),ScreenLifeConflictError,'observation-stale');
  }
  const h = harness();
  h.accept(dead());
  for (const observedAt of [epoch,epoch - 1]) throwsCode(() => h.accept(dead({observedAt})),ScreenLifeConflictError,'observation-replayed');
  h.advance(1);
  h.accept(unknown({observedAt:h.time}));
  throwsCode(() => h.accept(dead({observedAt:epoch})),ScreenLifeConflictError,'observation-replayed');
  for (const observedAt of [NaN,Infinity,-1,epoch + 0.5]) throwsCode(() => h.accept(dead({observedAt})),ScreenLifeValidationError,'invalid-proof');
});

test('proof and context are copied rather than retained with arbitrary caller fields', () => {
  const h = harness();
  h.context.private = 'private account data';
  const proof = dead();
  h.accept(proof);
  proof.state = 'alive';
  h.context.private = 'different private data';
  assert.equal(h.resolve().isDead,true);
  assert.ok(!JSON.stringify(h.source).includes('private'));
  assert.deepEqual(h.source.context,{gameId:'fixture-game',gameEpoch:2});
});

test('invalid clock and absent or malformed contexts fail closed without assuming alive', () => {
  for (const bad of [null,{}, {gameId:null,gameEpoch:2},{gameId:'fixture-game',gameEpoch:-1}]) {
    const source = new ScreenLifeSource({now:() => epoch});
    assert.deepEqual(source.resolve(live(),bad),unavailable);
    throwsCode(() => source.accept(dead(),bad,live()),ScreenLifeConflictError,'context-ineligible');
  }
  const source = new ScreenLifeSource({now:() => NaN});
  assert.deepEqual(source.resolve(live(),context()),unavailable);
  throwsCode(() => source.accept(dead(),context(),live()),ScreenLifeConflictError,'context-ineligible');
});

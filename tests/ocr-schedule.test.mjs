import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_OCR_SCHEDULE_POLICY, OCR_SCHEDULE_MODES, OcrScanSchedule} from '../server/ocr-schedule.mjs';

function fixture(policy) {
  let now = Date.parse('2026-10-25T06:00:00Z');
  let live = {phase:'InProgress', stage:'live', connection:{status:'connected'}, level:3, gameTime:0,
    life:{status:'detected', isDead:false}, observedAt:new Date(now).toISOString(), mode:{known:true, isMayhem:true}};
  let gameEpoch = 1;
  const schedule = new OcrScanSchedule({now:() => now, policy});
  return {
    schedule,
    decide:extra => schedule.decision({live, gameEpoch, ...extra}),
    observe:() => schedule.observe({live, gameEpoch}),
    update:patch => { live = {...live, ...patch}; },
    advance:(ms, fresh = true) => { now += ms; if (fresh) {
      live.observedAt = new Date(now).toISOString();
      if (typeof live.gameTime === 'number') live.gameTime += ms / 1000;
    } },
    epoch:value => { gameEpoch = value; },
    timestamp:() => new Date(now).toISOString(),
    get now() { return now; },
  };
}

function died(f) {
  f.advance(1000); f.update({life:{status:'detected', isDead:true}}); f.observe();
}
function respawned(f) {
  f.advance(1000); f.update({life:{status:'detected', isDead:false}}); return f.decide();
}

test('defaults expose a bounded immutable event policy and fixed diagnostic modes', () => {
  assert.equal(DEFAULT_OCR_SCHEDULE_POLICY.windowMs, 60000);
  assert.equal(DEFAULT_OCR_SCHEDULE_POLICY.intervalMs, 500);
  assert.equal(DEFAULT_OCR_SCHEDULE_POLICY.followUpIntervalMs, 5000);
  assert.equal(DEFAULT_OCR_SCHEDULE_POLICY.cooldownMs, 100);
  assert.equal(DEFAULT_OCR_SCHEDULE_POLICY.snapshotFreshnessMs, 10000);
  assert.ok(Object.isFrozen(DEFAULT_OCR_SCHEDULE_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_OCR_SCHEDULE_POLICY.backoff));
  assert.ok(Object.isFrozen(OCR_SCHEDULE_MODES));
  assert.equal(new Set(OCR_SCHEDULE_MODES).size, OCR_SCHEDULE_MODES.length);
  assert.deepEqual(OCR_SCHEDULE_MODES, ['disabled', 'inactive', 'loading', 'other-mode', 'unknown', 'dead', 'idle', 'window', 'follow-up', 'backoff']);
});

test('loading, pause, inactive phases and known other modes never schedule OCR', () => {
  for (const [patch, extra, expected] of [
    [{phase:'GameStart', stage:'loading'}, {}, 'loading'],
    [{}, {enabled:false}, 'disabled'],
    [{phase:'Lobby'}, {}, 'inactive'],
    [{stage:'waiting'}, {}, 'inactive'],
    [{mode:{known:true, isMayhem:false}}, {}, 'other-mode'],
  ]) {
    const f = fixture(); f.update(patch);
    assert.equal(f.decide(extra).mode, expected);
    assert.equal(f.decide(extra).due, false);
    f.advance(60000);
    assert.equal(f.decide(extra).due, false);
  }
});

test('fresh loading to live transition in the same epoch opens one sixty second window', () => {
  const f = fixture();
  f.update({phase:'GameStart', stage:'loading', gameTime:null, connection:{status:'waiting'}, life:{status:'unavailable', isDead:null}});
  f.observe(); f.advance(90000); f.observe();
  f.advance(1000); f.update({phase:'InProgress', stage:'live', gameTime:1, connection:{status:'connected'}, life:{status:'detected', isDead:false}});
  const first = f.decide();
  assert.deepEqual(first, {mode:'window', due:true, intervalMs:500, nextInMs:0, windowRemainingMs:60000, trigger:'game-start', windowId:1});
  f.advance(1000); assert.equal(f.decide().windowRemainingMs, 59000);
  f.advance(59000); assert.equal(f.decide().mode, 'follow-up');
  f.advance(1000); assert.equal(f.decide({hasOffers:true, armed:true}).due, true);
  assert.equal(f.decide().windowId, first.windowId);
});

test('first live attachment inside the first minute uses remaining opening time then slow follow-up', () => {
  for (const [gameTime, remaining] of [[0, 60000], [0.5, 59500], [20, 40000], [59.999, 1]]) {
    const f = fixture(); f.update({gameTime});
    assert.equal(f.decide().windowRemainingMs, remaining);
    assert.equal(f.decide().trigger, 'game-start');
    f.advance(remaining); assert.equal(f.decide().mode, 'follow-up');
    assert.equal(f.decide().intervalMs, 5000); assert.equal(f.decide().due, true);
  }
});

test('mid or late game attachment never invents an opening event from alive, level or existing offers', () => {
  for (const gameTime of [60, 900, 3000, null, undefined, NaN, Infinity, -1, '12']) {
    const f = fixture(); f.update({gameTime, level:15});
    const decision = f.decide({hasOffers:true, armed:true});
    assert.equal(decision.mode, 'idle'); assert.equal(decision.due, false);
    assert.equal(decision.trigger, null); assert.equal(decision.windowId, null);
    f.advance(1000); assert.equal(f.decide({hasOffers:true}).due, false);
  }
});

test('a delayed first live sample deducts its age rather than receiving a fresh minute', () => {
  const f = fixture(); f.update({gameTime:20}); f.advance(4000, false);
  assert.equal(f.decide().windowRemainingMs, 36000);
  const transition = fixture(); transition.update({stage:'loading'}); transition.observe();
  transition.advance(1000); transition.update({stage:'live', gameTime:1}); transition.advance(3000, false);
  assert.equal(transition.decide().windowRemainingMs, 57000);
});

test('only a fresh known dead to alive edge opens a respawn window', () => {
  const f = fixture(); f.update({gameTime:900}); assert.equal(f.decide().due, false);
  died(f); assert.equal(f.decide().mode, 'dead'); assert.equal(f.decide().due, false);
  const first = respawned(f);
  assert.equal(first.mode, 'window'); assert.equal(first.trigger, 'respawn');
  assert.equal(first.windowRemainingMs, 60000); assert.equal(first.windowId, 1);
  f.advance(1000); assert.equal(f.decide().windowRemainingMs, 59000);
  f.advance(59000); assert.equal(f.decide().mode, 'follow-up');
  died(f); const second = respawned(f);
  assert.equal(second.windowId, 2); assert.equal(second.windowRemainingMs, 60000);
});

test('unknown life data does not trigger a window or infer a resurrection', () => {
  const f = fixture(); f.update({gameTime:900, life:{status:'unavailable', isDead:null}}); f.observe();
  f.advance(1000); f.update({life:{status:'detected', isDead:false}});
  assert.equal(f.decide().mode, 'idle');
  for (const life of [null, {}, {status:'detected'}, {status:'detected', isDead:0}, {status:'unavailable', isDead:false}, {status:'detected', isDead:'false'}]) {
    f.advance(1000); f.update({life}); assert.equal(f.decide().due, false);
  }
  died(f); f.advance(1000); f.update({life:{status:'unavailable', isDead:null}});
  assert.equal(f.decide().mode, 'dead', 'unavailable is not evidence that a known dead player is alive');
  assert.equal(respawned(f).trigger, 'respawn', 'a brief unknown gap does not erase recent reliable evidence');
});

test('explicit screen life timestamps are independently fresh and do not inherit raw keepalives', () => {
  const f = fixture(); f.update({gameTime:900}); f.observe();
  f.advance(1000); const capturedAt = f.now;
  f.update({life:{status:'detected', isDead:true, observedAt:capturedAt}}); f.observe();
  for (let n = 0; n < 12; n++) { f.advance(1000); f.observe(); }
  assert.equal(f.schedule.lastLife.observedAt, capturedAt);
  f.advance(1000); f.update({life:{status:'detected', isDead:false, observedAt:f.now}});
  assert.equal(f.decide().due, false, 'an old dead proof is not a fresh respawn edge');
});

test('explicit ISO screen evidence uses its capture time and rejects stale, invalid or reversed proofs', () => {
  for (const observedAt of [null, 'invalid', Infinity, -1, '2026-10-25T05:59:49.000Z', '2026-10-25T06:00:02.000Z']) {
    const f = fixture(); f.update({gameTime:900, life:{status:'detected', isDead:true, observedAt}}); f.observe();
    f.advance(1000); f.update({life:{status:'detected', isDead:false, observedAt:f.timestamp()}});
    assert.equal(f.decide().due, false);
  }
  const f = fixture(); f.update({gameTime:900}); f.observe();
  f.advance(1000); f.update({life:{status:'detected', isDead:true, observedAt:f.timestamp()}}); f.observe();
  const deadAt = f.now;
  f.advance(1000); f.update({life:{status:'detected', isDead:false, observedAt:deadAt - 1}});
  assert.equal(f.decide().due, false);
  f.advance(1000); f.update({life:{status:'detected', isDead:false, observedAt:f.timestamp()}});
  assert.equal(f.decide().trigger, 'respawn');
});

test('new screen life evidence can be consumed against the same fresh collector timestamp', () => {
  const f = fixture(); f.update({gameTime:900}); f.observe();
  f.advance(1000); const rawObserved = f.timestamp();
  f.update({life:{status:'detected', isDead:true, observedAt:f.now - 200}}); f.observe();
  f.advance(100, false); f.update({observedAt:rawObserved, life:{status:'detected', isDead:false, observedAt:f.now}});
  const alive = f.decide();
  assert.equal(alive.trigger, 'respawn'); assert.equal(alive.windowRemainingMs, 60000);
});

test('forgetLife breaks an unfocused screen chain without starting or renewing any window', () => {
  const f = fixture(); f.update({gameTime:900}); f.observe(); died(f);
  f.schedule.forgetLife(); assert.equal(f.schedule.lastLife, null);
  f.advance(1000); f.update({life:{status:'detected', isDead:false, observedAt:f.now}});
  assert.equal(f.decide().mode, 'idle'); assert.equal(f.decide().windowId, null);
  const opening = fixture(); opening.observe(); opening.advance(1000); opening.schedule.forgetLife();
  assert.equal(opening.decide().windowRemainingMs, 59000);
});

test('dead evidence too old to witness a respawn cannot invent a new choice window', () => {
  const f = fixture(); f.update({gameTime:900}); f.observe(); died(f);
  f.advance(10001); f.update({life:{status:'detected', isDead:false}});
  assert.equal(f.decide().mode, 'idle'); assert.equal(f.decide().windowId, null);
});

test('repeated alive or dead frames never extend windows, and death closes an active opening window', () => {
  const f = fixture(); f.observe(); const openingId = f.decide().windowId;
  for (let i = 0; i < 30; i++) { f.advance(1000); f.observe(); }
  assert.equal(f.decide().windowRemainingMs, 30000);
  died(f); assert.equal(f.decide().windowRemainingMs, 0);
  for (let i = 0; i < 30; i++) { f.advance(1000); f.observe(); }
  assert.equal(f.decide().windowId, openingId);
  assert.equal(f.decide().due, false);
  assert.equal(respawned(f).windowId, openingId + 1);
});

test('confirmation closes the current window despite candidates and a later actual respawn still works', () => {
  const f = fixture(); f.observe(); f.schedule.confirmed();
  for (const extra of [{}, {hasOffers:true}, {hasOffers:true, armed:true}]) {
    assert.equal(f.decide(extra).mode, 'idle'); assert.equal(f.decide(extra).due, false);
  }
  f.advance(1000); f.update({level:7}); assert.equal(f.decide().due, false);
  died(f); assert.equal(respawned(f).trigger, 'respawn');
  f.schedule.confirmed(); assert.equal(f.decide({hasOffers:true}).due, false);
});

test('levels, armed state, and candidates have no influence on timing or event identity', () => {
  const f = fixture(); const first = f.decide();
  for (const [index, level] of [3, 7, 11, 15, null, 16].entries()) {
    f.advance(1000); f.update({level});
    const decision = f.decide({hasOffers:true, armed:index % 2 === 0});
    assert.equal(decision.windowRemainingMs, 60000 - (index + 1) * 1000);
    assert.equal(decision.windowId, first.windowId); assert.equal(decision.intervalMs, 500);
  }
  f.advance(60000); const followUp = f.decide({hasOffers:true, armed:true});
  assert.equal(followUp.mode, 'follow-up'); assert.equal(followUp.due, true);
  assert.equal(followUp.windowId, first.windowId);
});

test('short scans start at the 500ms target, with no overlapping work', () => {
  const f = fixture(); f.observe(); f.schedule.started();
  f.advance(200); assert.equal(f.decide().due, false);
  f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 300);
  f.advance(299); assert.equal(f.decide().due, false);
  f.advance(1); assert.equal(f.decide().due, true);
});

test('slow scans finish serially and keep a 100ms completion rest', () => {
  const f = fixture(); f.observe();
  for (let pass = 0; pass < 3; pass++) {
    f.schedule.started(); f.advance(10000);
    assert.equal(f.decide().due, false);
    f.schedule.completed({status:'recognized'});
    assert.equal(f.decide().nextInMs, 100);
    f.advance(99); assert.equal(f.decide().due, false);
    f.advance(1); assert.equal(f.decide().due, true);
  }
});

test('fast to follow-up transition keeps one cycle ID and starts from the last actual OCR start', () => {
  const f = fixture(); const opening = f.decide();
  f.advance(59500); f.schedule.started();
  f.advance(200); f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 300);
  f.advance(300);
  const slow = f.decide();
  assert.equal(slow.mode, 'follow-up'); assert.equal(slow.windowRemainingMs, 0);
  assert.equal(slow.intervalMs, 5000); assert.equal(slow.windowId, opening.windowId);
  assert.equal(slow.nextInMs, 4500, 'entering follow-up does not start a second five second delay');
  f.advance(4499); assert.equal(f.decide().due, false);
  f.advance(1); assert.equal(f.decide().due, true);
});

test('in-flight fast OCR can complete after the fast deadline without being cancelled or overlapping', () => {
  const f = fixture(); const first = f.decide();
  f.advance(59900); f.schedule.started(); f.advance(500);
  const pending = f.decide();
  assert.equal(pending.mode, 'follow-up'); assert.equal(pending.windowId, first.windowId);
  assert.equal(pending.due, false); assert.equal(f.schedule.activeScan, true);
  f.schedule.completed({status:'recognized'});
  assert.equal(f.schedule.lastCompletedAt, f.now);
  assert.equal(f.decide().nextInMs, 4500);
  f.advance(4500); assert.equal(f.decide().due, true);
});

test('slow follow-up tasks preserve five second targets and completion cooldown for long work', () => {
  const f = fixture(); f.observe(); f.advance(60000);
  assert.equal(f.decide().mode, 'follow-up'); f.schedule.started();
  f.advance(200); f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 4800);
  f.advance(4800); assert.equal(f.decide().due, true); f.schedule.started();
  f.advance(7000); assert.equal(f.decide().due, false);
  f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 100);
  f.advance(99); assert.equal(f.decide().due, false);
  f.advance(1); assert.equal(f.decide().due, true);
});

test('confirming in follow-up permanently closes that cycle until a fresh respawn', () => {
  const f = fixture(); f.observe(); f.advance(60000); const slow = f.decide();
  f.schedule.started(); f.advance(300); f.schedule.confirmed();
  f.schedule.completed({status:'unavailable', code:'ocr-engine-unavailable'});
  for (let n = 0; n < 65; n++) {
    f.advance(1000); f.update({level:n % 2 ? 7 : 11});
    assert.equal(f.decide({hasOffers:true, armed:true}).mode, 'idle');
    assert.equal(f.decide().due, false); assert.equal(f.decide().windowId, slow.windowId);
  }
  assert.equal(f.schedule.backoffUntil, 0);
  died(f); const next = respawned(f);
  assert.equal(next.mode, 'window'); assert.equal(next.windowRemainingMs, 60000);
  assert.equal(next.windowId, slow.windowId + 1);
});

test('death ends slow follow-up and ignores its late completion before a fresh respawn', () => {
  const f = fixture(); f.observe(); f.advance(60000); const slow = f.decide();
  f.schedule.started(); died(f);
  assert.equal(f.decide().mode, 'dead'); assert.equal(f.decide().windowRemainingMs, 0);
  assert.equal(f.schedule.awaitingConfirmation, false);
  f.schedule.completed({status:'unavailable', code:'ocr-engine-unavailable'});
  assert.equal(f.schedule.backoffUntil, 0);
  f.advance(5000); assert.equal(f.decide().due, false);
  const next = respawned(f);
  assert.equal(next.mode, 'window'); assert.equal(next.windowId, slow.windowId + 1);
  assert.equal(next.due, true);
});

test('pausing slow follow-up does not reopen fast scanning or lose the existing cycle', () => {
  const f = fixture(); f.observe(); f.advance(60000); const slow = f.decide();
  assert.equal(f.decide({enabled:false}).mode, 'disabled');
  f.advance(15000); const resumed = f.decide({enabled:true});
  assert.equal(resumed.mode, 'follow-up'); assert.equal(resumed.intervalMs, 5000);
  assert.equal(resumed.windowId, slow.windowId); assert.equal(resumed.due, true);
});

test('a scan crossing the fast deadline releases busy into follow-up and preserves completion backoff', () => {
  const f = fixture(); f.observe(); f.schedule.started(); f.advance(60000);
  assert.equal(f.decide().mode, 'follow-up'); assert.equal(f.decide().due, false);
  f.schedule.completed({status:'unavailable', code:'scan-execution-failed'});
  assert.equal(f.schedule.activeScan, false); assert.equal(f.decide({hasOffers:true}).due, false);
  assert.equal(f.decide().mode, 'backoff'); assert.equal(f.decide().nextInMs, 5000);
  f.advance(5000); assert.equal(f.decide().due, true);
});

test('external in-flight state and duplicate starts cannot enqueue or rewrite a start target', () => {
  const f = fixture(); assert.equal(f.decide({inFlight:true}).due, false);
  f.schedule.started(); f.advance(200); f.schedule.started();
  f.advance(100); f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 200);
  f.advance(200); assert.equal(f.decide().due, true);
});

test('engine failures back off beyond the fast deadline without losing the choice cycle', () => {
  const f = fixture(); f.observe();
  for (const delay of [5000, 10000, 20000]) {
    f.schedule.started(); f.advance(500);
    f.schedule.completed({status:'unavailable', code:'ocr-engine-unavailable'});
    assert.equal(f.decide().mode, 'backoff'); assert.equal(f.decide().nextInMs, delay);
    f.advance(delay - 1); assert.equal(f.decide().due, false);
    f.advance(1); assert.equal(f.decide().due, true);
  }
  f.schedule.started(); f.advance(500); f.schedule.completed({status:'unavailable', code:'ocr-engine-unavailable'});
  assert.equal(f.schedule.backoffDelay(), 30000);
  const before = f.decide(); const sameId = before.windowId;
  assert.equal(before.nextInMs, before.windowRemainingMs, 'the fast phase wakes at its boundary');
  f.advance(before.windowRemainingMs); assert.equal(f.decide().mode, 'backoff');
  assert.equal(f.decide().intervalMs, 30000); assert.equal(f.decide().windowId, sameId);
  f.advance(f.decide().nextInMs); assert.equal(f.decide().due, true);
});

test('foreground failures remain bounded and are reset by a fresh respawn window', () => {
  const f = fixture(); f.observe();
  for (let n = 0; n < 4; n++) {
    f.schedule.started(); f.advance(500);
    f.schedule.completed({status:'waiting', code:n % 2 ? 'foreground-changed' : 'game-not-foreground'});
    assert.equal(f.decide().nextInMs, 5000); f.advance(5000);
  }
  died(f); const fresh = respawned(f);
  assert.equal(fresh.mode, 'window'); assert.equal(fresh.due, true);
});

test('a successful scan resets failures, while expected no-title frames are not faults', () => {
  const f = fixture(); f.observe(); f.schedule.started(); f.advance(500);
  f.schedule.completed({status:'unavailable', code:'scan-execution-failed'});
  f.advance(5000); f.schedule.started(); f.advance(500); f.schedule.completed({status:'recognized', code:'title-layout-confirmed'});
  assert.equal(f.decide().mode, 'window'); assert.equal(f.schedule.failureStreak, 0);
  for (const code of ['ocr-no-text', 'title-name-unmatched', 'title-layout-incomplete', 'title-layout-ambiguous', 'scan-offer-consumed', 'scan-busy']) {
    f.advance(500); f.schedule.started(); f.advance(500);
    f.schedule.completed({status:'unavailable', code});
    assert.equal(f.decide().mode, 'window'); assert.equal(f.decide().nextInMs, 100);
  }
});

test('disconnected, missing, old, invalid and implausibly future observations cannot create events', () => {
  for (const patch of [
    {connection:{status:'waiting'}}, {observedAt:null}, {observedAt:'invalid'},
    {observedAt:'2026-10-25T05:59:49.999Z'}, {observedAt:'2026-10-25T06:00:01.001Z'},
  ]) {
    const f = fixture(); f.update(patch);
    assert.equal(f.decide().mode, 'unknown'); assert.equal(f.decide().windowId, null);
  }
  const future = fixture(); future.update({observedAt:'2026-10-25T06:00:01.000Z'});
  assert.equal(future.decide().windowRemainingMs, 60000, 'tolerated future timestamp must not add time');
  const old = fixture(); old.update({stage:'loading', observedAt:'2026-10-25T05:59:49.999Z'}); old.observe();
  old.advance(1000); old.update({stage:'live', gameTime:900}); assert.equal(old.decide().due, false);
});

test('a stale current snapshot pauses scanning without renewing or pausing the deadline', () => {
  const f = fixture(); f.observe(); f.advance(10001, false);
  assert.equal(f.decide().mode, 'unknown'); assert.equal(f.decide().due, false);
  f.advance(1000); assert.equal(f.decide().windowRemainingMs, 48999);
  f.advance(48999); assert.equal(f.decide().mode, 'follow-up');
  assert.equal(f.decide().intervalMs, 5000);
});

test('duplicate timestamps cannot synthesize a dead to alive edge', () => {
  const f = fixture(); f.update({gameTime:900}); f.observe();
  f.update({life:{status:'detected', isDead:true}}); f.observe();
  f.advance(1000); f.update({life:{status:'detected', isDead:false}});
  assert.equal(f.decide().due, false); assert.equal(f.decide().windowId, null);
});

test('out of order observations and regressing game clocks cannot synthesize a respawn', () => {
  const f = fixture(); f.update({gameTime:900}); f.observe(); died(f); const deathTime = f.timestamp();
  f.advance(1000); f.update({observedAt:deathTime, life:{status:'detected', isDead:false}});
  assert.equal(f.decide().due, false);
  f.advance(1000); f.update({gameTime:898});
  assert.equal(f.decide().mode, 'unknown'); assert.equal(f.decide().windowId, null);
  f.advance(1000); f.update({gameTime:904});
  assert.equal(f.decide().trigger, 'respawn', 'the later valid alive evidence may close the witnessed death');
});

test('new epochs clear old loading and life state and reject a late older epoch', () => {
  const f = fixture(); f.observe(); died(f);
  f.epoch(2); f.advance(1000); f.update({gameTime:900, life:{status:'detected', isDead:false}});
  assert.equal(f.decide().windowId, null); assert.equal(f.decide().due, false);
  f.epoch(1); f.advance(1000); f.update({gameTime:0});
  assert.equal(f.decide().mode, 'unknown'); assert.equal(f.decide().due, false);
  f.epoch(3); f.advance(1000); assert.equal(f.decide().trigger, 'game-start');
});

test('new epoch cannot inherit an old loading transition', () => {
  const f = fixture(); f.update({stage:'loading'}); f.observe();
  f.epoch(2); f.advance(1000); f.update({stage:'live', gameTime:900});
  assert.equal(f.decide().due, false); assert.equal(f.decide().trigger, null);
});

test('an old epoch completion releases busy without poisoning the new opening window', () => {
  const f = fixture(); f.observe(); f.schedule.started(); f.advance(2000);
  f.epoch(2); f.update({gameTime:0}); const fresh = f.decide();
  assert.equal(fresh.due, false); assert.equal(fresh.windowId, 2);
  f.schedule.completed({status:'unavailable', code:'scan-execution-failed'});
  assert.equal(f.decide().due, true); assert.equal(f.schedule.backoffUntil, 0);
});

test('an old window completion releases busy without poisoning the respawn window', () => {
  const f = fixture(); f.observe(); f.schedule.started(); died(f); const fresh = respawned(f);
  assert.equal(fresh.windowId, 2); assert.equal(fresh.due, false);
  f.schedule.completed({status:'unavailable', code:'scan-execution-failed'});
  assert.equal(f.decide().due, true); assert.equal(f.schedule.backoffUntil, 0);
});

test('an old follow-up completion cannot write pacing into a new game or respawn cycle', () => {
  for (const nextEvent of ['game', 'respawn']) {
    const f = fixture(); f.observe(); f.advance(60000); const slow = f.decide();
    assert.equal(slow.mode, 'follow-up'); f.schedule.started();
    if (nextEvent === 'game') {
      f.epoch(2); f.advance(1000); f.update({gameTime:0});
    } else {
      died(f); respawned(f);
    }
    const fresh = f.decide();
    assert.equal(fresh.mode, 'window'); assert.equal(fresh.windowId, slow.windowId + 1);
    assert.equal(fresh.due, false, 'the one old OCR task remains serial until it returns');
    f.schedule.completed({status:'unavailable', code:'scan-execution-failed'});
    assert.equal(f.decide().due, true); assert.equal(f.schedule.lastCompletedAt, null);
    assert.equal(f.schedule.failureStreak, 0); assert.equal(f.schedule.backoffUntil, 0);
  }
});

test('confirmation while OCR is running prevents late completion from reviving the window', () => {
  const f = fixture(); f.observe(); f.schedule.started(); f.advance(1000); f.schedule.confirmed();
  f.schedule.completed({status:'unavailable', code:'ocr-engine-unavailable'});
  assert.equal(f.decide({hasOffers:true}).due, false); assert.equal(f.schedule.backoffUntil, 0);
});

test('transient ineligible phases, loading repeats, disable and reenabling never renew a used window', () => {
  const f = fixture(); f.observe(); f.schedule.confirmed();
  for (const patch of [{phase:'None'}, {phase:'InProgress', stage:'loading'}, {stage:'live'}]) {
    f.advance(1000); f.update(patch); assert.equal(f.decide().due, false);
  }
  assert.equal(f.decide({enabled:false}).due, false);
  f.advance(1000); assert.equal(f.decide({enabled:true}).due, false);
});

test('unknown mode metadata does not fabricate an event or block a verified opening', () => {
  const f = fixture(); f.update({mode:{known:false}});
  assert.equal(f.decide().due, true); f.schedule.confirmed();
  f.advance(1000); assert.equal(f.decide({hasOffers:true}).due, false);
});

test('custom event timings are bounded and legacy level/battle policy is ignored', () => {
  const f = fixture({windowMs:45000, intervalMs:750, followUpIntervalMs:7000, cooldownMs:250,
    snapshotFreshnessMs:5000, futureToleranceMs:0, levels:[5, 9], intervals:{battle:0},
    backoff:{initialMs:6000, maxMs:24000, foregroundMs:3000}});
  assert.equal(f.decide().windowRemainingMs, 45000); assert.equal(f.decide().intervalMs, 750);
  f.advance(45000); assert.equal(f.decide().intervalMs, 7000);
  assert.equal(f.schedule.policy.cooldownMs, 250); assert.equal(f.schedule.policy.levels, undefined);
  for (const value of [0, 499, -1, NaN, Infinity, '500']) {
    const invalid = fixture({intervalMs:value, cooldownMs:0, windowMs:-1});
    assert.equal(invalid.schedule.policy.intervalMs, 500);
    assert.equal(invalid.schedule.policy.cooldownMs, 100);
    assert.equal(invalid.schedule.policy.windowMs, 60000);
  }
  for (const value of [0, 999, 30001, -1, NaN, Infinity, '5000']) {
    assert.equal(fixture({followUpIntervalMs:value}).schedule.policy.followUpIntervalMs, 5000);
  }
});

test('diagnostics have fixed fields, bounded values, no identity, and monotonic clock behavior', () => {
  let now = 100000;
  const schedule = new OcrScanSchedule({now:() => now});
  const live = {phase:'InProgress', stage:'live', gameTime:0, connection:{status:'connected'},
    life:{status:'detected', isDead:false}, observedAt:new Date(now).toISOString(),
    gameId:'private-game', summonerName:'private-player', mode:{known:true, isMayhem:true}};
  const first = schedule.decision({live, gameEpoch:1}); schedule.started();
  now -= 1000; schedule.completed({status:'unavailable', code:'private-error-path'});
  const decision = schedule.decision({live, gameEpoch:1});
  assert.equal(first.windowRemainingMs, 60000); assert.ok(OCR_SCHEDULE_MODES.includes(decision.mode));
  assert.deepEqual(Object.keys(decision).sort(), ['mode', 'due', 'intervalMs', 'nextInMs', 'windowRemainingMs', 'trigger', 'windowId'].sort());
  for (const key of ['intervalMs', 'nextInMs']) assert.ok(Number.isSafeInteger(decision[key]) && decision[key] >= 0 && decision[key] <= 30000);
  assert.ok(decision.windowRemainingMs <= 120000);
  assert.doesNotMatch(JSON.stringify(schedule), /private-game|private-player|private-error-path/);
});

test('manual OCR outside a window remains callable without creating automatic work', () => {
  const f = fixture(); f.update({gameTime:900}); f.observe();
  f.schedule.started(); assert.equal(f.schedule.activeScan, true);
  f.advance(1000); f.schedule.completed({status:'recognized'});
  assert.equal(f.schedule.activeScan, false); assert.equal(f.decide().mode, 'idle');
  assert.equal(f.decide({hasOffers:true, armed:true}).due, false);
});

test('a fifteen minute unconfirmed battle follows up every five seconds after the opening minute', () => {
  const f = fixture(); let count = 0;
  const start = f.now;
  while (f.now - start < 900000) {
    if (f.decide().due) {
      count++; f.schedule.started(); f.advance(100); f.schedule.completed({status:'unavailable', code:'title-layout-incomplete'});
    }
    f.advance(100);
  }
  assert.equal(count, 288);
  assert.equal(f.decide().mode, 'follow-up'); assert.equal(f.decide().intervalMs, 5000);
  f.schedule.confirmed(); assert.equal(f.decide({hasOffers:true, armed:true}).due, false);
  died(f); assert.equal(respawned(f).due, true);
});

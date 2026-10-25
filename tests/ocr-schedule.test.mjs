import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_OCR_SCHEDULE_POLICY, OCR_SCHEDULE_MODES, OcrScanSchedule} from '../server/ocr-schedule.mjs';

function fixture(policy) {
  let now = Date.parse('2026-10-25T06:00:00Z');
  let live = {phase:'InProgress', stage:'live', connection:{status:'connected'}, level:2,
    observedAt:new Date(now).toISOString(), mode:{known:true, isMayhem:true}};
  let gameEpoch = 1;
  const schedule = new OcrScanSchedule({now:() => now, policy});
  return {
    schedule,
    decide:extra => schedule.decision({live, gameEpoch, ...extra}),
    observe:() => schedule.observe({live, gameEpoch}),
    update:patch => { live = {...live, ...patch}; },
    advance:(ms, fresh = true) => { now += ms; if (fresh) live.observedAt = new Date(now).toISOString(); },
    epoch:value => { gameEpoch = value; },
    timestamp:() => new Date(now).toISOString(),
    get now() { return now; },
  };
}

test('defaults expose a bounded immutable policy and fixed diagnostic mode vocabulary', () => {
  assert.deepEqual(DEFAULT_OCR_SCHEDULE_POLICY.levels, [3, 7, 11, 15]);
  assert.deepEqual(DEFAULT_OCR_SCHEDULE_POLICY.intervals, {
    battle:5000, unknown:5000, approaching:3000, boost:1000, offersAcquiring:1000, offersArmed:1000,
  });
  assert.deepEqual(DEFAULT_OCR_SCHEDULE_POLICY.cooldowns, {
    battle:1000, unknown:2500, approaching:1000, boost:250, offersAcquiring:250, offersArmed:250,
  });
  assert.equal(DEFAULT_OCR_SCHEDULE_POLICY.boostDurationMs, 60000);
  assert.ok(Object.isFrozen(DEFAULT_OCR_SCHEDULE_POLICY.intervals));
  assert.ok(Object.isFrozen(OCR_SCHEDULE_MODES));
  assert.equal(new Set(OCR_SCHEDULE_MODES).size, OCR_SCHEDULE_MODES.length);
});

test('loading, pause, inactive phases and known other modes never schedule OCR', () => {
  for (const [patch, extra, expected] of [
    [{phase:'GameStart', stage:'loading'}, {}, 'loading'],
    [{}, {enabled:false}, 'disabled'],
    [{phase:'Lobby'}, {}, 'inactive'],
    [{mode:{known:true, isMayhem:false}}, {}, 'other-mode'],
  ]) {
    const f = fixture(); f.update(patch);
    assert.deepEqual(f.decide(extra), {mode:expected, due:false, intervalMs:0, nextInMs:0, boostRemainingMs:0});
    f.advance(60000);
    assert.equal(f.decide(extra).due, false);
  }
});

test('loading observations do not consume the first live boost or level crossing', () => {
  const f = fixture();
  f.update({phase:'GameStart', stage:'loading', level:3});
  f.observe(); f.advance(90000); f.observe();
  f.update({phase:'InProgress', stage:'live'});
  assert.deepEqual(f.decide(), {mode:'boost', due:true, intervalMs:1000, nextInMs:0, boostRemainingMs:60000, triggerLevel:3});
});

test('first live observation gets one short opening boost rather than extending every poll', () => {
  const f = fixture();
  assert.equal(f.decide().boostRemainingMs, 30000);
  for (let i = 0; i < 30; i++) { f.advance(1000); f.observe(); }
  assert.equal(f.decide().mode, 'battle');
  assert.equal(f.decide().boostRemainingMs, 0);
});

test('3, 7, 11 and 15 crossing each start a single bounded window', () => {
  const f = fixture(); f.observe();
  for (const level of [3, 7, 11, 15]) {
    f.advance(1000); f.update({level});
    assert.equal(f.decide().triggerLevel, level);
    assert.equal(f.decide().boostRemainingMs, 60000);
    f.advance(60000); f.observe();
    assert.equal(f.decide().boostRemainingMs, 0);
    f.advance(1000);
    assert.equal(f.decide().boostRemainingMs, 0, 'the same level must not renew the boost');
  }
});

test('skipped levels and mid-game attachment still discover the latest unseen threshold', () => {
  const f = fixture(); f.update({level:6}); f.observe(); f.schedule.confirmed();
  f.update({level:8});
  assert.equal(f.decide().triggerLevel, 7);
  const joined = fixture(); joined.update({level:16});
  assert.equal(joined.decide().triggerLevel, 15);
  joined.schedule.confirmed(); joined.update({level:9}); joined.observe();
  joined.update({level:16});
  assert.equal(joined.decide().boostRemainingMs, 0, 'a level regression cannot reuse thresholds');
});

test('unknown or stale levels use a nonzero fallback and cannot invent a crossing', () => {
  for (const level of [null, undefined, NaN, Infinity, 0, 31, -1, 7.5, '7']) {
    const f = fixture(); f.update({level});
    const decision = f.decide();
    assert.equal(decision.mode, 'unknown');
    assert.equal(decision.due, true);
    assert.equal(decision.intervalMs, 5000);
    assert.equal(decision.boostRemainingMs, 0);
    assert.ok(!Object.hasOwn(decision, 'triggerLevel'));
  }
  const missing = fixture(); missing.update({level:7, observedAt:null});
  assert.equal(missing.decide().mode, 'unknown');
  const stale = fixture(); stale.update({level:7}); stale.advance(10001, false);
  assert.equal(stale.decide().mode, 'unknown');
  stale.update({observedAt:stale.timestamp()});
  assert.equal(stale.decide().triggerLevel, 7);
});

test('disconnected, invalid and implausibly future timestamps do not strengthen the level signal', () => {
  for (const patch of [
    {level:7, connection:{status:'waiting'}}, {level:7, observedAt:'invalid'},
    {level:7, observedAt:'2026-10-25T06:00:01.001Z'},
  ]) {
    const f = fixture(); f.update(patch);
    assert.equal(f.decide().mode, 'unknown');
  }
  const f = fixture(); f.update({level:7, observedAt:'2026-10-25T06:00:01.000Z'});
  assert.equal(f.decide().triggerLevel, 7);
});

test('a fresh recovery after losing level data starts a missed threshold only once', () => {
  const f = fixture(); f.update({level:6}); f.observe(); f.schedule.confirmed();
  f.update({level:null}); f.advance(15000);
  assert.equal(f.decide().mode, 'unknown');
  f.update({level:8});
  assert.equal(f.decide().triggerLevel, 7);
  f.advance(61000); f.update({level:null}); f.observe(); f.update({level:8});
  assert.equal(f.decide().boostRemainingMs, 0);
});

test('6, 10 and 14 use the approaching mode after the bounded boost ends', () => {
  for (const level of [6, 10, 14]) {
    const f = fixture(); f.update({level}); f.observe(); f.schedule.confirmed();
    assert.equal(f.decide().mode, 'approaching');
    assert.equal(f.decide().intervalMs, 3000);
  }
});

test('confirmation ends only the current boost and later thresholds still work', () => {
  const f = fixture(); f.update({level:3}); f.observe();
  f.schedule.confirmed();
  assert.equal(f.decide().mode, 'battle');
  f.advance(1000); f.update({level:7});
  assert.equal(f.decide().triggerLevel, 7);
  f.schedule.confirmed(); f.update({level:16}); f.observe(); f.schedule.confirmed();
  assert.equal(f.decide().mode, 'battle');
  assert.equal(f.decide().due, true, 'the fourth ordinary choice must not turn off fallback OCR');
});

test('backend armed does not slow the fresh witnesses needed for native Ready', () => {
  const f = fixture(); f.update({level:16}); f.observe(); f.schedule.confirmed();
  assert.equal(f.decide({hasOffers:true, armed:false}).mode, 'offers-acquiring');
  assert.equal(f.decide({hasOffers:true, armed:false}).intervalMs, 1000);
  const armed = f.decide({hasOffers:true, armed:true});
  assert.equal(armed.mode, 'offers-armed');
  assert.equal(armed.intervalMs, 1000);
  f.schedule.started(); f.advance(2000); f.schedule.completed({status:'recognized'});
  f.advance(249);
  assert.equal(f.decide({hasOffers:true, armed:true}).due, false);
  f.advance(1);
  assert.equal(f.decide({hasOffers:true, armed:true}).due, true);
});

test('armed reference refresh leaves room in the unchanged 30 second lease even with a slow successful pass', () => {
  const f = fixture(); f.observe();
  f.schedule.started(); f.advance(10000); f.schedule.completed({status:'recognized'});
  const decision = f.decide({hasOffers:true, armed:true});
  assert.equal(decision.nextInMs, 250);
  f.advance(250); assert.equal(f.decide({hasOffers:true, armed:true}).due, true);
  // A second ten-second capture completes at 20.25s after the previous frame,
  // before the observer's existing 30s expiry. No lease is extended here.
  assert.ok(10000 + decision.nextInMs + 10000 < 30000);
});

test('battle scans respect a five-second start target and one-second completion cooldown', () => {
  const f = fixture(); f.observe(); f.schedule.confirmed();
  f.schedule.started(); f.advance(12000);
  assert.equal(f.decide().due, false, 'a slow scan must not overlap');
  f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 1000);
  f.advance(999); assert.equal(f.decide().due, false);
  f.advance(1); assert.equal(f.decide().due, true);
});

test('short battle scans resume at the five-second start target rather than five seconds after completion', () => {
  const f = fixture(); f.observe(); f.schedule.confirmed();
  f.schedule.started(); f.advance(200); f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 4800);
  f.advance(4799); assert.equal(f.decide().due, false);
  f.advance(1); assert.equal(f.decide().due, true);
});

test('short boost and candidate scans can start once per second without skipping their completion rest', () => {
  for (const extra of [{}, {hasOffers:true, armed:false}, {hasOffers:true, armed:true}]) {
    const f = fixture(); f.update({level:7}); f.observe();
    f.schedule.started(); f.advance(200); f.schedule.completed({status:'recognized'});
    assert.equal(f.decide(extra).nextInMs, 800);
    f.advance(799); assert.equal(f.decide(extra).due, false);
    f.advance(1); assert.equal(f.decide(extra).due, true);
    f.schedule.started(); f.advance(900); f.schedule.completed({status:'recognized'});
    assert.equal(f.decide(extra).nextInMs, 250, 'a one-second target does not override minimum rest');
    f.advance(249); assert.equal(f.decide(extra).due, false);
    f.advance(1); assert.equal(f.decide(extra).due, true);
  }
});

test('boost and both candidate modes keep a 250ms rest even when the target interval passed', () => {
  for (const extra of [{}, {hasOffers:true, armed:false}, {hasOffers:true, armed:true}]) {
    const f = fixture(); f.update({level:7}); f.observe();
    f.schedule.started(); f.advance(9000); f.schedule.completed({status:'recognized'});
    assert.equal(f.decide(extra).nextInMs, 250);
    f.advance(249); assert.equal(f.decide(extra).due, false);
    f.advance(1); assert.equal(f.decide(extra).due, true);
  }
});

test('new level crossings cannot bypass the completion cooldown of an active scan', () => {
  const f = fixture(); f.observe(); f.schedule.confirmed(); f.schedule.started();
  f.advance(10000); f.update({level:7}); f.observe();
  assert.equal(f.decide().due, false);
  f.schedule.completed({status:'recognized'});
  assert.equal(f.decide().nextInMs, 250);
});

test('external in-flight state and duplicate starts cannot enqueue or rewrite a scan start', () => {
  const f = fixture();
  assert.equal(f.decide({inFlight:true}).due, false);
  assert.ok(f.decide({inFlight:true}).nextInMs >= 1000);
  f.schedule.started(); f.advance(300); f.schedule.started();
  f.advance(200); f.schedule.completed({status:'recognized'});
  f.advance(499); assert.equal(f.decide().due, false);
  f.advance(1);
  assert.equal(f.decide().due, true, 'the duplicate start must not move the 1000ms target');
});

test('engine failures back off at 5, 10, 20 and 30 seconds without an infinite lockout', () => {
  const f = fixture(); f.observe();
  for (const [index, delay] of [5000, 10000, 20000, 30000, 30000].entries()) {
    f.schedule.started(); f.advance(1000);
    f.schedule.completed({status:'unavailable', code:index % 2 ? 'scan-execution-failed' : 'ocr-engine-unavailable'});
    const decision = f.decide();
    assert.equal(decision.mode, 'backoff');
    assert.equal(decision.nextInMs, delay);
    f.advance(delay - 1); assert.equal(f.decide().due, false);
    f.advance(1); assert.equal(f.decide().due, true);
  }
});

test('foreground loss stays short and does not poison a later engine failure streak', () => {
  const f = fixture(); f.observe();
  for (let n = 0; n < 10; n++) {
    f.schedule.started(); f.advance(1000);
    f.schedule.completed({status:'waiting', code:n % 2 ? 'foreground-changed' : 'game-not-foreground'});
    assert.equal(f.decide({hasOffers:true}).nextInMs, 5000);
    f.advance(5000);
  }
  f.schedule.started(); f.advance(1000);
  f.schedule.completed({status:'unavailable', code:'ocr-engine-unavailable'});
  assert.equal(f.decide({hasOffers:true}).nextInMs, 5000);
});

test('OCR execution failure and timeout are recoverable and successful capture clears the failure streak', () => {
  const f = fixture(); f.observe();
  f.schedule.started(); f.advance(15000); f.schedule.completed({status:'unavailable', code:'scan-execution-failed'});
  assert.equal(f.decide().nextInMs, 5000);
  f.advance(5000); f.schedule.started(); f.advance(1000); f.schedule.completed({status:'recognized', code:'title-layout-confirmed'});
  assert.notEqual(f.decide().mode, 'backoff');
  f.advance(5000); f.schedule.started(); f.advance(1000); f.schedule.completed({status:'unavailable', code:'ocr-engine-unavailable'});
  assert.equal(f.decide().nextInMs, 5000, 'a fresh failure starts at the initial backoff');
});

test('expected no-title battle results do not count as engine failures', () => {
  for (const code of ['ocr-no-text', 'title-name-unmatched', 'title-layout-incomplete', 'title-layout-ambiguous', 'scan-offer-consumed']) {
    const f = fixture(); f.observe();
    f.schedule.started(); f.advance(3000); f.schedule.completed({status:'unavailable', code});
    assert.equal(f.decide().mode, 'boost');
    assert.equal(f.decide().nextInMs, 250);
  }
});

test('threshold boosts and candidate offers do not silently bypass failure backoff', () => {
  const f = fixture(); f.observe();
  f.schedule.started(); f.advance(1000); f.schedule.completed({status:'unavailable', code:'ocr-language-missing'});
  f.update({level:7});
  assert.equal(f.decide({hasOffers:true, armed:true}).mode, 'backoff');
  assert.equal(f.decide({hasOffers:true, armed:true}).nextInMs, 5000);
});

test('new game epoch clears thresholds, deadlines and old completion cannot poison the new game', () => {
  const f = fixture(); f.update({level:7}); f.observe();
  f.schedule.started(); f.advance(9000);
  f.epoch(2); f.update({level:3});
  assert.equal(f.decide().due, false, 'the old resource remains in flight until completion');
  f.schedule.completed({status:'unavailable', code:'scan-execution-failed'});
  const decision = f.decide();
  assert.equal(decision.due, true);
  assert.equal(decision.triggerLevel, 3);
  assert.equal(decision.boostRemainingMs, 60000);
  assert.equal(decision.mode, 'boost');
});

test('lobby and transient ineligible states do not renew already-used thresholds within the epoch', () => {
  const f = fixture(); f.update({level:7}); f.observe(); f.schedule.confirmed();
  f.update({phase:'None'}); f.observe(); f.advance(1000);
  f.update({phase:'InProgress'});
  assert.equal(f.decide().boostRemainingMs, 0);
  f.epoch(2);
  assert.equal(f.decide().triggerLevel, 7);
});

test('custom policy can add thresholds while rejecting unsafe or invalid values per field', () => {
  const f = fixture({levels:[5, 5, 9], approachingLevels:[4, 8], boostDurationMs:45000,
    intervals:{battle:12000, boost:1500, offersArmed:999999}, cooldowns:{boost:750, battle:6000},
    backoff:{initialMs:6000, maxMs:24000}});
  f.update({level:5});
  assert.equal(f.decide().triggerLevel, 5);
  assert.equal(f.decide().boostRemainingMs, 45000);
  assert.equal(f.decide().intervalMs, 1500);
  assert.equal(f.decide({hasOffers:true, armed:true}).intervalMs, 1000);
  assert.equal(f.schedule.policy.cooldowns.boost, 750, 'subsecond completion rest is valid');
  f.schedule.confirmed();
  assert.equal(f.decide().intervalMs, 12000);
  assert.deepEqual(f.schedule.policy.levels, [5, 9]);
  const invalid = fixture({levels:[-1, '7'], boostDurationMs:Infinity, openingBoostMs:-1, intervals:{battle:NaN}});
  invalid.update({level:3}); assert.equal(invalid.decide().triggerLevel, 3);
  assert.equal(invalid.decide().boostRemainingMs, 60000);
});

test('custom policies allow 100ms completion rest while rejecting subsecond start intervals', () => {
  const valid = fixture({intervals:{boost:1000}, cooldowns:{boost:100}});
  valid.update({level:7}); valid.observe();
  valid.schedule.started(); valid.advance(2000); valid.schedule.completed({status:'recognized'});
  assert.equal(valid.decide().intervalMs, 1000);
  assert.equal(valid.decide().nextInMs, 100);
  valid.advance(99); assert.equal(valid.decide().due, false);
  valid.advance(1); assert.equal(valid.decide().due, true);
  for (const cooldown of [99, 0, -1, NaN, Infinity, '100']) {
    const invalid = fixture({intervals:{boost:999}, cooldowns:{boost:cooldown}});
    assert.equal(invalid.schedule.policy.intervals.boost, 1000);
    assert.equal(invalid.schedule.policy.cooldowns.boost, 250);
  }
});

test('decision output is bounded, fixed-field, contains no snapshot identity and tolerates clock rollback', () => {
  let now = 100000;
  const schedule = new OcrScanSchedule({now:() => now});
  const live = {phase:'InProgress', stage:'live', level:7, connection:{status:'connected'}, observedAt:new Date(now).toISOString(),
    gameId:'private-game', summonerName:'private-player', mode:{known:true, isMayhem:true}};
  const first = schedule.decision({live, gameEpoch:1}); schedule.started();
  now -= 1000; schedule.completed({status:'unavailable', code:'private-error-path'});
  const decision = schedule.decision({live, gameEpoch:1});
  assert.equal(first.boostRemainingMs, 60000);
  assert.ok(OCR_SCHEDULE_MODES.includes(decision.mode));
  assert.deepEqual(Object.keys(decision).sort(), ['mode', 'due', 'intervalMs', 'nextInMs', 'boostRemainingMs', 'triggerLevel'].sort());
  for (const key of ['intervalMs', 'nextInMs']) assert.ok(Number.isSafeInteger(decision[key]) && decision[key] >= 0 && decision[key] <= 30000);
  assert.ok(decision.boostRemainingMs <= 120000);
  assert.doesNotMatch(JSON.stringify(schedule), /private-game|private-player|private-error-path/);
});

test('unknown mode status does not disable fallback and missing game epochs do not reset every poll', () => {
  let now = 100000;
  const schedule = new OcrScanSchedule({now:() => now});
  const live = {phase:'InProgress', level:7, connection:{status:'connected'}, observedAt:new Date(now).toISOString(), mode:{known:false}};
  assert.equal(schedule.decision({live}).due, true);
  now += 10000; live.observedAt = new Date(now).toISOString();
  assert.equal(schedule.decision({live}).boostRemainingMs, 50000);
});

test('deterministic five-second battle targets reduce short scans compared with the old fixed 2.5-second target', () => {
  function simulate(adaptive, durationMs = 900000) {
    const f = fixture(); let scanCount = 0, busyMs = 0, lastStart = -Infinity;
    f.observe(); f.schedule.confirmed();
    while (f.now < Date.parse('2026-10-25T06:00:00Z') + durationMs) {
      const due = adaptive ? f.decide().due : f.now - lastStart >= 2500;
      if (due) {
        scanCount++; lastStart = f.now; f.schedule.started();
        f.advance(1000); busyMs += 1000;
        f.schedule.completed({status:'unavailable', code:'title-layout-incomplete'});
      }
      f.advance(1000);
    }
    return {scanCount, busyMs};
  }
  const previous = simulate(false), current = simulate(true);
  assert.equal(previous.scanCount, 300);
  assert.equal(current.scanCount, 180);
  assert.ok(current.scanCount < previous.scanCount, JSON.stringify({previous, current}));
  assert.equal(current.busyMs, current.scanCount * 1000);
});

test('long battle scans never overlap or restart faster than the old one-second post-scan loop', () => {
  const f = fixture(); f.observe(); f.schedule.confirmed();
  for (let pass = 0; pass < 3; pass++) {
    const startedAt = f.now;
    f.schedule.started(); f.advance(10000);
    assert.equal(f.decide().due, false, 'a long task must remain the only active capture');
    f.schedule.completed({status:'unavailable', code:'title-layout-incomplete'});
    assert.equal(f.decide().nextInMs, 1000);
    f.advance(999); assert.equal(f.decide().due, false);
    f.advance(1); assert.equal(f.decide().due, true);
    assert.equal(f.now - startedAt, 11000);
  }
});

test('a level-window transition can shorten battle rest but retains its own minimum rest', () => {
  const f = fixture(); f.observe(); f.schedule.confirmed();
  f.schedule.started(); f.advance(10000); f.schedule.completed({status:'unavailable', code:'title-layout-incomplete'});
  assert.equal(f.decide().nextInMs, 1000);
  f.update({level:7});
  assert.equal(f.decide().mode, 'boost');
  assert.equal(f.decide().nextInMs, 250);
  f.advance(249); assert.equal(f.decide().due, false);
  f.advance(1); assert.equal(f.decide().due, true);
});

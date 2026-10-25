// Heavy title OCR begins after an opening or verified respawn event. It scans
// quickly for the first minute, then follows up more slowly until a choice is
// confirmed. The lightweight click/FX observer keeps its independent cadence.
export const OCR_SCHEDULE_MODES = Object.freeze([
  'disabled', 'inactive', 'loading', 'other-mode', 'unknown', 'dead', 'idle', 'window', 'follow-up', 'backoff',
]);

export const DEFAULT_OCR_SCHEDULE_POLICY = Object.freeze({
  windowMs:60000,
  intervalMs:500,
  followUpIntervalMs:5000,
  cooldownMs:100,
  snapshotFreshnessMs:10000,
  futureToleranceMs:1000,
  backoff:Object.freeze({initialMs:5000, maxMs:30000, foregroundMs:5000}),
});

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const bounded = (value, fallback, min, max) => integer(value, min, max) ? value : fallback;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validEpoch = value => integer(value, 0, Number.MAX_SAFE_INTEGER);
const normalEmptyCodes = new Set([
  'ocr-no-text', 'title-name-unmatched', 'title-layout-incomplete', 'title-layout-ambiguous',
  'scan-proposals-incomplete', 'scan-offer-owned', 'scan-offer-consumed', 'scan-context-changed',
]);
const failureCodes = new Set([
  'game-not-foreground', 'foreground-changed', 'ocr-language-missing', 'ocr-engine-unavailable',
  'window-bounds-unavailable', 'window-size-unsupported', 'ocr-passes-incomplete',
  'scan-platform-unsupported', 'scan-output-too-large', 'scan-output-invalid', 'scan-execution-failed',
  'scan-loop-failed', 'ocr-unavailable', 'capture-size-invalid', 'scan-capture-stale',
]);

function normalizePolicy(value) {
  const candidate = object(value) ? value : {}, defaults = DEFAULT_OCR_SCHEDULE_POLICY;
  const initialMs = bounded(candidate.backoff?.initialMs, defaults.backoff.initialMs, 1000, 30000);
  return Object.freeze({
    windowMs:bounded(candidate.windowMs, defaults.windowMs, 1000, 120000),
    // A target is start-to-start, not a promise that OCR finishes in 500ms.
    intervalMs:bounded(candidate.intervalMs, defaults.intervalMs, 500, 30000),
    followUpIntervalMs:bounded(candidate.followUpIntervalMs, defaults.followUpIntervalMs, 1000, 30000),
    cooldownMs:bounded(candidate.cooldownMs, defaults.cooldownMs, 100, 30000),
    snapshotFreshnessMs:bounded(candidate.snapshotFreshnessMs, defaults.snapshotFreshnessMs, 1000, 30000),
    futureToleranceMs:bounded(candidate.futureToleranceMs, defaults.futureToleranceMs, 0, 5000),
    backoff:Object.freeze({initialMs,
      maxMs:Math.max(initialMs, bounded(candidate.backoff?.maxMs, defaults.backoff.maxMs, 1000, 30000)),
      foregroundMs:bounded(candidate.backoff?.foregroundMs, defaults.backoff.foregroundMs, 1000, 10000)}),
  });
}

function inactiveMode(live) {
  if (live?.stage === 'loading') return 'loading';
  if (live?.phase !== 'InProgress' || live?.stage !== 'live') return 'inactive';
  if (live.mode?.known === true && live.mode.isMayhem !== true) return 'other-mode';
  return null;
}

/**
 * The collector supplies fresh local-player life evidence. Neither level,
 * existing candidates nor an unknown/alive baseline is a respawn event.
 * No snapshot, game ID or player identity is retained by this scheduler.
 * started/completed surround the one shared automatic or manual OCR task.
 */
export class OcrScanSchedule {
  constructor({now = () => Date.now(), policy} = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.policy = normalizePolicy(policy);
    this.clock = 0;
    this.epoch = null;
    // Capture/evidence ownership is narrower than a game and independent of
    // the fast/follow-up pacing window. Death revokes it before respawn exists.
    this.lifecycle = 0;
    this.lifecycleStartedAt = 0;
    this.windowSequence = 0;
    this.activeScan = false;
    this.activeEpoch = null;
    this.activeLifecycle = null;
    this.resetTiming();
  }

  time() {
    const value = this.now();
    if (finite(value) && value >= 0) this.clock = Math.max(this.clock, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
    return this.clock;
  }

  resetTiming() {
    this.lastObservedAt = null;
    this.loadingObserved = false;
    this.enteredLive = false;
    this.highestGameTime = null;
    this.lastLife = null;
    this.otherModeObserved = false;
    this.windowUntil = 0;
    this.awaitingConfirmation = false;
    this.windowId = null;
    this.trigger = null;
    this.resetPacing();
  }

  resetPacing() {
    this.lastStartedAt = null;
    this.lastCompletedAt = null;
    this.failureStreak = 0;
    this.foregroundBackoff = false;
    this.backoffUntil = 0;
  }

  snapshotTime(live, now) {
    if (typeof live?.observedAt !== 'string') return null;
    const observed = Date.parse(live.observedAt);
    return Number.isFinite(observed) && observed <= now + this.policy.futureToleranceMs
      && now - observed <= this.policy.snapshotFreshnessMs ? observed : null;
  }

  lifeEvidence(live, snapshotAt, now) {
    const life = live?.life;
    if (life?.status !== 'detected' || typeof life.isDead !== 'boolean') return null;
    // Screen proofs may be newer than the collector and must retain their own
    // capture time. A raw collector keepalive cannot refresh an old proof.
    const observed = Object.hasOwn(life, 'observedAt')
      ? typeof life.observedAt === 'string' ? Date.parse(life.observedAt) : life.observedAt
      : snapshotAt;
    return finite(observed) && observed >= 0 && observed <= now + this.policy.futureToleranceMs
      && now - observed <= this.policy.snapshotFreshnessMs ? {isDead:life.isDead, observedAt:observed} : null;
  }

  beginWindow(trigger, until) {
    this.advanceLifecycle();
    this.windowSequence = this.windowSequence < Number.MAX_SAFE_INTEGER ? this.windowSequence + 1 : 1;
    this.windowId = this.windowSequence;
    this.trigger = trigger;
    this.windowUntil = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(until)));
    this.awaitingConfirmation = true;
    this.resetPacing();
  }

  advanceLifecycle() {
    this.lifecycle = this.lifecycle < Number.MAX_SAFE_INTEGER ? this.lifecycle + 1 : 1;
    this.lifecycleStartedAt = this.time();
  }

  observe({live, gameEpoch} = {}) {
    const now = this.time();
    if (validEpoch(gameEpoch) && gameEpoch !== this.epoch) {
      // Epochs are monotonically issued by the owning session. A late update
      // from a previous game must not reset the current window or life edge.
      if (this.epoch !== null && gameEpoch < this.epoch) return;
      this.epoch = gameEpoch;
      this.advanceLifecycle();
      this.resetTiming();
      // An old capture stays busy until completed(), but cannot poison this
      // epoch's pacing or retry state when its result finally returns.
    }
    const observed = this.snapshotTime(live, now);
    if (observed === null || this.lastObservedAt !== null && observed < this.lastObservedAt) return;
    const newSnapshot = this.lastObservedAt === null || observed > this.lastObservedAt;
    if (live?.mode?.known === true && live.mode.isMayhem !== true) {
      if (!this.otherModeObserved) {
        this.advanceLifecycle();
        this.windowUntil = 0;
        this.awaitingConfirmation = false;
        this.lastLife = null;
        this.resetPacing();
      }
      this.otherModeObserved = true;
      this.lastObservedAt = observed;
      return;
    }
    this.otherModeObserved = false;
    if (live?.stage === 'loading') {
      if (newSnapshot) {
        this.lastObservedAt = observed;
        if (!this.enteredLive) this.loadingObserved = true;
      }
      return;
    }
    if (inactiveMode(live) || live?.connection?.status !== 'connected') return;
    const gameTime = finite(live.gameTime) && live.gameTime >= 0 ? live.gameTime : null;
    if (gameTime !== null && this.highestGameTime !== null && gameTime < this.highestGameTime) return;
    this.lastObservedAt = observed;
    if (gameTime !== null) this.highestGameTime = Math.max(this.highestGameTime ?? 0, gameTime);
    if (!this.enteredLive && newSnapshot && (this.loadingObserved || gameTime !== null)) {
      // A partial first live response may have no clock yet. Do not consume
      // the opening edge until loading or a usable clock identifies it. A
      // valid late clock seals mid-game attachment without inventing a start.
      this.enteredLive = true;
      const opening = this.loadingObserved || gameTime * 1000 < this.policy.windowMs;
      // Give a witnessed opening its full minute from the usable live sample,
      // rather than spending that minute while the client/API was loading.
      if (opening) this.beginWindow('game-start', Math.min(now, observed) + this.policy.windowMs);
    }
    const life = this.lifeEvidence(live, observed, now);
    if (life === null || this.lastLife && life.observedAt <= this.lastLife.observedAt) return;
    const previous = this.lastLife;
    this.lastLife = life;
    if (life.isDead) {
      // Death ends the prior choice window. The following verified alive edge
      // receives a fresh ID/deadline, so late pre-death OCR cannot be applied.
      this.windowUntil = 0;
      this.awaitingConfirmation = false;
      if (previous?.isDead !== true) this.advanceLifecycle();
      return;
    }
    if (previous?.isDead === true && life.observedAt - previous.observedAt <= this.policy.snapshotFreshnessMs) {
      this.beginWindow('respawn', Math.min(now, life.observedAt) + this.policy.windowMs);
    }
  }

  decision({live, gameEpoch, enabled = true, hasOffers = false, armed = false, inFlight = false} = {}) {
    // Keep arguments stable for callers; offers/armed deliberately cannot open
    // or renew a cycle after a confirmed selection.
    void hasOffers; void armed;
    this.observe({live, gameEpoch});
    const now = this.time();
    const windowRemainingMs = Math.max(0, Math.min(this.policy.windowMs, this.windowUntil - now));
    const result = (mode, extra = {}) => ({mode, due:false, intervalMs:0, nextInMs:0,
      windowRemainingMs, trigger:this.trigger, windowId:this.windowId, ...extra});
    const paused = !enabled ? 'disabled' : inactiveMode(live);
    if (paused) return result(paused);
    const observed = this.snapshotTime(live, now);
    if (validEpoch(gameEpoch) && gameEpoch !== this.epoch || live?.connection?.status !== 'connected'
      || observed === null || this.lastObservedAt !== observed) return result('unknown');
    if (this.lastLife?.isDead === true) return result('dead');
    if (!this.awaitingConfirmation) return result('idle');
    const fast = windowRemainingMs > 0;
    let mode = fast ? 'window' : 'follow-up';
    let intervalMs = fast ? this.policy.intervalMs : this.policy.followUpIntervalMs;
    let dueAt = Math.max(this.lastStartedAt === null ? now : this.lastStartedAt + intervalMs,
      this.lastCompletedAt === null ? now : this.lastCompletedAt + this.policy.cooldownMs);
    if (this.backoffUntil > now) {
      mode = 'backoff';
      intervalMs = Math.max(intervalMs, this.backoffDelay());
      dueAt = Math.max(dueAt, this.backoffUntil);
    }
    const busy = inFlight || this.activeScan;
    const nextInMs = Math.min(fast ? windowRemainingMs : 30000, 30000,
      Math.max(busy ? this.policy.cooldownMs : 0, Math.ceil(dueAt - now)));
    return result(mode, {due:!busy && dueAt <= now && (!fast || dueAt < this.windowUntil), intervalMs, nextInMs});
  }

  started() {
    if (this.activeScan) return;
    this.activeScan = true;
    this.activeEpoch = this.epoch;
    this.activeLifecycle = this.lifecycle;
    this.lastStartedAt = this.time();
  }

  backoffDelay() {
    if (this.foregroundBackoff) return this.policy.backoff.foregroundMs;
    return Math.min(this.policy.backoff.maxMs, this.policy.backoff.initialMs * 2 ** Math.max(0, this.failureStreak - 1));
  }

  completed({status, code} = {}) {
    const now = this.time();
    const current = this.activeScan && this.activeEpoch === this.epoch && this.activeLifecycle === this.lifecycle;
    this.activeScan = false;
    this.activeEpoch = null;
    this.activeLifecycle = null;
    if (!current || !this.awaitingConfirmation) return;
    this.lastCompletedAt = now;
    // Empty battle frames and a busy response are expected, not engine faults.
    const failure = code !== 'scan-busy' && !normalEmptyCodes.has(code)
      && (failureCodes.has(code) || typeof code === 'string' && /^ocr-[a-z-]+-failed$/.test(code)
        || status === 'unavailable' && code !== 'title-layout-confirmed');
    if (failure) {
      this.foregroundBackoff = code === 'game-not-foreground' || code === 'foreground-changed';
      this.failureStreak = this.foregroundBackoff ? 0 : Math.min(16, this.failureStreak + 1);
      this.backoffUntil = now + this.backoffDelay();
    } else {
      this.failureStreak = 0;
      this.foregroundBackoff = false;
      this.backoffUntil = 0;
    }
  }

  confirmed() {
    this.windowUntil = 0;
    this.awaitingConfirmation = false;
  }

  forgetLife() {
    // Loss of a screen proof breaks continuity; it is not an alive event and
    // cannot open/renew a window or rewrite pacing.
    this.lastLife = null;
  }
}

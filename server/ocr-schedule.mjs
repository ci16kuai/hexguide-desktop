// Heavy title OCR is independent from the native, lightweight click/FX watcher.
// This policy stores only bounded timing/level state, never game or player IDs.
export const OCR_SCHEDULE_MODES = Object.freeze([
  'disabled', 'inactive', 'loading', 'other-mode', 'offers-armed',
  'offers-acquiring', 'boost', 'approaching', 'unknown', 'battle', 'backoff',
]);

export const DEFAULT_OCR_SCHEDULE_POLICY = Object.freeze({
  levels:Object.freeze([3, 7, 11, 15]),
  approachingLevels:Object.freeze([6, 10, 14]),
  levelFreshnessMs:10000,
  futureToleranceMs:1000,
  boostDurationMs:60000,
  openingBoostMs:30000,
  // Backend armed is not native Ready. Keep discovery speed until native has
  // gathered its post-fence witnesses; reducing this would slow first arming.
  intervals:Object.freeze({battle:10000, unknown:5000, approaching:3000, boost:2500, offersAcquiring:2500, offersArmed:2500}),
  cooldowns:Object.freeze({battle:5000, unknown:2500, approaching:1000, boost:1000, offersAcquiring:1000, offersArmed:1000}),
  backoff:Object.freeze({initialMs:5000, maxMs:30000, foregroundMs:5000}),
});

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const bounded = (value, fallback, min, max) => integer(value, min, max) ? value : fallback;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validEpoch = value => integer(value, 0, Number.MAX_SAFE_INTEGER);
const levels = (value, fallback) => Array.isArray(value) && value.length > 0 && value.length <= 30
  && value.every(level => integer(level, 1, 30))
  ? Object.freeze([...new Set(value)].sort((a, b) => a - b)) : fallback;
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
  const normalizeTimes = (supplied, original, minimum) => Object.freeze(Object.fromEntries(Object.entries(original)
    .map(([key, fallback]) => [key, bounded(supplied?.[key], fallback, minimum, key === 'offersArmed' ? 10000 : 30000)])));
  const initialMs = bounded(candidate.backoff?.initialMs, defaults.backoff.initialMs, 1000, 30000);
  return Object.freeze({
    levels:levels(candidate.levels, defaults.levels),
    approachingLevels:levels(candidate.approachingLevels, defaults.approachingLevels),
    levelFreshnessMs:bounded(candidate.levelFreshnessMs, defaults.levelFreshnessMs, 1000, 30000),
    futureToleranceMs:bounded(candidate.futureToleranceMs, defaults.futureToleranceMs, 0, 5000),
    boostDurationMs:bounded(candidate.boostDurationMs, defaults.boostDurationMs, 1000, 120000),
    openingBoostMs:bounded(candidate.openingBoostMs, defaults.openingBoostMs, 1000, 120000),
    intervals:normalizeTimes(candidate.intervals, defaults.intervals, 1000),
    cooldowns:normalizeTimes(candidate.cooldowns, defaults.cooldowns, 1000),
    backoff:Object.freeze({initialMs, maxMs:Math.max(initialMs, bounded(candidate.backoff?.maxMs, defaults.backoff.maxMs, 1000, 30000)),
      foregroundMs:bounded(candidate.backoff?.foregroundMs, defaults.backoff.foregroundMs, 1000, 10000)}),
  });
}

function inactiveMode(live) {
  if (live?.stage === 'loading') return 'loading';
  if (live?.phase !== 'InProgress') return 'inactive';
  if (live.mode?.known === true && live.mode.isMayhem !== true) return 'other-mode';
  return null;
}

/**
 * Scheduling only: it never confirms a choice or extends a selection lease.
 * Call observe for new collector snapshots; decision also observes, so callers
 * cannot accidentally omit a level transition. Repeated observations are inert.
 * Call started/completed around the one shared automatic or manual OCR task.
 */
export class OcrScanSchedule {
  constructor({now = () => Date.now(), policy} = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.policy = normalizePolicy(policy);
    this.clock = 0;
    this.epoch = null;
    this.activeScan = false;
    this.activeEpoch = null;
    this.resetTiming();
  }

  time() {
    const value = this.now();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) this.clock = Math.max(this.clock, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
    return this.clock;
  }

  resetTiming() {
    this.enteredLive = false;
    this.highestLevel = null;
    this.seenLevels = new Set();
    this.boostUntil = 0;
    this.triggerLevel = null;
    this.lastStartedAt = null;
    this.lastCompletedAt = null;
    this.failureStreak = 0;
    this.foregroundBackoff = false;
    this.backoffUntil = 0;
  }

  trustedLevel(live, now) {
    if (live?.connection?.status !== 'connected' || !integer(live?.level, 1, 30)
      || typeof live.observedAt !== 'string') return null;
    const observed = Date.parse(live.observedAt);
    return Number.isFinite(observed) && observed <= now + this.policy.futureToleranceMs
      && now - observed <= this.policy.levelFreshnessMs ? live.level : null;
  }

  observe({live, gameEpoch} = {}) {
    const now = this.time();
    if (validEpoch(gameEpoch) && gameEpoch !== this.epoch) {
      this.epoch = gameEpoch;
      this.resetTiming();
      // An old capture can still be running. completed() will discard its
      // timing/result rather than applying it to the new epoch.
    }
    if (inactiveMode(live)) return;
    const level = this.trustedLevel(live, now);
    if (!this.enteredLive) {
      this.enteredLive = true;
      this.boostUntil = now + this.policy.openingBoostMs;
    }
    if (level === null) return;
    let crossed = null;
    for (const threshold of this.policy.levels) {
      if (level >= threshold && !this.seenLevels.has(threshold)) {
        this.seenLevels.add(threshold);
        crossed = threshold;
      }
    }
    this.highestLevel = Math.max(this.highestLevel ?? level, level);
    if (crossed !== null) {
      this.boostUntil = Math.max(this.boostUntil, now + this.policy.boostDurationMs);
      this.triggerLevel = crossed;
    }
  }

  decision({live, gameEpoch, enabled = true, hasOffers = false, armed = false, inFlight = false} = {}) {
    this.observe({live, gameEpoch});
    const now = this.time(), paused = !enabled ? 'disabled' : inactiveMode(live);
    if (paused) return {mode:paused, due:false, intervalMs:0, nextInMs:0, boostRemainingMs:0};
    const level = this.trustedLevel(live, now);
    const boostRemainingMs = level === null ? 0 : Math.max(0, Math.min(120000, this.boostUntil - now));
    let mode = hasOffers ? armed ? 'offers-armed' : 'offers-acquiring'
      : level === null ? 'unknown' : boostRemainingMs > 0 ? 'boost'
        : this.policy.approachingLevels.includes(level) ? 'approaching' : 'battle';
    const key = mode === 'offers-armed' ? 'offersArmed' : mode === 'offers-acquiring' ? 'offersAcquiring' : mode;
    let intervalMs = this.policy.intervals[key];
    const cooldownMs = this.policy.cooldowns[key];
    let dueAt = Math.max(this.lastStartedAt === null ? now : this.lastStartedAt + intervalMs,
      this.lastCompletedAt === null ? now : this.lastCompletedAt + cooldownMs);
    if (this.backoffUntil > now) {
      mode = 'backoff';
      intervalMs = Math.min(30000, Math.max(intervalMs, this.backoffDelay()));
      dueAt = Math.max(dueAt, this.backoffUntil);
    }
    const busy = inFlight || this.activeScan;
    const nextInMs = Math.min(30000, Math.max(busy ? 1000 : 0, Math.ceil(dueAt - now)));
    return {mode, due:!busy && dueAt <= now, intervalMs, nextInMs, boostRemainingMs,
      ...(boostRemainingMs > 0 && this.triggerLevel !== null ? {triggerLevel:this.triggerLevel} : {})};
  }

  started() {
    if (this.activeScan) return;
    this.activeScan = true;
    this.activeEpoch = this.epoch;
    this.lastStartedAt = this.time();
  }

  backoffDelay() {
    if (this.foregroundBackoff) return this.policy.backoff.foregroundMs;
    return Math.min(this.policy.backoff.maxMs, this.policy.backoff.initialMs * 2 ** Math.max(0, this.failureStreak - 1));
  }

  completed({status, code} = {}) {
    const now = this.time(), belongsToEpoch = !this.activeScan || this.activeEpoch === this.epoch;
    this.activeScan = false;
    this.activeEpoch = null;
    if (!belongsToEpoch) return;
    this.lastCompletedAt = now;
    // No-title battle frames are an expected result, not an engine failure.
    // A busy response belongs to another in-flight task and is not a fault.
    const failure = code !== 'scan-busy' && !normalEmptyCodes.has(code)
      && (failureCodes.has(code) || typeof code === 'string' && /^ocr-[a-z-]+-failed$/.test(code)
        || status === 'unavailable' && code !== 'title-layout-confirmed');
    if (failure) {
      // Being in another app is not a broken OCR engine. Keep this wait short
      // and separate so returning to the game does not inherit 30 seconds.
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
    this.boostUntil = 0;
    this.triggerLevel = null;
  }
}

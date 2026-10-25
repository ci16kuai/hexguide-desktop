/**
 * Boundary for the native helper's verified, text-free life-state proof.
 * Authentication and visual evidence collection belong to their own layers;
 * this class keeps only a short-lived, current-game boolean observation.
 */
export const SCREEN_LIFE_MAX_AGE = 3000;
export const LIVE_LIFE_MAX_AGE = 10000;
const FUTURE_TOLERANCE = 1000;
const PROOF_KEYS = ['provider','gameId','gameEpoch','observedAt','state','code','stableFrames','countdownSeconds'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const validGameId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) && !/^0+$/.test(value);
const exactKeys = value => record(value) && Object.keys(value).length === PROOF_KEYS.length
  && PROOF_KEYS.every(key => Object.prototype.hasOwnProperty.call(value,key));
const unavailable = () => ({status:'unavailable',isDead:null,source:'unavailable'});
const timestamp = value => typeof value === 'number' && integer(value,0) ? value
  : typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (observedAt, now, maxAge) => integer(observedAt,0) && integer(now,0)
  && now - observedAt <= maxAge && observedAt - now <= FUTURE_TOLERANCE;

export class ScreenLifeValidationError extends Error {
  constructor(code = 'invalid-proof') { super('Invalid screen life proof.'); this.code = code; }
}
export class ScreenLifeConflictError extends Error {
  constructor(code = 'context-changed') { super('Screen life context is no longer eligible.'); this.code = code; }
}

function validProof(value) {
  if (!exactKeys(value) || value.provider !== 'screen' || !validGameId(value.gameId)
    || !integer(value.gameEpoch,0) || !integer(value.observedAt,0)
    || !integer(value.stableFrames,0,10000)) return false;
  if (value.state === 'unknown') return value.code === 'unavailable' && value.countdownSeconds === null;
  if (value.stableFrames < 3) return false;
  if (value.state === 'dead') return value.code === 'verified-dead-countdown' && integer(value.countdownSeconds,1,180);
  if (value.state === 'alive') return value.code === 'verified-respawn' && value.countdownSeconds === null;
  return false;
}

function liveEligible(live, now) {
  return record(live) && live.phase === 'InProgress' && live.stage === 'live'
    && live.connection?.status === 'connected' && !(live.mode?.known === true && live.mode.isMayhem !== true)
    && fresh(timestamp(live.observedAt),now,LIVE_LIFE_MAX_AGE);
}

function eligible(live, context, now) {
  return liveEligible(live,now) && record(context) && validGameId(context.gameId) && integer(context.gameEpoch,0)
    && live.gameId === context.gameId;
}

function apiLife(live, now) {
  const observedAt = timestamp(live?.observedAt);
  return live?.life?.status === 'detected' && typeof live.life.isDead === 'boolean'
    && fresh(observedAt,now,LIVE_LIFE_MAX_AGE)
    ? {status:'detected',isDead:live.life.isDead,source:'live-client',observedAt} : null;
}

export class ScreenLifeSource {
  constructor({now = () => Date.now()} = {}) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.context = null;
    this.screen = null;
    this.lastVerifiedDeadAt = null;
    this.lastObservedAt = null;
  }

  sync(live, context, now) {
    if (!eligible(live,context,now)) { this.reset(); return false; }
    if (this.context?.gameId !== context.gameId || this.context?.gameEpoch !== context.gameEpoch) {
      this.reset();
      this.context = {gameId:context.gameId,gameEpoch:context.gameEpoch};
    }
    // Display/scheduling expire quickly, while a bounded dead baseline bridges
    // OCR cold starts. Explicit focus/window loss must arrive as unknown.
    if (this.screen && !fresh(this.screen.observedAt,now,SCREEN_LIFE_MAX_AGE)) this.screen = null;
    if (this.lastVerifiedDeadAt !== null && !fresh(this.lastVerifiedDeadAt,now,LIVE_LIFE_MAX_AGE)) this.lastVerifiedDeadAt = null;
    return true;
  }

  resolve(live, context) {
    const now = this.now();
    // The primary life flag is already bound to the exact local Live Client
    // player. A temporarily missing LCU game ID must not discard that fresh
    // flag or turn a dead player into an unknown opening-scan baseline.
    // Screen attestations still require the stricter game ID/epoch boundary.
    const authoritative = liveEligible(live,now) ? apiLife(live,now) : null;
    if (authoritative) {
      this.screen = null;
      this.lastVerifiedDeadAt = null;
      return authoritative;
    }
    if (!this.sync(live,context,now)) return unavailable();
    return this.screen ? {...this.screen} : unavailable();
  }

  accept(value, context, live) {
    if (!validProof(value)) throw new ScreenLifeValidationError();
    const now = this.now();
    if (!this.sync(live,context,now)) throw new ScreenLifeConflictError('context-ineligible');
    if (value.gameId !== context.gameId || value.gameEpoch !== context.gameEpoch) throw new ScreenLifeConflictError('context-changed');
    if (!fresh(value.observedAt,now,SCREEN_LIFE_MAX_AGE)) throw new ScreenLifeConflictError('observation-stale');
    if (this.lastObservedAt !== null && value.observedAt <= this.lastObservedAt) throw new ScreenLifeConflictError('observation-replayed');
    this.lastObservedAt = value.observedAt;
    const authoritative = apiLife(live,now);
    if (authoritative) {
      this.screen = null;
      this.lastVerifiedDeadAt = null;
      if (value.state !== 'unknown' && (value.state === 'dead') !== authoritative.isDead) throw new ScreenLifeConflictError('live-client-preferred');
      return authoritative;
    }
    if (value.state === 'unknown') {
      this.screen = null;
      this.lastVerifiedDeadAt = null;
      return unavailable();
    }
    if (value.state === 'alive' && this.lastVerifiedDeadAt === null) throw new ScreenLifeConflictError('missing-dead-baseline');
    if (value.state === 'dead') this.lastVerifiedDeadAt = value.observedAt;
    // A repeated alive proof may renew the short cache only within the bounded
    // dead -> alive chain. Unknown and API return revoke that chain immediately.
    this.screen = {status:'detected',isDead:value.state === 'dead',source:'screen',observedAt:value.observedAt};
    return {...this.screen};
  }
}

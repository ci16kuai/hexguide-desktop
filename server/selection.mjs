import {randomBytes} from 'node:crypto';

export const SELECTION_MAX_AGE = 30_000;
export const SELECTION_RESULT_WINDOW = 15_000;
export class SelectionValidationError extends Error {}
export class SelectionConflictError extends Error {}
export const createOfferToken = () => randomBytes(16).toString('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const validIds = ids => Array.isArray(ids) && ids.length === 3 && Array.from(ids).every(id => typeof id === 'string' && id.length > 0 && id.length <= 100) && new Set(ids).size === 3;
const sameIds = (left, right) => validIds(left) && validIds(right) && left.every((id, index) => id === right[index]);
const validGameId = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);
const validTime = value => integer(value, 0, Number.MAX_SAFE_INTEGER);
const validToken = token => typeof token === 'string' && /^[a-f0-9]{32}$/.test(token);
const transitionKeys = ['version','kind','click','titleIdentity','cardsTransitioned','baselineStartedAt','lastBaselineAt','pressedAt','firstTransitionAt','stableFrames','maxFrameGapMs'];
const transitionShape = value => exactKeys(value, transitionKeys) && value.version === 2
  && value.kind === 'verified-click-transition'
  && ['click','titleIdentity','cardsTransitioned'].every(key => typeof value[key] === 'boolean')
  && ['baselineStartedAt','lastBaselineAt','pressedAt','firstTransitionAt'].every(key => validTime(value[key]))
  && integer(value.stableFrames,0,1000) && integer(value.maxFrameGapMs,0,2500);

function sanitizeTitleAnchors(value, regions) {
  if (!exactKeys(value, ['version','algorithm','frameId','pass','cards']) || value.version !== 1
    || value.algorithm !== 'luma-sobel-16x8-v1' || typeof value.frameId !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(value.frameId)
    || !['card-titles-color','card-titles-contrast'].includes(value.pass)
    || !Array.isArray(value.cards) || value.cards.length !== 3) return null;
  const cards = [];
  for (let column = 0; column < 3; column++) {
    const card = value.cards[column], region = regions[column];
    if (!exactKeys(card, ['column','anchors']) || card.column !== column || !Array.isArray(card.anchors)
      || !integer(card.anchors.length, 1, 2)) return null;
    const anchors = [];
    for (const anchor of card.anchors) {
      if (!exactKeys(anchor, ['box','feature']) || !exactKeys(anchor.box, ['x','y','width','height'])) return null;
      const {x,y,width,height} = anchor.box;
      if (!integer(x,region.x,region.x+region.width) || !integer(y,region.y,region.y+region.height)
        || !integer(width,8,region.width) || !integer(height,8,region.height)
        || x+width>region.x+region.width || y+height>region.y+region.height
        || !Array.isArray(anchor.feature) || anchor.feature.length !== 128
        || Array.from(anchor.feature).some(value => !integer(value,0,64))) return null;
      const sum = anchor.feature.reduce((total,value)=>total+value,0);
      const variance = anchor.feature.reduce((total,value)=>total+value*value,0)/128-(sum/128)**2;
      if (sum<64 || sum>7000 || anchor.feature.filter(value=>value>0).length<8 || variance<8) return null;
      anchors.push({box:{x,y,width,height},feature:[...anchor.feature]});
    }
    cards.push({column,anchors});
  }
  const checked = {version:1,algorithm:value.algorithm,frameId:value.frameId,pass:value.pass,cards};
  return Buffer.byteLength(JSON.stringify(checked)) <= 8192 ? checked : null;
}

/** Copy only bounded geometric/visual data. No image, OCR text or player fields. */
export function sanitizeSelectionCapture(value, expected = {}) {
  if (!record(value) || !validTime(value.capturedAt)
    || !integer(value.width, 640, 8192) || !integer(value.height, 360, 8192)
    || expected.width !== undefined && value.width !== expected.width
    || expected.height !== undefined && value.height !== expected.height
    || !integer(value.originX, -32768, 32768) || !integer(value.originY, -32768, 32768)
    || typeof value.windowHandle !== 'string' || !/^(?:[1-9][0-9]{0,19}|0x[0-9a-fA-F]{1,16})$/.test(value.windowHandle) || /^0x0+$/i.test(value.windowHandle)
    || !Array.isArray(value.regions) || value.regions.length !== 3) return null;
  const regions = [];
  for (let column = 0; column < 3; column += 1) {
    const region = value.regions[column];
    if (!record(region) || region.column !== column
      || !integer(region.x, 0, value.width) || !integer(region.y, 0, value.height)
      || !integer(region.width, 1, value.width) || !integer(region.height, 1, value.height)
      || region.x + region.width > value.width || region.y + region.height > value.height
      || !Array.isArray(region.signature) || region.signature.length !== 192
      || Array.from(region.signature).some(number => !integer(number, 0, 255))) return null;
    if (regions.length && regions.at(-1).x + regions.at(-1).width > region.x) return null;
    regions.push({column, x:region.x, y:region.y, width:region.width, height:region.height, signature:[...region.signature]});
  }
  // The initial OCR capture legitimately has only geometric/RGB data. Once
  // anchors are attached they must survive this boundary, fully validated;
  // silently stripping them would reintroduce the whole-card identity gate.
  const identityAnchors = own(value,'identityAnchors') ? sanitizeTitleAnchors(value.identityAnchors,regions) : null;
  if (own(value,'identityAnchors') && !identityAnchors) return null;
  return {capturedAt:value.capturedAt, width:value.width, height:value.height,
    originX:value.originX, originY:value.originY, windowHandle:value.windowHandle, regions,
    ...(identityAnchors ? {identityAnchors} : {})};
}

const contextMatches = (observation, context) => observation.gameId === context.gameId
  && observation.gameEpoch === context.gameEpoch && observation.revision === context.revision;
const sameGeometry = (left, right) => ['width','height','originX','originY','windowHandle'].every(key => left[key] === right[key])
  && left.regions.every((region, column) => ['column','x','y','width','height'].every(key => region[key] === right.regions[column][key]));

const ownedSlotKeys = ['slotIndex','state','candidateIndices'];
const ownedSlotStates = ['empty','unmatched','candidate','ambiguous'];
const validOwnedSlots = slots => {
  if (!Array.isArray(slots) || !integer(slots.length, 1, 16)) return false;
  let previousIndex = -1;
  for (const slot of slots) {
    if (!exactKeys(slot, ownedSlotKeys) || !integer(slot.slotIndex, 0, 15) || slot.slotIndex <= previousIndex
      || !ownedSlotStates.includes(slot.state) || !Array.isArray(slot.candidateIndices)
      || Array.from(slot.candidateIndices).some(index => !integer(index, 0, 2))
      || new Set(slot.candidateIndices).size !== slot.candidateIndices.length) return false;
    const count = slot.candidateIndices.length;
    if (slot.state === 'candidate' ? count !== 1 : slot.state === 'ambiguous' ? count < 2 || count > 3 : count !== 0) return false;
    previousIndex = slot.slotIndex;
  }
  return true;
};
const validOwnedSnapshot = (value, result = false) => exactKeys(value, result
  ? ['capturedAt','baselinePreserved','slots'] : ['capturedAt','slots'])
  && validTime(value.capturedAt) && validOwnedSlots(value.slots)
  && (!result || typeof value.baselinePreserved === 'boolean');
const sameSlotTopology = (left, right) => left.length === right.length
  && left.every((slot, index) => slot.slotIndex === right[index].slotIndex);
const ownedResultShape = value => exactKeys(value, ['provider','offerToken','gameId','gameEpoch','revision','ids','selectedIndex','capturedAt','clickedAt','observedAt','evidence'])
  && value.provider === 'screen' && validToken(value.offerToken) && validGameId(value.gameId)
  && integer(value.gameEpoch, 0, Number.MAX_SAFE_INTEGER) && integer(value.revision, 0, Number.MAX_SAFE_INTEGER)
  && validIds(value.ids) && integer(value.selectedIndex, 0, 2) && validTime(value.capturedAt)
  && validTime(value.clickedAt) && validTime(value.observedAt)
  && exactKeys(value.evidence, ['version','kind','surface','cardsDismissedAt','baseline','frames'])
  && value.evidence.version === 1 && value.evidence.kind === 'owned-slot-delta'
  && ['hud','scoreboard'].includes(value.evidence.surface) && validTime(value.evidence.cardsDismissedAt)
  && validOwnedSnapshot(value.evidence.baseline) && Array.isArray(value.evidence.frames)
  && integer(value.evidence.frames.length, 3, 8)
  && Array.from(value.evidence.frames).every(frame => validOwnedSnapshot(frame, true));

/**
 * Provider-neutral, in-memory eligibility boundary. The first provider is the
 * experimental native screen watcher. It observes user clicks; this module does
 * not choose a card, send input, infer owned history, or accept Overwolf data.
 */
export class SelectionObserver {
  constructor({now = () => Date.now(), maxAge = SELECTION_MAX_AGE} = {}) {
    this.now = now;
    this.maxAge = Math.min(SELECTION_MAX_AGE, Math.max(1, maxAge));
    this.observation = null;
    this.captureTimes = [];
    this.anchorCaptureTimes = [];
    this.resultLease = null;
    this.resultCaptureTimes = [];
    this.resultAnchorCaptureTimes = [];
    this.fxContinuation = null;
    this.invalidatedAt = -Infinity;
    this.hardInvalidatedAt = -Infinity;
  }

  invalidate() {
    this.observation = null; this.captureTimes = [];
    this.anchorCaptureTimes = [];
    this.resultLease = null; this.resultCaptureTimes = [];
    this.resultAnchorCaptureTimes = [];
    this.fxContinuation = null;
    this.invalidatedAt = Math.max(this.invalidatedAt, this.now());
    this.hardInvalidatedAt = Math.max(this.hardInvalidatedAt, this.now());
  }

  pruneCaptures() {
    const now = this.now();
    this.captureTimes = this.captureTimes.filter(time => time > this.invalidatedAt && time <= now + 1000 && now - time <= this.maxAge).slice(-8);
    this.anchorCaptureTimes = this.anchorCaptureTimes.filter(time => this.captureTimes.includes(time));
  }

  arm({offerToken, ids, capture, ...context}) {
    const checked = sanitizeSelectionCapture(capture);
    if (!validToken(offerToken) || !validIds(ids) || !validGameId(context.gameId)
      || !integer(context.gameEpoch, 0, Number.MAX_SAFE_INTEGER)
      || !integer(context.revision, 0, Number.MAX_SAFE_INTEGER) || !checked
      || checked.capturedAt <= this.invalidatedAt
      || checked.capturedAt > this.now() + 1000 || this.now() - checked.capturedAt > this.maxAge) {
      this.invalidate();
      return;
    }
    const {capturedAt, ...geometry} = checked;
    const continuation = this.fxContinuation?.observation;
    if (continuation && (!contextMatches(continuation, context) || continuation.offerToken !== offerToken
      || !sameIds(continuation.ids, ids) || !sameGeometry(continuation.capture, geometry))) this.fxContinuation = null;
    const previous = this.observation;
    if (!previous || !contextMatches(previous, context) || previous.offerToken !== offerToken
      || !sameIds(previous.ids, ids) || !sameGeometry(previous.capture, geometry)) {
      this.captureTimes = []; this.anchorCaptureTimes = [];
    }
    // A fresh OCR result must not invalidate a click animation already being
    // observed against an earlier valid frame of this exact offer and geometry.
    this.captureTimes = [...new Set([...this.captureTimes, capturedAt])].sort((left, right) => left - right);
    if (checked.identityAnchors) this.anchorCaptureTimes = [...new Set([...this.anchorCaptureTimes,capturedAt])];
    this.pruneCaptures();
    this.observation = {status:'armed', provider:'screen', experimental:true, offerToken,
      gameId:context.gameId, gameEpoch:context.gameEpoch, revision:context.revision,
      ids:[...ids], capturedAt, capture:geometry};
    const lease = this.resultLease;
    if (!lease || !contextMatches(lease, context) || lease.offerToken !== offerToken
      || !sameIds(lease.ids, ids) || !sameGeometry(lease.capture, geometry)) {
      this.resultCaptureTimes = []; this.resultAnchorCaptureTimes = [];
    }
    this.resultCaptureTimes = [...new Set([...this.resultCaptureTimes, capturedAt])]
      .filter(time => time <= this.now() + 1000 && this.now() - time <= this.maxAge)
      .sort((left, right) => left - right).slice(-8);
    if (checked.identityAnchors) this.resultAnchorCaptureTimes = [...new Set([...this.resultAnchorCaptureTimes,capturedAt])];
    this.resultAnchorCaptureTimes = this.resultAnchorCaptureTimes.filter(time => this.resultCaptureTimes.includes(time));
    this.resultLease = {...this.observation, status:'leased', suspendedAt:null, expiresAt:capturedAt + this.maxAge};
  }

  get(context, eligible = true) {
    this.pruneCaptures();
    if (!eligible || this.resultLease && !contextMatches(this.resultLease, context)
      || this.observation && (!contextMatches(this.observation, context)
      || this.now() - this.observation.capturedAt > this.maxAge
      || this.observation.capturedAt > this.now() + 1000)) this.invalidate();
    return this.observation ? structuredClone(this.observation)
      : {status:'waiting', provider:'screen', experimental:true, offerToken:null,
        gameId:context.gameId, gameEpoch:context.gameEpoch, revision:context.revision,
        ids:[], capturedAt:null, capture:null};
  }

  /** Only a temporary unreadable/dismissed offer may retain this result lease. */
  suspendForResultCheck(context, eligible = true) {
    const lease = this.getResultLease(context, eligible);
    if (lease.status !== 'leased') return lease;
    this.observation = null;
    this.captureTimes = [];
    this.anchorCaptureTimes = [];
    this.invalidatedAt = Math.max(this.invalidatedAt, this.now());
    if (this.resultLease.suspendedAt === null) {
      this.resultLease.suspendedAt = this.now();
      this.resultLease.expiresAt = Math.min(this.resultLease.expiresAt, this.now() + SELECTION_RESULT_WINDOW);
    }
    // Freeze the already-issued capture history separately from any later
    // same-offer rearm. This can finish an earlier click, never start a new one.
    // Retention includes the existing receipt-age allowance; the observation
    // itself still must finish within 2.5 seconds of both click and suspension.
    if (!this.fxContinuation || this.now() > this.fxContinuation.expiresAt) {
      this.fxContinuation = {observation:structuredClone(this.resultLease), captureTimes:[...this.resultCaptureTimes],
        anchorCaptureTimes:[...this.resultAnchorCaptureTimes],
        expiresAt:Math.min(this.resultLease.expiresAt, this.resultLease.suspendedAt + 2500 + 5000)};
    }
    return this.getResultLease(context, eligible);
  }

  getResultLease(context, eligible = true) {
    const lease = this.resultLease;
    if (!eligible || lease && (!contextMatches(lease, context) || this.now() > lease.expiresAt
      || lease.capturedAt > this.now() + 1000 || this.now() - lease.capturedAt > this.maxAge)) this.invalidate();
    if (!this.resultLease) return {status:'waiting', provider:'screen', experimental:true, offerToken:null,
      gameId:context.gameId, gameEpoch:context.gameEpoch, revision:context.revision,
      ids:[], capturedAt:null, capture:null, suspendedAt:null, expiresAt:null};
    this.resultCaptureTimes = this.resultCaptureTimes
      .filter(time => time <= this.now() + 1000 && this.now() - time <= this.maxAge).slice(-8);
    this.resultAnchorCaptureTimes = this.resultAnchorCaptureTimes.filter(time => this.resultCaptureTimes.includes(time));
    return structuredClone(this.resultLease);
  }

  /**
   * Versioned post-choice evidence is deliberately separate from click/FX proof.
   * Classification and shape continuity are attestations from the authenticated
   * screen provider, not values inferred here from the number of filled slots.
   */
  consumeOwnedResult(value, context, eligible = true) {
    if (!ownedResultShape(value)) throw new SelectionValidationError('Invalid owned-slot observation.');
    const lease = this.getResultLease(context, eligible);
    if (lease.status !== 'leased' || !contextMatches(value, context)
      || value.offerToken !== lease.offerToken || !sameIds(value.ids, lease.ids)
      || !this.resultCaptureTimes.includes(value.capturedAt)) {
      throw new SelectionConflictError('The owned-slot observation is no longer current.');
    }
    const {baseline, frames, cardsDismissedAt} = value.evidence;
    const lastFrame = frames.at(-1);
    const now = this.now();
    let targetSlot = null;
    let valid = baseline.capturedAt >= value.capturedAt && baseline.capturedAt <= value.clickedAt
      && value.clickedAt <= cardsDismissedAt && value.observedAt - value.clickedAt <= SELECTION_RESULT_WINDOW
      && cardsDismissedAt <= frames[0].capturedAt && frames[0].capturedAt > baseline.capturedAt
      && lastFrame.capturedAt - frames[0].capturedAt >= 250
      && value.observedAt === lastFrame.capturedAt && value.observedAt <= now + 1000
      && now - value.observedAt <= 5000 && value.observedAt <= lease.expiresAt;
    let previousTime = null;
    for (const frame of frames) {
      if (!frame.baselinePreserved || !sameSlotTopology(baseline.slots, frame.slots)
        || previousTime !== null && frame.capturedAt - previousTime < 100) { valid = false; break; }
      previousTime = frame.capturedAt;
      let frameTarget = null;
      for (let index = 0; index < baseline.slots.length; index += 1) {
        const before = baseline.slots[index];
        const after = frame.slots[index];
        // Unmatched slots include skill upgrades and are never an owned count.
        // Existing non-empty imagery must be preserved by the provider, even if
        // a later match classification becomes more specific.
        if (before.state !== 'empty') {
          if (after.state === 'empty') valid = false;
          continue;
        }
        if (after.state === 'ambiguous') { valid = false; continue; }
        if (after.state !== 'candidate') continue;
        if (after.candidateIndices[0] !== value.selectedIndex || frameTarget !== null) valid = false;
        frameTarget = after.slotIndex;
      }
      if (frameTarget === null || targetSlot !== null && frameTarget !== targetSlot) valid = false;
      targetSlot = frameTarget;
    }
    // Inconclusive result frames retain only the original bounded lease: they
    // neither clear owned history nor extend eligibility for another offer.
    if (!valid) throw new SelectionConflictError('The owned-slot evidence is incomplete or expired.');
    this.invalidate();
    return {id:lease.ids[value.selectedIndex], provider:'screen', experimental:true,
      offerToken:lease.offerToken, observedAt:value.observedAt};
  }

  consume(value, context, eligible = true) {
    const keys = ['provider','offerToken','gameId','gameEpoch','revision','ids','selectedIndex','capturedAt','clickedAt','observedAt','evidence'];
    const evidenceKeys = ['click','uniqueFeedback','cardsDismissed','stableFrames','feedbackFrames'];
    const transition = transitionShape(value?.evidence);
    const fxShape = exactKeys(value?.evidence, evidenceKeys)
      && ['click','uniqueFeedback','cardsDismissed'].every(key => typeof value.evidence[key] === 'boolean')
      && integer(value.evidence.stableFrames,0,1000) && integer(value.evidence.feedbackFrames,0,1000);
    if (!exactKeys(value, keys) || value.provider !== 'screen' || !validToken(value.offerToken)
      || !validGameId(value.gameId) || !integer(value.gameEpoch, 0, Number.MAX_SAFE_INTEGER)
      || !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) || !validIds(value.ids)
      || !integer(value.selectedIndex, 0, 2) || !validTime(value.capturedAt)
      || !validTime(value.clickedAt) || !validTime(value.observedAt)
      || !transition && !fxShape) {
      throw new SelectionValidationError('Invalid selection observation.');
    }
    let observation = this.get(context, eligible);
    const matches = (candidate, times) => contextMatches(value, context)
      && value.offerToken === candidate.offerToken && sameIds(value.ids, candidate.ids) && times.includes(value.capturedAt);
    const active = observation.status === 'armed' && matches(observation, this.captureTimes);
    let suspendedAt = null;
    let anchorQualified = this.anchorCaptureTimes.includes(value.capturedAt);
    if (!active) {
      const continuation = this.fxContinuation;
      if (!continuation || this.now() > continuation.expiresAt
        || !contextMatches(continuation.observation, context)
        || !matches(continuation.observation, continuation.captureTimes)
        || this.now() - value.capturedAt > this.maxAge || value.capturedAt > this.now() + 1000) {
        throw new SelectionConflictError('The observed selection is no longer current.');
      }
      observation = continuation.observation;
      suspendedAt = observation.suspendedAt;
      anchorQualified = continuation.anchorCaptureTimes.includes(value.capturedAt);
    }
    if (observation.status !== 'armed' && observation.status !== 'leased') {
      throw new SelectionConflictError('The observed selection is no longer current.');
    }
    // Consume even insufficient evidence for this context: it must be captured
    // again, rather than allowing an uncertain animation to be retried as proof.
    this.invalidate();
    const proof = value.evidence;
    const complete = transition ? anchorQualified && proof.click && proof.titleIdentity && proof.cardsTransitioned
      && proof.baselineStartedAt >= value.capturedAt
      && proof.lastBaselineAt - proof.baselineStartedAt >= 40 && proof.lastBaselineAt - proof.baselineStartedAt <= 180
      && proof.pressedAt > proof.lastBaselineAt && proof.pressedAt - proof.lastBaselineAt <= 180
      && value.clickedAt > proof.pressedAt && value.clickedAt - proof.pressedAt <= 500
      && proof.firstTransitionAt >= value.clickedAt && proof.firstTransitionAt - value.clickedAt <= 500
      && value.observedAt - proof.firstTransitionAt >= 350
      && proof.stableFrames >= 5 && proof.maxFrameGapMs > 0 && proof.maxFrameGapMs <= 180
      && proof.maxFrameGapMs >= proof.lastBaselineAt - proof.baselineStartedAt
      && proof.maxFrameGapMs >= proof.pressedAt - proof.lastBaselineAt
      && value.observedAt - proof.firstTransitionAt <= (proof.stableFrames - 1) * proof.maxFrameGapMs
      && proof.stableFrames <= value.observedAt - proof.firstTransitionAt + 1
      : proof.click && proof.uniqueFeedback && proof.cardsDismissed && proof.stableFrames >= 3 && proof.feedbackFrames >= 1;
    if (!complete
      || value.clickedAt < value.capturedAt || value.observedAt < value.clickedAt
      || value.observedAt - value.clickedAt > 2500 || value.observedAt > this.now() + 1000
      || this.now() - value.observedAt > 5000
      || suspendedAt !== null && (value.clickedAt > suspendedAt || value.observedAt - suspendedAt > 2500)) {
      throw new SelectionConflictError('The screen evidence is incomplete or expired.');
    }
    return {id:observation.ids[value.selectedIndex], provider:'screen', experimental:true,
      offerToken:observation.offerToken, observedAt:value.observedAt};
  }
}

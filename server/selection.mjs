import {randomBytes} from 'node:crypto';

export const SELECTION_MAX_AGE = 30_000;
export class SelectionValidationError extends Error {}
export class SelectionConflictError extends Error {}
export const createOfferToken = () => randomBytes(16).toString('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const validIds = ids => Array.isArray(ids) && ids.length === 3 && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100) && new Set(ids).size === 3;
const sameIds = (left, right) => validIds(left) && validIds(right) && left.every((id, index) => id === right[index]);
const validGameId = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);
const validTime = value => integer(value, 0, Number.MAX_SAFE_INTEGER);
const validToken = token => typeof token === 'string' && /^[a-f0-9]{32}$/.test(token);

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
  return {capturedAt:value.capturedAt, width:value.width, height:value.height,
    originX:value.originX, originY:value.originY, windowHandle:value.windowHandle, regions};
}

const contextMatches = (observation, context) => observation.gameId === context.gameId
  && observation.gameEpoch === context.gameEpoch && observation.revision === context.revision;
const sameGeometry = (left, right) => ['width','height','originX','originY','windowHandle'].every(key => left[key] === right[key])
  && left.regions.every((region, column) => ['column','x','y','width','height'].every(key => region[key] === right.regions[column][key]));

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
    this.invalidatedAt = -Infinity;
  }

  invalidate() { this.observation = null; this.captureTimes = []; this.invalidatedAt = Math.max(this.invalidatedAt, this.now()); }

  pruneCaptures() {
    const now = this.now();
    this.captureTimes = this.captureTimes.filter(time => time > this.invalidatedAt && time <= now + 1000 && now - time <= this.maxAge).slice(-8);
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
    const previous = this.observation;
    if (!previous || !contextMatches(previous, context) || previous.offerToken !== offerToken
      || !sameIds(previous.ids, ids) || !sameGeometry(previous.capture, geometry)) this.captureTimes = [];
    // A fresh OCR result must not invalidate a click animation already being
    // observed against an earlier valid frame of this exact offer and geometry.
    this.captureTimes = [...new Set([...this.captureTimes, capturedAt])].sort((left, right) => left - right);
    this.pruneCaptures();
    this.observation = {status:'armed', provider:'screen', experimental:true, offerToken,
      gameId:context.gameId, gameEpoch:context.gameEpoch, revision:context.revision,
      ids:[...ids], capturedAt, capture:geometry};
  }

  get(context, eligible = true) {
    this.pruneCaptures();
    if (this.observation && (!eligible || !contextMatches(this.observation, context)
      || this.now() - this.observation.capturedAt > this.maxAge
      || this.observation.capturedAt > this.now() + 1000)) this.invalidate();
    return this.observation ? structuredClone(this.observation)
      : {status:'waiting', provider:'screen', experimental:true, offerToken:null,
        gameId:context.gameId, gameEpoch:context.gameEpoch, revision:context.revision,
        ids:[], capturedAt:null, capture:null};
  }

  consume(value, context, eligible = true) {
    const keys = ['provider','offerToken','gameId','gameEpoch','revision','ids','selectedIndex','capturedAt','clickedAt','observedAt','evidence'];
    const evidenceKeys = ['click','uniqueFeedback','cardsDismissed','stableFrames','feedbackFrames'];
    if (!exactKeys(value, keys) || value.provider !== 'screen' || !validToken(value.offerToken)
      || !validGameId(value.gameId) || !integer(value.gameEpoch, 0, Number.MAX_SAFE_INTEGER)
      || !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) || !validIds(value.ids)
      || !integer(value.selectedIndex, 0, 2) || !validTime(value.capturedAt)
      || !validTime(value.clickedAt) || !validTime(value.observedAt)
      || !exactKeys(value.evidence, evidenceKeys)
      || ['click','uniqueFeedback','cardsDismissed'].some(key => typeof value.evidence[key] !== 'boolean')
      || !integer(value.evidence.stableFrames, 0, 1000)
      || !integer(value.evidence.feedbackFrames, 0, 1000)) {
      throw new SelectionValidationError('Invalid selection observation.');
    }
    const observation = this.get(context, eligible);
    if (observation.status !== 'armed' || !contextMatches(value, context)
      || value.offerToken !== observation.offerToken || !sameIds(value.ids, observation.ids)
      || !this.captureTimes.includes(value.capturedAt)) {
      throw new SelectionConflictError('The observed selection is no longer current.');
    }
    // Consume even insufficient evidence for this context: it must be captured
    // again, rather than allowing an uncertain animation to be retried as proof.
    this.invalidate();
    if (!value.evidence.click || !value.evidence.uniqueFeedback || !value.evidence.cardsDismissed
      || value.evidence.stableFrames < 3 || value.evidence.feedbackFrames < 1
      || value.clickedAt < value.capturedAt || value.observedAt < value.clickedAt
      || value.observedAt - value.clickedAt > 2500 || value.observedAt > this.now() + 1000
      || this.now() - value.observedAt > 5000) {
      throw new SelectionConflictError('The screen evidence is incomplete or expired.');
    }
    return {id:observation.ids[value.selectedIndex], provider:'screen', experimental:true,
      offerToken:observation.offerToken, observedAt:value.observedAt};
  }
}

/**
 * Resolve the player-opened six-slot HUD panel against this round's candidates.
 * The native provider owns capture/template thresholds. This boundary accepts
 * only bounded classifications; it never receives pixels, names or game input.
 * A shared glyph can suggest an augment, but cannot prove its actual identity.
 */
import {panelGlyphIdentity} from './panel-glyph-identity.mjs';

export const DEFAULT_PANEL_SELECTION_POLICY = Object.freeze({
  maxProofBytes:4096,
  maxOfferAgeMs:300000,
  maxCaptureAgeMs:5000,
  futureToleranceMs:1000,
  minimumFrameSpacingMs:100,
  minimumStableDurationMs:250,
  maximumFrameGapMs:2000,
  closeUsageFraction:0.10,
});

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => own(value,key));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const string = (value, max = 100) => typeof value === 'string' && value.length > 0 && value.length <= max;
const token = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const gameId = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const identifier = (value, max = 100) => string(value,max) && /^[A-Za-z0-9_./:-]+$/.test(value);
const validIds = ids => Array.isArray(ids) && ids.length === 3 && Array.from(ids).every(id => identifier(id)) && new Set(ids).size === 3;
const same = (left, right) => left.length === right.length && left.every((value,index) => value === right[index]);
const checkedInteger = (value, fallback, min, max) => integer(value,min,max) ? value : fallback;

function policyFor(input) {
  const value = record(input) ? input : {}, defaults = DEFAULT_PANEL_SELECTION_POLICY;
  return {
    maxProofBytes:checkedInteger(value.maxProofBytes,defaults.maxProofBytes,512,4096),
    maxOfferAgeMs:checkedInteger(value.maxOfferAgeMs,defaults.maxOfferAgeMs,1000,300000),
    maxCaptureAgeMs:checkedInteger(value.maxCaptureAgeMs,defaults.maxCaptureAgeMs,500,10000),
    futureToleranceMs:checkedInteger(value.futureToleranceMs,defaults.futureToleranceMs,0,1000),
    minimumFrameSpacingMs:checkedInteger(value.minimumFrameSpacingMs,defaults.minimumFrameSpacingMs,50,500),
    minimumStableDurationMs:checkedInteger(value.minimumStableDurationMs,defaults.minimumStableDurationMs,100,2000),
    maximumFrameGapMs:checkedInteger(value.maximumFrameGapMs,defaults.maximumFrameGapMs,500,2000),
    closeUsageFraction:typeof value.closeUsageFraction === 'number' && Number.isFinite(value.closeUsageFraction)
      && value.closeUsageFraction >= 0 && value.closeUsageFraction <= .25 ? value.closeUsageFraction : defaults.closeUsageFraction,
  };
}

function contextValid(context) {
  return record(context) && typeof context.eligible === 'boolean' && integer(context.now)
    && gameId(context.gameId) && integer(context.gameEpoch) && integer(context.revision)
    && token(context.offerToken) && validIds(context.ids) && string(context.championId)
    && integer(context.offeredAt) && Array.isArray(context.offers) && context.offers.length === 3
    && Array.from(context.offers).every((offer,index) => record(offer) && offer.id === context.ids[index]
      && identifier(offer.iconKey,400) && offer.kind === 'augment')
    && Array.isArray(context.owned) && context.owned.length <= 6
    && Array.from(context.owned).every(augment => record(augment) && identifier(augment.id) && identifier(augment.iconKey,400))
    && new Set(context.owned.map(augment => augment.id)).size === context.owned.length
    && !context.ids.some(id => context.owned.some(augment => augment.id === id));
}

const slotStates = new Set(['empty','excluded','unmatched','owned','candidate','ambiguous']);
function slotValid(slot, index) {
  if (!exact(slot,['slotIndex','state','candidateIndices']) || slot.slotIndex !== index
    || !slotStates.has(slot.state) || !Array.isArray(slot.candidateIndices)
    || Array.from(slot.candidateIndices).some(value => !integer(value,0,2))) return false;
  const indices = slot.candidateIndices;
  if (indices.some((value,position) => position && value <= indices[position-1])) return false;
  return slot.state === 'candidate' ? indices.length === 1
    : slot.state === 'ambiguous' ? indices.length >= 2 && indices.length <= 3 : indices.length === 0;
}

function frameValid(frame) {
  return exact(frame,['captureId','capturedAt','panelVisible','gameSurfaceVerified','selectionUiVisible','geometryKey','slots'])
    && identifier(frame.captureId,80) && integer(frame.capturedAt)
    && typeof frame.panelVisible === 'boolean' && typeof frame.gameSurfaceVerified === 'boolean'
    && typeof frame.selectionUiVisible === 'boolean' && identifier(frame.geometryKey,120)
    && Array.isArray(frame.slots) && frame.slots.length === 6 && Array.from(frame.slots).every(slotValid);
}

function proofValid(proof, policy) {
  if (!exact(proof,['version','provider','offerToken','gameId','gameEpoch','revision','ids','glyphs','frames'])
    || proof.version !== 2 || proof.provider !== 'panel-icon' || !token(proof.offerToken) || !gameId(proof.gameId)
    || !integer(proof.gameEpoch) || !integer(proof.revision) || !validIds(proof.ids)
    || !Array.isArray(proof.frames) || !integer(proof.frames.length,3,8)
    || !Array.from(proof.frames).every(frameValid)) return false;
  try { return Buffer.byteLength(JSON.stringify(proof)) <= policy.maxProofBytes; }
  catch { return false; }
}

const summary = (status, reason, context, details = {}) => ({
  status, reason, id:null, provider:'panel-icon', inferred:false,
  offerToken:token(context?.offerToken) ? context.offerToken : null,
  selectedIndex:null, observedAt:null,
  evidence:{kind:'panel-icon-match',surface:'hud-six-slot',frameCount:0,matchedSlots:[],candidateIndices:[],resolution:null},
  ...details,
});

function statisticFor(offer, context) {
  const statistic = offer.statistic;
  // Do not use all-champion popularity, another mode or an old patch to guess
  // this champion's choice. These values originate from the server repository.
  if (!record(statistic) || !string(context.patch,30) || statistic.championId !== context.championId || statistic.mode !== 'mayhem'
    || !integer(statistic.sampleCount,1,1000000000) || !string(statistic.patch,30)
    || !string(statistic.source,200) || statistic.patch !== context.patch) return null;
  return {sampleCount:statistic.sampleCount,winRate:rate(statistic.winRate) ? statistic.winRate : null};
}

/**
 * Success is either `matched` (one current candidate) or `inferred` (a proven
 * current-offer glyph collision resolved by this champion's observed usage).
 * `pending` never changes the session; malformed/stale/scoped-out evidence is
 * `rejected`. No before-panel baseline or user-click lease is required.
 */
export function validatePanelEvidence(proof, context, suppliedPolicy) {
  const policy = policyFor(suppliedPolicy);
  if (!contextValid(context)) return summary('rejected','panel-context-invalid',context);
  if (!context.eligible) return summary('rejected','panel-ineligible',context);
  if (!proofValid(proof,policy)) return summary('rejected','panel-evidence-invalid',context);
  if (proof.gameId !== context.gameId || proof.gameEpoch !== context.gameEpoch || proof.revision !== context.revision
    || proof.offerToken !== context.offerToken || !same(proof.ids,context.ids)) return summary('rejected','panel-context-mismatch',context);
  const glyphs = panelGlyphIdentity(proof.glyphs,context.offers,context.owned);
  if (!glyphs) return summary('rejected','panel-glyph-identity-invalid',context);
  if (context.offeredAt > context.now + policy.futureToleranceMs || context.now - context.offeredAt > policy.maxOfferAgeMs)
    return summary('rejected','panel-offer-expired',context);

  const frames = proof.frames;
  if (frames.some(frame => frame.capturedAt < context.offeredAt)) return summary('rejected','panel-capture-before-offer',context);
  if (frames.some(frame => context.now - frame.capturedAt > policy.maxCaptureAgeMs)) return summary('rejected','panel-capture-stale',context);
  if (frames.some(frame => frame.capturedAt > context.now + policy.futureToleranceMs)) return summary('rejected','panel-capture-future',context);
  if (new Set(frames.map(frame => frame.captureId)).size !== frames.length)
    return summary('rejected','panel-captures-not-independent',context);
  for (let index = 1; index < frames.length; index++) {
    const gap = frames[index].capturedAt - frames[index-1].capturedAt;
    if (gap < policy.minimumFrameSpacingMs || gap > policy.maximumFrameGapMs)
      return summary('rejected','panel-captures-not-independent',context);
  }
  if (frames.at(-1).capturedAt - frames[0].capturedAt < policy.minimumStableDurationMs)
    return summary('pending','panel-unstable',context);
  if (frames.some(frame => !frame.gameSurfaceVerified)) return summary('pending','panel-game-unverified',context);
  if (frames.some(frame => !frame.panelVisible)) return summary('pending','panel-not-visible',context);
  if (frames.some(frame => frame.selectionUiVisible)) return summary('pending','panel-selection-ui-visible',context);
  if (frames.some(frame => frame.geometryKey !== frames[0].geometryKey)) return summary('rejected','panel-geometry-changed',context);
  const firstSlots = JSON.stringify(frames[0].slots);
  if (frames.some(frame => JSON.stringify(frame.slots) !== firstSlots)) return summary('pending','panel-unstable',context);

  // Each classified glyph must represent its whole current-offer identity
  // group. An unknown/weak image that happens to score near two different
  // icons is uncertainty, not a statistics-resolvable collision.
  const groups = new Map();
  for (const slot of frames[0].slots) {
    if (!slot.candidateIndices.length) continue;
    const identity = glyphs.offers[slot.candidateIndices[0]];
    const expected = glyphs.offers.flatMap((glyph,index) => glyph === identity ? [index] : []);
    if (!same(slot.candidateIndices,expected)) return summary('pending','panel-collision-unverified',context);
    const group = groups.get(identity) || {indices:expected,slots:[]};
    group.slots.push(slot.slotIndex); groups.set(identity,group);
  }
  const ownedCount = identity => glyphs.owned.filter(glyph => glyph === identity).length;
  const newGroups = [...groups.entries()].filter(([identity,group]) => group.slots.length > ownedCount(identity));
  if (!newGroups.length) return summary('pending','panel-no-new-match',context);
  if (newGroups.length > 1 || newGroups[0][1].slots.length
    - ownedCount(newGroups[0][0]) > 1)
    return summary('pending','panel-multiple-new-groups',context);

  const [,group] = newGroups[0];
  const evidence = {kind:'panel-icon-match',surface:'hud-six-slot',frameCount:frames.length,
    matchedSlots:[...group.slots],candidateIndices:[...group.indices],resolution:'icon'};
  let selectedIndex = group.indices[0], inferred = false;
  if (group.indices.length > 1) {
    const candidates = group.indices.map(index => ({index,statistic:statisticFor(context.offers[index],context)}));
    if (candidates.some(candidate => !candidate.statistic)) return summary('pending','panel-statistics-unavailable',context);
    // Anchoring to the largest sample avoids a non-transitive pairwise "close"
    // comparator and makes the result independent of physical card ordering.
    const maximum = Math.max(...candidates.map(candidate => candidate.statistic.sampleCount));
    const close = candidates.filter(candidate => candidate.statistic.sampleCount >= maximum * (1-policy.closeUsageFraction));
    let winner = close[0];
    if (close.length > 1) {
      if (close.some(candidate => candidate.statistic.winRate === null)) return summary('pending','panel-statistics-unavailable',context);
      const highest = Math.max(...close.map(candidate => candidate.statistic.winRate));
      const leaders = close.filter(candidate => candidate.statistic.winRate === highest);
      if (leaders.length !== 1) return summary('pending','panel-statistics-tied',context);
      winner = leaders[0];
    }
    selectedIndex = winner.index; inferred = true; evidence.resolution = 'usage-then-win-rate';
  }
  return summary(inferred ? 'inferred' : 'matched',inferred ? 'panel-inferred' : 'panel-matched',context,{
    id:context.ids[selectedIndex],selectedIndex,inferred,observedAt:frames.at(-1).capturedAt,evidence,
  });
}

// Logical choice progress is independent of OCR death/respawn lifecycles.
// Riot documents the opening choice and later level 7/11/15 opportunities:
// https://www.leagueoflegends.com/en-au/news/dev/dev-bringing-mayhem-to-aram/
// Rechecked against the Mayhem support page updated 2026-10-21. This profile
// only groups observed candidates; it never creates or confirms a selection.
export const MAYHEM_OFFER_ROUND_POLICY = Object.freeze({
  rule:'aram-mayhem-standard-v1', milestones:Object.freeze([3,7,11,15]),
});

export function validOfferRound(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && value.rule === MAYHEM_OFFER_ROUND_POLICY.rule
    && Number.isSafeInteger(value.level) && value.level >= 3 && value.level <= 30
    && value.milestone === MAYHEM_OFFER_ROUND_POLICY.milestones.filter(level => level <= value.level).at(-1);
}

export function sameOfferRound(left, right) {
  return validOfferRound(left) && validOfferRound(right)
    && left.rule === right.rule && left.level === right.level;
}

export function observedOfferRound(live, {gameId, now} = {}) {
  const observedAt = typeof live?.observedAt === 'string' ? Date.parse(live.observedAt) : NaN;
  if (!gameId || live?.gameId !== gameId || live.phase !== 'InProgress' || live.stage !== 'live'
    || live.connection?.status !== 'connected' || live.mode?.known !== true || live.mode.isMayhem !== true
    || !Number.isFinite(now) || !Number.isFinite(observedAt) || now-observedAt > 10000 || observedAt-now > 1000
    || !Number.isSafeInteger(live.level) || live.level < 3 || live.level > 30) return null;
  return {rule:MAYHEM_OFFER_ROUND_POLICY.rule,level:live.level,
    milestone:MAYHEM_OFFER_ROUND_POLICY.milestones.filter(level => level <= live.level).at(-1)};
}

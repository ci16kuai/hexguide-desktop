import {createOfferToken} from './selection.mjs';
import {MAYHEM_OFFER_ROUND_POLICY, sameOfferRound, validOfferRound} from './offer-round.mjs';

const same = (left, right) => left.length === right.length && left.every((id,index) => id === right[index]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

/** Logical unanswered rounds outlive screen/click evidence. Catalog IDs,
 * ordering and verified progression context persist, never capture proof. */
export class PendingOffers {
  constructor({limit = 6} = {}) { this.limit = limit; this.clear(); }
  clear() { this.entries = []; this.nextSequence = 1; this.choiceSequences = Object.create(null); this.revision = (this.revision || 0)+1; }
  get latest() { return this.entries.at(-1) || null; }
  find(pendingId) { return this.entries.find(entry => entry.pendingId === pendingId) || null; }
  hasCompletePrefix(observed, owned) {
    if (!validOfferRound(observed) || !Array.isArray(owned) || this.entries.length > 1) return false;
    const required = MAYHEM_OFFER_ROUND_POLICY.milestones.indexOf(observed.milestone);
    const choices = Object.entries(this.choiceSequences);
    // When the exact level changed, a complete confirmed prefix can still
    // establish continuity inside one ordinary 3/7/11/15 progress interval.
    if (owned.length !== required || choices.length !== required || new Set(owned).size !== required
      || choices.some(([id]) => !owned.includes(id))
      || choices.map(([,sequence]) => sequence).sort((a,b) => a-b).some((sequence,index) => sequence !== index+1)
      || this.latest && (this.latest.sequence !== required+1 || this.nextSequence !== required+2)
      || !this.latest && this.nextSequence !== required+1) return false;
    return true;
  }
  accept(ids, {lifecycle, offerCycle, roundContext, owned = [], captureRevision, now, capture = null} = {}) {
    const hasOfferCycle = integer(offerCycle);
    const knownRound = validOfferRound(roundContext);
    const progressControlled = roundContext !== undefined;
    let entry = this.entries.find(value => same(value.ids,ids));
    if (!entry) {
      const latest = this.latest;
      // The user's normal-mode rule: two choice rounds cannot newly appear at
      // an unchanged level. Rerolls replace only the latest unconsumed group;
      // earlier pending groups do not affect that same-level continuity. A
      // confirmation is an explicit boundary even if an older group resurfaces.
      // OCR death/respawn/restart numbers are never persisted as logical proof.
      const reroll = Boolean(latest) && latest.sequence === this.nextSequence-1
        && (knownRound && validOfferRound(latest.roundContext)
        ? sameOfferRound(latest.roundContext,roundContext)
          || latest.roundContext.milestone === roundContext.milestone && this.hasCompletePrefix(roundContext,owned)
        : !progressControlled && (hasOfferCycle ? latest.lastSeenOfferCycle === offerCycle : latest.lastSeenLifecycle === lifecycle));
      if (!reroll && this.entries.length >= this.limit) return null;
      entry = {pendingId:createOfferToken(), sequence:reroll ? latest.sequence : this.nextSequence++,
        ids:[...ids], createdAt:now, originLifecycle:lifecycle, offerToken:createOfferToken(), capture:null,
        ...(knownRound ? {roundContext:{...roundContext}} : {})};
      if (reroll) this.entries.pop();
      this.entries.push(entry);
      this.revision++;
    }
    // Seeing the exact same three cards again proves continuity even when the
    // player delayed that choice across a level boundary. Persist this bridge
    // so the next reroll remains associated with those still-visible cards.
    if (knownRound && !sameOfferRound(entry.roundContext,roundContext)) {
      entry.roundContext = {...roundContext};
      this.revision++;
    }
    if (entry.runtimeLifecycle !== lifecycle || entry.runtimeCaptureRevision !== captureRevision) entry.offerToken = createOfferToken();
    entry.runtimeLifecycle = lifecycle;
    entry.runtimeCaptureRevision = captureRevision;
    entry.lastSeenLifecycle = lifecycle;
    if (hasOfferCycle) entry.lastSeenOfferCycle = offerCycle;
    else delete entry.lastSeenOfferCycle;
    if (capture) entry.capture = capture;
    return entry;
  }
  revokeClickScopes() {
    for (const entry of this.entries) { entry.offerToken = createOfferToken(); entry.runtimeLifecycle = null; }
  }
  resolve(id, pendingId, owned) {
    const entry = pendingId ? this.find(pendingId) : null;
    const sequence = entry?.sequence ?? this.nextSequence++;
    this.choiceSequences[id] = sequence;
    if (entry) this.entries = this.entries.filter(value => value !== entry);
    this.revision++;
    return [...owned,id].map((value,index) => ({id:value,index,sequence:this.choiceSequences[value] ?? 0}))
      .sort((left,right) => left.sequence-right.sequence || left.index-right.index).map(value => value.id);
  }
  save() {
    return {version:2,revision:this.revision,nextSequence:this.nextSequence,
      entries:this.entries.map(({pendingId,sequence,ids,createdAt,roundContext}) => ({pendingId,sequence,ids:[...ids],createdAt,
        ...(validOfferRound(roundContext) ? {roundContext:{...roundContext}} : {})})),
      choiceSequences:{...this.choiceSequences}};
  }
  restore(value, validId, owned) {
    if (!value || ![1,2].includes(value.version) || !integer(value.nextSequence) || value.nextSequence < 1
      || 'revision' in value && !integer(value.revision)
      || !Array.isArray(value.entries) || value.entries.length > this.limit || !value.choiceSequences
      || typeof value.choiceSequences !== 'object' || Array.isArray(value.choiceSequences)) return false;
    const entries = value.entries;
    if (entries.some(entry => !entry || !identifier(entry.pendingId) || !integer(entry.sequence) || entry.sequence < 1
      || !integer(entry.createdAt) || !Array.isArray(entry.ids) || entry.ids.length !== 3 || new Set(entry.ids).size !== 3
      || entry.ids.some(id => !validId(id))
      || value.version === 2 && 'roundContext' in entry && !validOfferRound(entry.roundContext))
      || new Set(entries.map(entry => entry.pendingId)).size !== entries.length
      || entries.some((entry,index) => index && entry.sequence <= entries[index-1].sequence)
      || entries.some(entry => entry.sequence >= value.nextSequence)) return false;
    const choices = Object.entries(value.choiceSequences);
    if (choices.length > 12 || choices.some(([id,sequence]) => !owned.includes(id) || !integer(sequence)
      || sequence >= value.nextSequence)) return false;
    this.entries = entries.map(entry => ({pendingId:entry.pendingId,sequence:entry.sequence,ids:[...entry.ids],
      createdAt:entry.createdAt,originLifecycle:null,offerToken:createOfferToken(),capture:null,
      ...(value.version === 2 && validOfferRound(entry.roundContext) ? {roundContext:{...entry.roundContext}} : {})}));
    this.nextSequence = value.nextSequence;
    this.choiceSequences = Object.fromEntries(choices);
    this.revision = Math.max(this.revision,value.revision ?? 0)+1;
    return true;
  }
}

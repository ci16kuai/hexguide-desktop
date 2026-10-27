import {createOfferToken} from './selection.mjs';

const same = (left, right) => left.length === right.length && left.every((id,index) => id === right[index]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

/** Logical unanswered rounds outlive screen/click evidence. Only catalog IDs
 * and ordering are persisted; runtime descriptors never cross a restart. */
export class PendingOffers {
  constructor({limit = 6} = {}) { this.limit = limit; this.clear(); }
  clear() { this.entries = []; this.nextSequence = 1; this.choiceSequences = Object.create(null); this.revision = (this.revision || 0)+1; }
  get latest() { return this.entries.at(-1) || null; }
  find(pendingId) { return this.entries.find(entry => entry.pendingId === pendingId) || null; }
  accept(ids, {lifecycle, offerCycle, captureRevision, now, capture = null} = {}) {
    const hasOfferCycle = integer(offerCycle);
    let entry = this.entries.find(value => same(value.ids,ids));
    if (!entry) {
      const latest = this.latest;
      // A reroll supersedes the same unanswered round, rather than creating
      // a phantom missed selection. Death and respawn can share that round
      // while keeping separate capture lifecycles. Legacy callers use life.
      const reroll = Boolean(latest) && (hasOfferCycle ? latest.lastSeenOfferCycle === offerCycle : latest.lastSeenLifecycle === lifecycle);
      if (!reroll && this.entries.length >= this.limit) return null;
      entry = {pendingId:createOfferToken(), sequence:reroll ? latest.sequence : this.nextSequence++,
        ids:[...ids], createdAt:now, originLifecycle:lifecycle, offerToken:createOfferToken(), capture:null};
      if (reroll) this.entries.pop();
      this.entries.push(entry);
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
    return {version:1,revision:this.revision,nextSequence:this.nextSequence,
      entries:this.entries.map(({pendingId,sequence,ids,createdAt}) => ({pendingId,sequence,ids:[...ids],createdAt})),
      choiceSequences:{...this.choiceSequences}};
  }
  restore(value, validId, owned) {
    if (!value || value.version !== 1 || !integer(value.nextSequence) || value.nextSequence < 1
      || 'revision' in value && !integer(value.revision)
      || !Array.isArray(value.entries) || value.entries.length > this.limit || !value.choiceSequences
      || typeof value.choiceSequences !== 'object' || Array.isArray(value.choiceSequences)) return false;
    const entries = value.entries;
    if (entries.some(entry => !entry || !identifier(entry.pendingId) || !integer(entry.sequence) || entry.sequence < 1
      || !integer(entry.createdAt) || !Array.isArray(entry.ids) || entry.ids.length !== 3 || new Set(entry.ids).size !== 3
      || entry.ids.some(id => !validId(id)))
      || new Set(entries.map(entry => entry.pendingId)).size !== entries.length
      || entries.some((entry,index) => index && entry.sequence <= entries[index-1].sequence)
      || entries.some(entry => entry.sequence >= value.nextSequence)) return false;
    const choices = Object.entries(value.choiceSequences);
    if (choices.length > 12 || choices.some(([id,sequence]) => !owned.includes(id) || !integer(sequence)
      || sequence >= value.nextSequence)) return false;
    this.entries = entries.map(entry => ({pendingId:entry.pendingId,sequence:entry.sequence,ids:[...entry.ids],
      createdAt:entry.createdAt,originLifecycle:null,offerToken:createOfferToken(),capture:null}));
    this.nextSequence = value.nextSequence;
    this.choiceSequences = Object.fromEntries(choices);
    this.revision = Math.max(this.revision,value.revision ?? 0)+1;
    return true;
  }
}

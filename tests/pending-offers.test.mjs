import test from 'node:test';
import assert from 'node:assert/strict';
import {PendingOffers} from '../server/pending-offers.mjs';

const add = (book,round,ids = [`a${round}`,`b${round}`,`c${round}`]) => book.accept(ids,
  {lifecycle:round,captureRevision:round,now:1000+round,capture:{capturedAt:1000+round,windowHandle:'runtime-only'}});

test('unanswered round collection has a hard six-round bound and never silently evicts an earlier answer', () => {
  const book = new PendingOffers();
  for (let round=1;round<=6;round++) assert.ok(add(book,round));
  const before = book.save(); assert.equal(add(book,7),null); assert.deepEqual(book.save(),before);
  const reroll = add(book,6,['reroll-a','reroll-b','reroll-c']);
  assert.equal(book.entries.length,6); assert.equal(reroll.sequence,6);
  assert.notEqual(reroll.pendingId,before.entries[5].pendingId);
});

test('repeated IDs across death retain one logical round, while its fresh direct-click token changes', () => {
  const book = new PendingOffers(), first = add(book,1), oldToken = first.offerToken;
  book.revokeClickScopes(); const again = add(book,3,['a1','b1','c1']);
  assert.equal(again.pendingId,first.pendingId); assert.equal(book.entries.length,1);
  assert.notEqual(again.offerToken,oldToken);
  const reroll = add(book,3,['new-a','new-b','new-c']);
  assert.equal(reroll.sequence,first.sequence); assert.equal(book.entries.length,1);
});

test('temporary capture revocation preserves logical reroll ownership in the same life', () => {
  const book = new PendingOffers(), first = add(book,1);
  book.revokeClickScopes(); const reroll = add(book,1,['new-a','new-b','new-c']);
  assert.equal(book.entries.length,1); assert.equal(reroll.sequence,first.sequence);
  assert.notEqual(reroll.pendingId,first.pendingId);
});

test('only safe catalog metadata restores; malformed, unbounded or duplicate groups are ignored', () => {
  const book = new PendingOffers(); add(book,1); const saved = book.save();
  assert.ok(!JSON.stringify(saved).includes('runtime-only'));
  const restored = new PendingOffers(); assert.equal(restored.restore(saved,() => true,[]),true);
  assert.equal(restored.latest.capture,null); assert.equal(restored.latest.originLifecycle,null);
  for (const mutate of [value => {value.entries.push(...Array(6).fill(value.entries[0]));},
    value => {value.entries[0].ids[1]=value.entries[0].ids[0];}, value => {value.entries[0].pendingId='bad';},
    value => {value.entries[0].sequence=value.nextSequence;}, value => {value.choiceSequences.unknown=1;}]) {
    const invalid = structuredClone(saved); mutate(invalid);
    assert.equal(new PendingOffers().restore(invalid,() => true,[]),false);
  }
});

test('logical death round survives respawn reroll before a repeated-card capture while preserving older pending chronology', () => {
  const book = new PendingOffers();
  const old = book.accept(['old-a','old-b','old-c'],{lifecycle:2,offerCycle:1,now:1000});
  const dead = book.accept(['dead-a','dead-b','dead-c'],{lifecycle:3,offerCycle:2,now:2000});
  const reroll = book.accept(['new-a','new-b','new-c'],{lifecycle:4,offerCycle:2,now:3000});
  assert.deepEqual(book.entries.map(entry => entry.sequence),[1,2]);
  assert.equal(book.latest,reroll); assert.equal(reroll.sequence,dead.sequence);
  assert.notEqual(reroll.pendingId,dead.pendingId); assert.equal(book.find(dead.pendingId),null);
  assert.equal(book.find(old.pendingId),old); assert.equal(reroll.lastSeenLifecycle,4);
  assert.equal(reroll.lastSeenOfferCycle,2);
  assert.deepEqual(book.resolve('new-b',reroll.pendingId,[]),['new-b']);
  assert.deepEqual(book.resolve('old-c',old.pendingId,['new-b']),['old-c','new-b']);
});

test('logical round changes can retain unanswered rounds even within one capture lifecycle', () => {
  const book = new PendingOffers();
  const first = book.accept(['a','b','c'],{lifecycle:4,offerCycle:1,now:1000});
  const second = book.accept(['d','e','f'],{lifecycle:4,offerCycle:2,now:2000});
  assert.equal(book.entries.length,2); assert.equal(first.sequence,1); assert.equal(second.sequence,2);
});

test('runtime logical cycles do not persist and repeated older cards never promote the older pending round', () => {
  const book = new PendingOffers();
  const older = book.accept(['a','b','c'],{lifecycle:1,offerCycle:1,now:1000});
  const latest = book.accept(['d','e','f'],{lifecycle:2,offerCycle:2,now:2000});
  const again = book.accept(['a','b','c'],{lifecycle:3,offerCycle:3,now:3000});
  assert.equal(again,older); assert.equal(book.latest,latest); assert.equal(book.entries.length,2);
  assert.equal(older.lastSeenOfferCycle,3); assert.equal(older.lastSeenLifecycle,3);
  const saved = book.save(); assert.doesNotMatch(JSON.stringify(saved),/offerCycle|lastSeen|runtime/i);
  const restored = new PendingOffers(); assert.equal(restored.restore(saved,() => true,[]),true);
  assert.equal(restored.latest.lastSeenOfferCycle,undefined);
});

test('saved logical progress validates its profile while legacy groups remain restorable without inferred progress', () => {
  const book = new PendingOffers();
  book.accept(['a','b','c'],{lifecycle:1,offerCycle:1,now:1000,
    roundContext:{rule:'aram-mayhem-standard-v1',milestone:3,level:3}});
  const saved = book.save();
  for (const invalid of [null,{}, {rule:'unknown-profile',milestone:3,level:3},
    {rule:'aram-mayhem-standard-v1',milestone:9,level:9}, {rule:'aram-mayhem-standard-v1',milestone:3,level:7},
    {rule:'aram-mayhem-standard-v1',milestone:3,level:3,frameId:'unsafe'}]) {
    const changed = structuredClone(saved); changed.entries[0].roundContext = invalid;
    assert.equal(new PendingOffers().restore(changed,() => true,[]),false);
  }
  const legacy = structuredClone(saved); legacy.version = 1; delete legacy.entries[0].roundContext;
  const restored = new PendingOffers(); assert.equal(restored.restore(legacy,() => true,[]),true);
  assert.equal(restored.latest.roundContext,undefined);
});

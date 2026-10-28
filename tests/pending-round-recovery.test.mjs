// Bounded synthetic transitions using the observed triplets/timing. No game,
// screen capture, network, credentials or installed assistant data are read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar, SessionConflictError} from '../server/sidebar.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
const first = ['recursion','shrink_engine','jeweled_gauntlet'];
const second = ['eureka','archmage','transmute_prismatic'];
const observed = ['big_shot','final_form','en_passant'];
const rerolled = ['goliath','final_form','king_me'];

async function fixture(t, {level = 3} = {}) {
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-28\\hexguide-pending-recovery';
  await mkdir(root,{recursive:true});
  const directory = await mkdtemp(path.join(root,'isolated-round-'));
  let now = Date.parse('2026-10-28T15:28:00Z'), ids = [...first], deferred = false, release = null;
  let live = {gameId:'bounded-round-replay',phase:'InProgress',stage:'live',connection:{status:'connected'},
    championId:'Ahri',level,gameTime:500,life:{status:'detected',isDead:false},mode:{known:true,isMayhem:true},
    items:[],stats:{},observedAt:new Date(now).toISOString()};
  const collector = {getSnapshot:() => structuredClone(live)};
  const scanner = async () => {
    const result = {status:'recognized',proposals:ids.map(id => ({id}))};
    if (deferred) {deferred = false;await new Promise(resolve => {release = resolve;});release = null;}
    return result;
  };
  const instances = [];
  const create = async () => {
    const sidebar = await new BackgroundSidebar({collector,scanner,data,itemsCatalog,dataDirectory:directory,now:() => now}).load();
    instances.push(sidebar); return sidebar;
  };
  const h = {directory,sidebar:await create(),
    advance(ms, change = {}) {now += ms;live = {...live,gameTime:live.gameTime+ms/1000,...change,observedAt:new Date(now).toISOString()};},
    async scan(values = ids) {ids = [...values];assert.equal((await h.sidebar.scan()).status,'recognized');return h.sidebar.getModel();},
    async restart() {await h.sidebar.stop();h.sidebar = await create();return h.sidebar.getModel();},
    offers(value) {ids = [...value];},
    deferNext() {deferred = true;}, release() {release?.();},
    async confirm(id) {const model = h.sidebar.getModel(), current = model.pendingOffers.at(-1);
      return h.sidebar.confirmOffer({id,pendingId:current.pendingId,gameId:model.gameId,revision:model.sessionRevision});},
  };
  t.after(async () => {
    release?.(); for (const sidebar of instances) await sidebar.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(root)+path.sep));
    await rm(directory,{recursive:true,force:true});
  });
  return h;
}

async function thirdRound(h) {
  await h.scan(first); await h.confirm(first[0]);
  h.advance(20000,{level:7,life:{status:'detected',isDead:true}});
  await h.scan(second); await h.confirm(second[0]);
  h.advance(20000,{life:{status:'detected',isDead:false}}); h.sidebar.getModel();
  h.advance(20000,{level:11,life:{status:'detected',isDead:true}});
  return h.scan(observed);
}

test('normal confirmed prefix preserves the 15:29:00 round through restart and the 15:29:18 reroll', async t => {
  const h = await fixture(t), before = await thirdRound(h), previous = before.pendingOffers[0];
  assert.equal(previous.sequence,3);
  h.advance(13000); const restored = await h.restart();
  assert.equal(restored.pendingOffers[0].pendingId,previous.pendingId);
  assert.equal(h.sidebar.pendingOffers.latest.capture,null);
  assert.equal(h.sidebar.pendingOffers.latest.lastSeenOfferCycle,undefined);
  h.advance(5000); const after = await h.scan(rerolled);
  assert.deepEqual(after.pendingOffers.map(group => group.sequence),[3]);
  assert.equal(after.pendingOffers[0].previousRound,false);
  assert.notEqual(after.pendingOffers[0].pendingId,previous.pendingId);
  assert.equal(h.sidebar.pendingOffers.nextSequence,4);
  assert.deepEqual(after.owned.map(augment => augment.id),[first[0],second[0]]);
  await assert.rejects(h.sidebar.confirmOffer({id:observed[1],pendingId:previous.pendingId,
    gameId:after.gameId,revision:after.sessionRevision}),SessionConflictError);
  await h.sidebar.persist();
  const saved = JSON.parse(await readFile(path.join(h.directory,'session.json'),'utf8'));
  assert.equal(saved.pendingOffers.version,2);
  assert.deepEqual(saved.pendingOffers.entries[0].roundContext,{rule:'aram-mayhem-standard-v1',milestone:11,level:11});
  assert.doesNotMatch(JSON.stringify(saved),/offerCycle|runtime|windowHandle|identityAnchors|captureRevision/);
});

test('rerolls before the first death recapture and after respawn stay in the uniquely identified round', async t => {
  const h = await fixture(t), before = await thirdRound(h);
  h.advance(1000,{life:{status:'detected',isDead:false}}); h.sidebar.getModel();
  const cycle = h.sidebar.scanSchedule.offerCycle;
  h.advance(1000,{life:{status:'detected',isDead:true}}); h.sidebar.getModel();
  assert.ok(h.sidebar.scanSchedule.offerCycle > cycle);
  const dead = await h.scan(rerolled);
  assert.deepEqual(dead.pendingOffers.map(group => group.sequence),[3]);
  assert.notEqual(dead.pendingOffers[0].pendingId,before.pendingOffers[0].pendingId);
  h.advance(1000,{life:{status:'detected',isDead:false}}); h.sidebar.getModel();
  const alive = await h.scan(['goliath','archmage','king_me']);
  assert.deepEqual(alive.pendingOffers.map(group => group.sequence),[3]);
  assert.deepEqual(alive.owned.map(augment => augment.id),[first[0],second[0]]);
});

test('a genuinely later milestone keeps the old unanswered round even one millisecond later in the same lifecycle', async t => {
  const h = await fixture(t), before = await thirdRound(h), cycle = h.sidebar.scanSchedule.offerCycle;
  h.advance(1,{level:15});
  const next = await h.scan(rerolled);
  assert.equal(h.sidebar.scanSchedule.offerCycle,cycle);
  assert.deepEqual(next.pendingOffers.map(group => group.sequence),[3,4]);
  assert.equal(next.pendingOffers[0].pendingId,before.pendingOffers[0].pendingId);
  assert.deepEqual(next.pendingOffers.map(group => group.previousRound),[true,false]);
  assert.deepEqual(next.offers.map(offer => offer.id),rerolled);
});

test('backfilling an old round sharing the scan cycle preserves newer scanning; a later confirmed choice permits future candidates', async t => {
  const h = await fixture(t), before = await thirdRound(h), older = before.pendingOffers[0];
  h.advance(1,{level:15}); const next = await h.scan(rerolled);
  const deadline = h.sidebar.scanSchedule.windowUntil, cycle = h.sidebar.scanSchedule.offerCycle;
  const oldAnswered = await h.sidebar.confirmOffer({id:observed[0],pendingId:older.pendingId,
    gameId:next.gameId,revision:next.sessionRevision});
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation,true);
  assert.equal(h.sidebar.scanSchedule.windowUntil,deadline);
  assert.equal(h.sidebar.scanSchedule.offerCycle,cycle);
  assert.deepEqual(oldAnswered.pendingOffers.map(group => group.sequence),[4]);
  h.advance(500); assert.equal((await h.sidebar.scan()).status,'recognized');
  const complete = await h.confirm(rerolled[0]);
  assert.deepEqual(complete.pendingOffers,[]);
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation,false);
  assert.equal((await h.sidebar.scan()).code,undefined);
  assert.deepEqual(h.sidebar.getModel().pendingOffers,[],'the consumed cards cannot create another choice');
  h.advance(1000,{life:{status:'detected',isDead:false}}); h.sidebar.getModel();
  h.advance(1000,{life:{status:'detected',isDead:true}}); h.sidebar.getModel();
  const additional = await h.scan(['archmage','shrink_engine','jeweled_gauntlet']);
  assert.deepEqual(additional.pendingOffers.map(group => group.sequence),[5]);
  assert.deepEqual(additional.owned.map(augment => augment.id),[first[0],second[0],observed[0],rerolled[0]]);
});

test('confirming a previous milestone before the first new-card scan keeps the current automatic window open', async t => {
  const h = await fixture(t); await thirdRound(h);
  const deadline = h.sidebar.scanSchedule.windowUntil, window = h.sidebar.scanSchedule.windowId;
  const cycle = h.sidebar.scanSchedule.offerCycle, scans = h.sidebar.scanCount;
  h.advance(1,{level:15}); h.offers(rerolled);
  const confirmed = await h.confirm(observed[0]);
  assert.deepEqual(confirmed.owned.map(augment => augment.id),[first[0],second[0],observed[0]]);
  assert.deepEqual(confirmed.pendingOffers,[],'the new cards have not been read yet');
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation,true);
  assert.equal(h.sidebar.scanSchedule.offerCycle,cycle);
  assert.equal(h.sidebar.scanSchedule.windowId,window);
  assert.equal(h.sidebar.scanSchedule.windowUntil,deadline);
  h.advance(500); await h.sidebar.pollOnce();
  assert.equal(h.sidebar.scanCount,scans+1);
  assert.deepEqual(h.sidebar.getModel().offers.map(offer => offer.id),rerolled);
  assert.deepEqual(h.sidebar.getModel().pendingOffers.map(group => group.sequence),[4]);
});

test('confirming the actual current round after an ordinary level increase still closes scanning', async t => {
  const h = await fixture(t); await thirdRound(h);
  const scans = h.sidebar.scanCount;
  h.advance(1,{level:12}); await h.confirm(observed[0]);
  assert.equal(h.sidebar.scanSchedule.awaitingConfirmation,false);
  h.advance(500); await h.sidebar.pollOnce();
  assert.equal(h.sidebar.scanCount,scans);
  assert.deepEqual(h.sidebar.getModel().owned.map(augment => augment.id),[first[0],second[0],observed[0]]);
});

test('same-level rerolls replace the current round even when earlier confirmations were missed', async t => {
  const h = await fixture(t,{level:11});
  const oldest = await h.scan(first);
  h.advance(1); await h.scan(second);
  h.advance(1); const next = await h.scan(observed);
  assert.deepEqual(next.pendingOffers.map(group => group.sequence),[1]);
  assert.notEqual(next.pendingOffers[0].pendingId,oldest.pendingOffers[0].pendingId);
  assert.equal(h.sidebar.pendingOffers.latest.roundContext.level,11);
  assert.deepEqual(next.owned,[]);
});

test('same-level rerolls replace only the latest group and unknown level cannot discard any pending group', async t => {
  const h = await fixture(t); const oldest = await h.scan(first);
  h.advance(1,{level:7}); const later = await h.scan(second);
  h.advance(1,{level:11}); const third = await h.scan(observed);
  h.advance(500); await h.restart();
  h.advance(1); const sameLevel = await h.scan(rerolled);
  assert.deepEqual(sameLevel.pendingOffers.map(group => group.sequence),[1,2,3]);
  assert.notEqual(sameLevel.pendingOffers[2].pendingId,third.pendingOffers[2].pendingId);
  assert.equal(sameLevel.pendingOffers[0].pendingId,oldest.pendingOffers[0].pendingId);
  assert.equal(sameLevel.pendingOffers[1].pendingId,later.pendingOffers[1].pendingId);
  h.advance(1,{level:null}); const unknown = await h.scan(['goliath','archmage','king_me']);
  assert.deepEqual(unknown.pendingOffers.map(group => group.sequence),[1,2,3,4]);
  assert.equal(unknown.pendingOffers[0].pendingId,oldest.pendingOffers[0].pendingId);
  assert.equal(unknown.pendingOffers[1].pendingId,later.pendingOffers[1].pendingId);
  assert.equal(unknown.pendingOffers[2].pendingId,sameLevel.pendingOffers[2].pendingId);
});

test('an exact repeated card group refreshes its observed level before a same-level reroll without marking anything selected', async t => {
  const h = await fixture(t), before = await h.scan(first);
  h.advance(1,{level:11}); await h.scan(first);
  assert.equal(h.sidebar.pendingOffers.latest.roundContext.level,11);
  h.advance(1); const after = await h.scan(second);
  assert.deepEqual(after.pendingOffers.map(group => group.sequence),[1]);
  assert.notEqual(after.pendingOffers[0].pendingId,before.pendingOffers[0].pendingId);
  assert.deepEqual(after.owned,[]);
});

test('an ordinary level increase inside a proven choice interval does not create a new round', async t => {
  const h = await fixture(t), before = await thirdRound(h);
  h.advance(1,{level:12}); const after = await h.scan(rerolled);
  assert.deepEqual(after.pendingOffers.map(group => group.sequence),[3]);
  assert.notEqual(after.pendingOffers[0].pendingId,before.pendingOffers[0].pendingId);
  assert.equal(h.sidebar.pendingOffers.latest.roundContext.level,12);
});

test('a capture crossing a level update cannot bind old cards to the completed snapshot level', async t => {
  const h = await fixture(t), before = await thirdRound(h);
  h.advance(1); h.deferNext(); const reading = h.scan(rerolled);
  h.advance(1,{level:12}); h.release(); const after = await reading;
  assert.deepEqual(after.pendingOffers.map(group => group.sequence),[3,4]);
  assert.equal(after.pendingOffers[0].pendingId,before.pendingOffers[0].pendingId);
  assert.equal(h.sidebar.pendingOffers.latest.roundContext,undefined);
});

test('a confirmed later group is a boundary even when an older pending group resurfaces at the same level', async t => {
  const h = await fixture(t); await h.scan(first);
  h.advance(1,{level:7}); await h.scan(second); await h.confirm(second[0]);
  h.advance(1); await h.scan(first);
  h.advance(1); const after = await h.scan(observed);
  assert.deepEqual(after.pendingOffers.map(group => group.sequence),[1,3]);
  assert.deepEqual(after.owned.map(augment => augment.id),[second[0]]);
});

test('legacy restart without saved progression does not infer a merge from time or a shared candidate', async t => {
  const h = await fixture(t), before = await thirdRound(h);
  await h.sidebar.stop();
  const file = path.join(h.directory,'session.json'), saved = JSON.parse(await readFile(file,'utf8'));
  saved.pendingOffers.version = 1;
  for (const entry of saved.pendingOffers.entries) delete entry.roundContext;
  await writeFile(file,JSON.stringify(saved),'utf8');
  h.advance(1); await h.restart();
  h.advance(1); const after = await h.scan(rerolled);
  assert.deepEqual(after.pendingOffers.map(group => group.sequence),[3,4]);
  assert.equal(after.pendingOffers[0].pendingId,before.pendingOffers[0].pendingId);
});

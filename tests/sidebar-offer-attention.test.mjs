// Isolated attention snapshots; no game input, images, installed data or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BackgroundSidebar} from '../server/sidebar.mjs';

const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const ids=['recursion','shrink_engine','jeweled_gauntlet'];
const nextIds=['eureka','archmage','transmute_prismatic'];
const inactive={active:false,pendingId:null,capturedAt:null,expiresAt:null};
const capture=capturedAt=>({capturedAt,width:1920,height:1080,originX:0,originY:0,windowHandle:'12345',
  regions:[0,1,2].map(column=>({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)})),
  identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'attention-fixture',pass:'card-titles-color',
    cards:[0,1,2].map(column=>({column,anchors:[{box:{x:430+column*400,y:350,width:180,height:24},
      feature:Array.from({length:128},(_,index)=>index%2?16:0)}]}))}});

function harness(t,{dead=false}={}) {
  let now=Date.parse('2026-10-28T05:00:00Z'),offers=[...ids],kind='cards';
  let live={connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'attention-game',
    championId:'Ahri',level:3,gameTime:300,life:{status:'detected',isDead:dead},mode:{known:true,isMayhem:true},
    items:[],stats:{},observedAt:new Date(now).toISOString()};
  const advance=ms=>{now+=ms;live.observedAt=new Date(now).toISOString();live.gameTime+=ms/1000;};
  const sidebar=new BackgroundSidebar({collector:{getSnapshot:()=>structuredClone(live)},data,now:()=>now,
    scanner:async()=>{advance(1);return kind==='cards'
      ? {status:'recognized',proposals:offers.map(id=>({id})),selectionCapture:capture(now)}
      : kind==='names' ? {status:'recognized',proposals:offers.map(id=>({id}))}
        : {status:'waiting',code:kind,proposals:[]};}});
  t.after(()=>sidebar.stop());
  return {sidebar,advance,now:()=>now,model:()=>sidebar.getModel(),update:value=>{live={...live,...value};},
    setOffers:value=>{offers=[...value];},setKind:value=>{kind=value;}};
}

for(const dead of [false,true]) test(`validated ${dead?'death':'alive'} cards publish short-lived attention without selection proof`,async t=>{
  const h=harness(t,{dead});assert.deepEqual(h.model().offerAttention,inactive);
  await h.sidebar.scan();const model=h.model(),attention=model.offerAttention;
  assert.equal(attention.active,true);assert.equal(attention.pendingId,model.pendingOffers[0].pendingId);
  assert.equal(Date.parse(attention.capturedAt),h.now());assert.equal(Date.parse(attention.expiresAt)-h.now(),8000);
  assert.deepEqual(Object.keys(attention).sort(),['active','capturedAt','expiresAt','pendingId']);
  assert.deepEqual(model.owned,[]);
  if(dead)assert.equal(model.selection.status,'waiting','attention must not enable forbidden dead click confirmation');
  h.advance(1000);assert.deepEqual(h.model().offerAttention,attention,'polling does not renew capture time or deadline');
  h.advance(7000);assert.deepEqual(h.model().offerAttention,inactive,'attention expires at its exact deadline');
  assert.equal(h.model().offers.length,3,'expiration keeps unresolved choices');
});

test('fresh same-triplet captures renew attention while repeated model polling does not',async t=>{
  const h=harness(t);await h.sidebar.scan();const first=h.model().offerAttention;
  h.advance(5000);await h.sidebar.scan();const second=h.model().offerAttention;
  assert.equal(second.pendingId,first.pendingId);assert.ok(Date.parse(second.expiresAt)>Date.parse(first.expiresAt));
});

test('same-level rerolls use their new current capture and cannot retain the prior attention identity',async t=>{
  const h=harness(t);await h.sidebar.scan();const before=h.model().offerAttention;
  h.advance(1000);h.setOffers(nextIds);await h.sidebar.scan();const model=h.model();
  assert.equal(model.pendingOffers.length,1);assert.equal(model.pendingOffers[0].sequence,1);
  assert.equal(model.offerAttention.active,true);assert.notEqual(model.offerAttention.pendingId,before.pendingId);
  assert.equal(model.offerAttention.pendingId,model.pendingOffers[0].pendingId);
});

test('confirming the new round does not turn the old pending round into visible-card attention',async t=>{
  const h=harness(t);await h.sidebar.scan();h.advance(1000);h.update({level:11,life:{status:'detected',isDead:true}});
  h.setOffers(nextIds);await h.sidebar.scan();const before=h.model();
  assert.equal(before.pendingOffers.length,2);assert.equal(before.offerAttention.active,true);
  await h.sidebar.confirmOffer({id:nextIds[0],pendingId:before.offerAttention.pendingId,gameId:before.gameId,revision:before.sessionRevision});
  const after=h.model();assert.equal(after.pendingOffers.length,1);assert.deepEqual(after.offers.map(row=>row.id),ids);
  assert.deepEqual(after.offerAttention,inactive);
});

test('restored pending rounds have no attention until a new validated capture',async t=>{
  const h=harness(t);await h.sidebar.scan();const saved=h.sidebar.pendingOffers.save();
  const restored=harness(t);restored.model();
  assert.equal(restored.sidebar.pendingOffers.restore(saved,id=>restored.sidebar.augments.has(id),[]),true);
  assert.equal(restored.model().offers.length,3);assert.deepEqual(restored.model().offerAttention,inactive);
  await restored.sidebar.scan();assert.equal(restored.model().offerAttention.active,true);
});

for(const kind of ['names','title-name-unmatched','game-not-foreground']) test(`${kind} does not treat preserved candidates as currently visible cards`,async t=>{
  const h=harness(t);await h.sidebar.scan();assert.equal(h.model().offerAttention.active,true);
  h.advance(1000);h.setKind(kind);await h.sidebar.scan();assert.equal(h.model().offers.length,3);
  assert.deepEqual(h.model().offerAttention,inactive);
});

test('new game, manual correction, recognition disable and lifecycle change invalidate attention immediately',async t=>{
  for(const action of [
    h=>h.update({gameId:'another-game'}),h=>h.sidebar.setSession({owned:[ids[0]],route:'auto'}),
    h=>h.sidebar.setOcr({enabled:false}),h=>h.update({life:{status:'detected',isDead:true}})
  ]) {
    const h=harness(t);await h.sidebar.scan();assert.equal(h.model().offerAttention.active,true);h.advance(1000);
    await action(h);assert.deepEqual(h.model().offerAttention,inactive);
  }
});

test('invalid collector context never publishes attention even with retained capture geometry',async t=>{
  for(const update of [
    {connection:{status:'waiting'}},{stage:'loading'},{phase:'EndOfGame'},
    {mode:{known:true,isMayhem:false}},{observedAt:'invalid'},{gameId:null}
  ]) {
    const h=harness(t);await h.sidebar.scan();h.update(update);assert.deepEqual(h.model().offerAttention,inactive);
  }
});

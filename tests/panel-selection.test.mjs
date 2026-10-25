// Synthetic classification proofs validate the boundary, not real HUD capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PANEL_SELECTION_POLICY, validatePanelEvidence} from '../server/panel-selection.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const stamp = Date.parse('2026-10-25T01:00:00Z');
const statistic = (sampleCount = 1000, winRate = .55, extra = {}) => ({
  championId:'MonkeyKing',mode:'mayhem',patch:'16.21',source:'fixture',sampleCount,winRate,...extra,
});
const context = () => ({
  now:stamp+2000,gameId:'custom-game',gameEpoch:3,revision:7,offerToken:'a'.repeat(32),
  ids:['left','middle','right'],championId:'MonkeyKing',offeredAt:stamp,patch:'16.21',eligible:true,
  offers:['left','middle','right'].map((id,index) => ({id,iconKey:`icon-${index}`,kind:'augment',statistic:statistic()})),owned:[],
});
const slots = (matches = [[0]], start = 0) => Array.from({length:6},(_,index) => {
  const indices = matches[index-start] || [];
  return {slotIndex:index,state:indices.length > 1 ? 'ambiguous' : indices.length ? 'candidate' : 'empty',candidateIndices:[...indices]};
});
function proof(current = context(), matches = [[0]]) {
  return {version:2,provider:'panel-icon',glyphs:glyphProof(current.offers,current.owned),offerToken:current.offerToken,gameId:current.gameId,gameEpoch:current.gameEpoch,
    revision:current.revision,ids:[...current.ids],frames:[0,1,2].map(index => ({captureId:`capture-${index}`,
      capturedAt:stamp+1000+index*150,panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,
      geometryKey:'client-1920x1080-hud-100',slots:slots(matches)}))};
}
function collision() {
  const current = context(); current.offers[1].iconKey = current.offers[0].iconKey;
  return {current,value:proof(current,[[0,1]])};
}

test('one stable current-offer glyph matches without a prior baseline or game click', () => {
  const current = context(), input = proof(current,[[2]]);
  const result = validatePanelEvidence(input,current);
  assert.equal(result.status,'matched'); assert.equal(result.id,'right');
  assert.equal(result.selectedIndex,2); assert.equal(result.inferred,false);
  assert.deepEqual(result.evidence,{kind:'panel-icon-match',surface:'hud-six-slot',frameCount:3,
    matchedSlots:[0],candidateIndices:[2],resolution:'icon'});
  assert.equal(result.observedAt,stamp+1300);
  assert.equal(result.provider,'panel-icon');
  result.evidence.matchedSlots.push(99); result.evidence.candidateIndices[0] = 1;
  assert.equal(input.frames[0].slots[0].candidateIndices[0],2,'result cannot mutate input evidence');
});

test('the panel may be opened late after the cards are gone, within the bounded round age', () => {
  const current = context(); current.now += 200000;
  const value = proof(current);
  for (const frame of value.frames) frame.capturedAt += 200000;
  assert.equal(validatePanelEvidence(value,current).status,'matched');
  current.offeredAt = current.now-300001;
  assert.equal(validatePanelEvidence(value,current).reason,'panel-offer-expired');
});

test('same-glyph inference prioritizes this champion usage over a material win-rate lead', () => {
  const {current,value} = collision();
  current.offers[0].statistic = statistic(1000,.40); current.offers[1].statistic = statistic(800,.80);
  const result = validatePanelEvidence(value,current);
  assert.equal(result.status,'inferred'); assert.equal(result.id,'left'); assert.equal(result.inferred,true);
  assert.equal(result.evidence.resolution,'usage-then-win-rate');
  assert.deepEqual(result.evidence.candidateIndices,[0,1]);
});

test('within the explicit ten-percent usage band the larger win rate resolves a collision', () => {
  for (const count of [900,950,1000,1050,1100]) {
    const {current,value} = collision();
    current.offers[0].statistic = statistic(1000,.50); current.offers[1].statistic = statistic(count,.60);
    assert.equal(validatePanelEvidence(value,current).id,'middle',String(count));
  }
  const {current,value} = collision();
  current.offers[0].statistic = statistic(1000,.50); current.offers[1].statistic = statistic(899,.60);
  assert.equal(validatePanelEvidence(value,current).id,'left');
  assert.equal(validatePanelEvidence(value,current,{closeUsageFraction:.20}).id,'middle');
});

test('anchored usage groups avoid non-transitive pairwise closeness or physical-order bias', () => {
  const current = context(); for (const offer of current.offers) offer.iconKey = 'same-glyph';
  current.offers[0].statistic = statistic(1000,.40);
  current.offers[1].statistic = statistic(910,.50);
  current.offers[2].statistic = statistic(830,.90);
  assert.equal(validatePanelEvidence(proof(current,[[0,1,2]]),current).id,'middle');
  const reordered = structuredClone(current); reordered.ids.reverse(); reordered.offers.reverse();
  assert.equal(validatePanelEvidence(proof(reordered,[[0,1,2]]),reordered).id,'middle');
});

test('unknown or equal collision statistics never silently use physical order or recommendation rank', () => {
  for (const change of [offer => {delete offer.statistic;}, offer => {offer.statistic.sampleCount = 0;},
    offer => {offer.statistic.sampleCount = '1000';}, offer => {offer.statistic.championId = 'Teemo';},
    offer => {offer.statistic.mode = 'aram';}, offer => {offer.statistic.patch = '16.20';},
    offer => {offer.statistic.source = '';}, offer => {offer.statistic.winRate = null;},
    offer => {offer.statistic.winRate = NaN;}]) {
    const {current,value} = collision(); change(current.offers[1]);
    assert.equal(validatePanelEvidence(value,current).reason,'panel-statistics-unavailable');
  }
  const {current,value} = collision();
  assert.equal(validatePanelEvidence(value,current).reason,'panel-statistics-tied');
  delete current.patch;
  assert.equal(validatePanelEvidence(value,current).reason,'panel-statistics-unavailable');
});

test('a clear usage leader can be inferred when win rate is unavailable because no tiebreak is needed', () => {
  const {current,value} = collision();
  current.offers[0].statistic = statistic(1000,null); current.offers[1].statistic = statistic(100,.90);
  assert.equal(validatePanelEvidence(value,current).id,'left');
});

test('nearby but different glyph matches do not become statistics-resolvable ambiguity', () => {
  const current = context(), value = proof(current,[[0,1]]);
  assert.equal(validatePanelEvidence(value,current).reason,'panel-collision-unverified');
  const {current:shared,value:partial} = collision();
  for (const frame of partial.frames) frame.slots = slots([[0]]);
  assert.equal(validatePanelEvidence(partial,shared).reason,'panel-collision-unverified');
});

test('known-owned glyphs require one extra occurrence before any new selection is inferred', () => {
  const current = context(); current.owned = [{id:'previous',iconKey:'icon-0'}];
  assert.equal(validatePanelEvidence(proof(current),current).reason,'panel-no-new-match');
  const value = proof(current,[[0],[0]]);
  assert.equal(validatePanelEvidence(value,current).status,'matched');
  assert.deepEqual(validatePanelEvidence(value,current).evidence.matchedSlots,[0,1]);
  const {current:shared} = collision(); shared.owned = [{id:'previous',iconKey:'icon-0'}];
  shared.offers[1].statistic.sampleCount = 100;
  assert.equal(validatePanelEvidence(proof(shared,[[0,1]]),shared).reason,'panel-no-new-match');
  assert.equal(validatePanelEvidence(proof(shared,[[0,1],[0,1]]),shared).status,'inferred');
});

test('multiple newly matching groups or extra unidentified copies remain pending', () => {
  const current = context();
  assert.equal(validatePanelEvidence(proof(current,[[0],[1]]),current).reason,'panel-multiple-new-groups');
  assert.equal(validatePanelEvidence(proof(current,[[0],[0]]),current).reason,'panel-multiple-new-groups');
  assert.equal(validatePanelEvidence(proof(current,[]),current).reason,'panel-no-new-match');
});

test('the optional fixed skill slot is excluded without relying on a fixed slot position', () => {
  const current = context();
  for (const skillSlot of [0,2,5]) {
    const value = proof(current,[]);
    for (const frame of value.frames) {
      frame.slots[skillSlot].state = 'excluded';
      const candidateSlot = (skillSlot+1)%6;
      frame.slots[candidateSlot] = {slotIndex:candidateSlot,state:'candidate',candidateIndices:[1]};
    }
    assert.equal(validatePanelEvidence(value,current).id,'middle');
  }
  const excluded = proof(current,[]); for (const frame of excluded.frames) frame.slots[0].state = 'excluded';
  assert.equal(validatePanelEvidence(excluded,current).reason,'panel-no-new-match');
});

test('manual revision, new game, new round token and candidate order fence off old panel evidence', () => {
  for (const override of [{gameId:'other'}, {gameEpoch:4}, {revision:8}, {offerToken:'b'.repeat(32)},
    {ids:['middle','left','right']}]) {
    const current = context(), value = {...proof(current),...override};
    assert.equal(validatePanelEvidence(value,current).reason,'panel-context-mismatch');
  }
  const current = context(); current.eligible = false;
  assert.equal(validatePanelEvidence(proof(current),current).reason,'panel-ineligible');
});

test('freshness and offer timing are checked for every independent frame', () => {
  for (const [mutate,reason] of [
    [value => {value.frames[0].capturedAt = stamp-1;},'panel-capture-before-offer'],
    [value => {for (const frame of value.frames) frame.capturedAt -= 10000;},'panel-capture-before-offer'],
    [value => {value.frames[2].capturedAt = stamp+4000;},'panel-capture-future'],
    [value => {value.frames[2].captureId = value.frames[0].captureId;},'panel-captures-not-independent'],
    [value => {value.frames[1].capturedAt = value.frames[0].capturedAt;},'panel-captures-not-independent'],
    [value => {value.frames.reverse();},'panel-captures-not-independent'],
  ]) {
    const current = context(), value = proof(current); mutate(value);
    assert.equal(validatePanelEvidence(value,current).reason,reason);
  }
  const current = context(), value = proof(current); current.now += 6000;
  assert.equal(validatePanelEvidence(value,current).reason,'panel-capture-stale');
});

test('unstable panels, overlay occlusion, visible cards and changed geometry cannot confirm', () => {
  for (const [mutate,reason] of [
    [value => {value.frames[1].panelVisible = false;},'panel-not-visible'],
    [value => {value.frames[1].gameSurfaceVerified = false;},'panel-game-unverified'],
    [value => {value.frames[1].selectionUiVisible = true;},'panel-selection-ui-visible'],
    [value => {value.frames[1].geometryKey = 'client-1920x1080-hud-90';},'panel-geometry-changed'],
    [value => {value.frames[1].slots = slots([[1]]);},'panel-unstable'],
    [value => {value.frames[1].capturedAt = stamp+1100; value.frames[2].capturedAt = stamp+1200;},'panel-unstable'],
  ]) {
    const current = context(), value = proof(current); mutate(value);
    assert.equal(validatePanelEvidence(value,current).reason,reason);
  }
});

test('strict bounded evidence rejects extra data, malformed states, sparse arrays and oversized payloads', () => {
  for (const mutate of [
    value => {value.provider = 'overwolf';}, value => {value.rawText = 'private';},
    value => {value.frames[0].image = 'pixels';}, value => {value.frames.pop();},
    value => {delete value.frames[0].slots[1];}, value => {value.frames[0].slots.pop();},
    value => {value.frames[0].slots[0].slotIndex = 5;},
    value => {value.frames[0].slots[0].candidateIndices = [3];},
    value => {value.frames[0].slots[0].state = 'excluded';},
    value => {value.frames[0].slots[0].state = 'ambiguous';},
    value => {value.frames[0].slots[0].candidateIndices = [1,0];},
    value => {value.frames[0].slots[0].extra = 'private';},
    value => {value.frames[0].captureId = 'x'.repeat(81);},
    value => {value.frames[0].capturedAt = 'now';},
  ]) {
    const current = context(), value = proof(current); mutate(value);
    assert.equal(validatePanelEvidence(value,current).reason,'panel-evidence-invalid');
  }
  const current = context(), value = proof(current);
  value.frames = Array.from({length:8},(_,index) => ({...structuredClone(value.frames[0]),captureId:`capture-${index}`,capturedAt:stamp+index*150}));
  assert.equal(validatePanelEvidence(value,current).reason,'panel-evidence-invalid','HTTP payload stays within 4096 bytes');
});

test('scope accepts only ordinary server-known augments and never uses a skill enhancement as a candidate', () => {
  for (const mutate of [current => {current.offers[0].kind = 'skill-enhancement';},
    current => {current.owned.push({id:'left',iconKey:'icon-0'});},
    current => {delete current.offers[1];}, current => {current.offers[1].id = 'other';},
    current => {current.championId = '';}, current => {current.revision = -1;},
    current => {current.owned = [{id:'old',iconKey:''}];}]) {
    const current = context(), value = proof(current); mutate(current);
    assert.equal(validatePanelEvidence(value,current).reason,'panel-context-invalid');
  }
});

test('policy normalization keeps immutable defaults and cannot disable evidence boundaries', () => {
  assert.ok(Object.isFrozen(DEFAULT_PANEL_SELECTION_POLICY));
  assert.equal(DEFAULT_PANEL_SELECTION_POLICY.closeUsageFraction,.10);
  assert.equal(DEFAULT_PANEL_SELECTION_POLICY.maxOfferAgeMs,300000);
  const {current,value} = collision(); current.offers[0].statistic.sampleCount = 2000;
  assert.equal(validatePanelEvidence(value,current,{closeUsageFraction:1,maxOfferAgeMs:Infinity,maxProofBytes:99999}).id,'left');
  assert.equal(validatePanelEvidence(value,current,{maxProofBytes:512}).reason,'panel-evidence-invalid');
});

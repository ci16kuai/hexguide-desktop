import test from 'node:test';
import assert from 'node:assert/strict';
import {observedOfferRound, validOfferRound} from '../server/offer-round.mjs';

const now = Date.parse('2026-10-28T15:29:18Z');
const live = {gameId:'isolated-round',phase:'InProgress',stage:'live',connection:{status:'connected'},
  mode:{known:true,isMayhem:true},observedAt:new Date(now).toISOString(),level:11};
const options = {now,gameId:live.gameId};

test('ordinary choice progress stays stable inside milestones without inferring any choice', () => {
  for (const [level,milestone] of [[3,3],[6,3],[7,7],[10,7],[11,11],[14,11],[15,15],[18,15]]) {
    const progress = observedOfferRound({...live,level},options);
    assert.equal(progress.milestone,milestone); assert.equal(validOfferRound(progress),true);
  }
});

test('unknown, wrong-game, wrong-mode and stale progress cannot relabel an unanswered round', () => {
  for (const change of [{level:null},{level:2},{level:31},{level:7.5},{gameId:'another-game'},
    {phase:'Reconnect'},{stage:'loading'},{connection:{status:'disconnected'}},{mode:{known:false,isMayhem:true}},
    {mode:{known:true,isMayhem:false}},{observedAt:new Date(now-10001).toISOString()},
    {observedAt:new Date(now+1001).toISOString()},{observedAt:null}]) {
    assert.equal(observedOfferRound({...live,...change},options),null);
  }
  assert.equal(validOfferRound({rule:'aram-mayhem-standard-v1',milestone:7,windowHandle:'unsafe'}),false);
  assert.equal(validOfferRound({rule:'unknown-season',milestone:7}),false);
});

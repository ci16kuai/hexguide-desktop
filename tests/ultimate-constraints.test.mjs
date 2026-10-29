import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {enrichData, getMechanicalConstraints, getSynergy, recommend} from '../dist/engine.js';
import {rankAugmentCandidates} from '../dist/recommendation-policy.js';
import {buildLivePlan} from '../dist/adaptive.js';
import {RecommendationRepository} from '../server/recommendation-repository.mjs';

const read = async name => JSON.parse(await readFile(new URL(`../dist/${name}.json`, import.meta.url), 'utf8'));
const [data, itemsCatalog, statisticsSnapshot] = await Promise.all(['data', 'items', 'statistics'].map(read));
const byId = id => data.augments.find(row => row.id === id);
const disabled = byId('back_to_basics');
const ultimateOnly = ['final_form', 'ultimate_awakening', 'its_killing_time', 'ultimate_unstoppable',
  'ultimate_revolution', 'fey_magic', 'cant_touch_this', 'stuck_in_here_with_me', 'surge_field',
  'arcane_axiom', 'ultimate_recursion'];
const independent = ['skilled_sniper', 'weighted_popoffs', 'spin_to_win', 'prom_queen', 'ultra_hydra'];
const row = augment => ({augment, mechanismScore:recommend(augment, null).score});
const fixture = (id, description) => ({id, name:id, description, availability:'current'});

test('authentic descriptions distinguish lost ultimate mechanics from basic, borrowed and independent effects', () => {
  assert.deepEqual(getMechanicalConstraints(disabled), {noUltimate:true, requiresUltimate:false});
  for (const id of ultimateOnly) assert.equal(getMechanicalConstraints(byId(id)).requiresUltimate, true, id);
  for (const id of independent) assert.equal(getMechanicalConstraints(byId(id)).requiresUltimate, false, id);
  const enriched = enrichData({augments:[disabled, byId('final_form')]}).augments;
  assert.ok(enriched[0].constraints.includes('noUltimate'));
  assert.ok(enriched[1].requirements.includes('requiresUltimate'));
  for (const description of [
    '获得60法术强度。在施放你的终极技能后，获得护盾。',
    '施放你的终极技能或召唤师技能时，获得护盾。',
    '当敌人施放终极技能时，获得护盾。',
    '获得30终极技能急速和60法术强度。',
    '你的基础技能获得30技能急速。',
  ]) assert.equal(getMechanicalConstraints(fixture('independent', description)).requiresUltimate, false, description);
  // IDs and names cannot establish dependencies; only the effect does.
  assert.equal(getMechanicalConstraints({...byId('final_form'), description:'获得60法术强度。'}).requiresUltimate, false);
  assert.equal(getMechanicalConstraints(fixture('renamed', 'After you cast your ultimate ability, gain a shield.')).requiresUltimate, true);
  assert.equal(getMechanicalConstraints(fixture('english-disabler', 'You cannot use your ultimate ability.')).noUltimate, true);
});

test('pair explanations, suitability and direct ranking apply ultimate constraints in both directions before win rates', () => {
  for (const id of ultimateOnly) {
    const dependent = byId(id);
    for (const [owned, candidate] of [[disabled, dependent], [dependent, disabled]]) {
      assert.equal(getSynergy(owned, candidate).level, 'conflict', `${owned.id} -> ${candidate.id}`);
      assert.ok(recommend(candidate, null, [owned]).conflicts.includes(owned.name));
      assert.deepEqual(rankAugmentCandidates([row(candidate)], {owned:[owned], statistics:{
        [candidate.id]:{winRate:1, sampleCount:100000, comparable:true, patch:'16.21'},
      }}), []);
    }
  }
  for (const id of independent) {
    assert.notEqual(getSynergy(disabled, byId(id)).level, 'conflict', id);
    assert.equal(rankAugmentCandidates([row(byId(id))], {owned:[disabled]}).length,
      byId(id).availability === 'current' ? 1 : 0, id);
  }
});

test('real bundled statistics cannot reintroduce disabled ultimates for Fiddlesticks Karthus or Kennen', async () => {
  const repository = new RecommendationRepository({champions:data.champions, augments:data.augments, statisticsSnapshot});
  try {
    for (const [championId, forbiddenId] of [['Fiddlesticks','final_form'], ['Karthus','ultimate_revolution'], ['Kennen','final_form']]) {
      const champion = data.champions.find(row => row.id === championId);
      const recommendationData = repository.get(championId);
      const options = {champion, augments:data.augments, champions:data.champions, itemsCatalog, recommendationData,
        live:{phase:'InProgress', stage:'live', championId, connection:{status:'connected'}, mode:{known:true,isMayhem:true}}};
      // New snapshots legitimately change the full-catalog top six. Keep this
      // regression about eligibility, using real statistics in a fixed slate.
      const baseline = buildLivePlan({...options, augments:[byId(forbiddenId), byId('skilled_sniper'), byId('spin_to_win')], owned:[]});
      assert.equal(baseline.nextAugments.find(row => row.id === forbiddenId)?.rankingEvidence.trusted, true, championId);
      const restricted = buildLivePlan({...options, owned:[disabled]});
      assert.ok(restricted.nextAugments.length > 0);
      assert.ok(restricted.nextAugments.every(row => !ultimateOnly.includes(row.id)), championId);
      assert.ok(restricted.buildItems.length > 0, 'disabling an ultimate does not disable static equipment');

      // The same recommend -> ranking contract used by the three-choice UI.
      const choices = [byId(forbiddenId), byId('skilled_sniper'), byId('spin_to_win')];
      const ranked = rankAugmentCandidates(choices.map(augment => {
        const result = recommend(augment, champion, [disabled]);
        return {augment, mechanismScore:result.score, conflicts:result.conflicts};
      }), {champion, owned:[disabled], statistics:recommendationData.augmentStatistics});
      assert.deepEqual(new Set(ranked.map(row => row.augment.id)), new Set(['skilled_sniper','spin_to_win']));

      const reversed = buildLivePlan({...options, owned:[byId(forbiddenId)], augments:[disabled, byId('skilled_sniper')]});
      assert.deepEqual(reversed.nextAugments.map(row => row.id), ['skilled_sniper']);
    }
  } finally { await repository.close(); }
});

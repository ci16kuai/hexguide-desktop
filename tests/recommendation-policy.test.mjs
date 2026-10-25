import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyAugmentPolicy, DEFAULT_RECOMMENDATION_POLICY, rankAugmentCandidates} from '../dist/recommendation-policy.js';

const row = (id, description, mechanismScore = 50, extra = {}) => ({augment:{id, description, availability:'current'}, mechanismScore, ...extra});
const ids = rows => rows.map(entry => entry.augment.id);
const stat = (winRate, extra = {}) => ({winRate, sampleCount:1000, comparable:true, patch:'16.21', source:'fixture', ...extra});
const statMap = rows => Object.fromEntries(rows.map(([id, winRate, extra]) => [id, stat(winRate, extra)]));
const manaHero = {id:'FixtureMana', resource:'Mana'};
const manalessHero = {id:'FixtureNoMana', resource:'Energy'};

test('defaults are explicit immutable JSON, including product threshold units', () => {
  assert.equal(DEFAULT_RECOMMENDATION_POLICY.closeWinRateGap, 0.01);
  assert.equal(DEFAULT_RECOMMENDATION_POLICY.minSampleCount, 200);
  assert.equal(DEFAULT_RECOMMENDATION_POLICY.highFlatAttackDamage, 60);
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_RECOMMENDATION_POLICY)), DEFAULT_RECOMMENDATION_POLICY);
  assert.ok(Object.isFrozen(DEFAULT_RECOMMENDATION_POLICY.numericPriority));
});

test('a material trusted win-rate lead precedes a preferred mechanism and suitability', () => {
  const input = [row('mechanic', '你的技能可以暴击。', 100), row('flat', '获得20攻击力。', 1)];
  const result = rankAugmentCandidates(input, {statistics:statMap([['mechanic', .50], ['flat', .55]])});
  assert.deepEqual(ids(result), ['flat', 'mechanic']);
  assert.equal(result[0].rankingEvidence.basis, 'statistics');
  assert.equal(result[0].rankingEvidence.winRate, .55);
  assert.deepEqual(result.map(entry => entry.rank), [1, 2]);
});

test('close trusted rates use mechanism, then percentage/growth, then fixed values', () => {
  const input = [row('flat', '获得20攻击力。'), row('percent', '获得20%攻击力。'), row('mechanic', '你的技能可以暴击。')];
  const result = rankAugmentCandidates(input, {statistics:statMap([['flat', .509], ['percent', .505], ['mechanic', .50]])});
  assert.deepEqual(ids(result), ['mechanic', 'percent', 'flat']);
  assert.equal(new Set(result.map(entry => entry.rankingEvidence.winRateGroup)).size, 1);
  assert.equal(result[0].rankingEvidence.winRateGroupAnchor, .509);
});

test('rate groups are anchored rather than chained by a non-transitive comparator', () => {
  const input = [row('a', '获得20攻击力。'), row('b', '获得20%攻击力。'), row('c', '你的技能可以暴击。')];
  const statistics = statMap([['a', .52], ['b', .511], ['c', .502]]);
  for (const order of [input, [...input].reverse(), [input[1], input[2], input[0]]]) {
    const result = rankAugmentCandidates(order, {statistics});
    assert.deepEqual(ids(result), ['b', 'a', 'c']);
    assert.equal(result[2].rankingEvidence.winRateGroup, 1);
    assert.equal(result[2].rankingEvidence.winRateGroupAnchor, .502);
  }
});

test('the one percentage point boundary is inclusive and the gap can be configured', () => {
  const input = [row('flat', '获得20攻击力。'), row('mechanic', '你的技能可以暴击。')];
  const statistics = statMap([['flat', .51], ['mechanic', .50]]);
  assert.deepEqual(ids(rankAugmentCandidates(input, {statistics})), ['mechanic', 'flat']);
  assert.deepEqual(ids(rankAugmentCandidates(input, {statistics, policy:{closeWinRateGap:.005}})), ['flat', 'mechanic']);
});

test('no credible rates means suitability and existing synergies precede generic categories', () => {
  const input = [row('mechanic', '你的技能可以暴击。', 20), row('fit', '获得20攻击力。', 90)];
  const result = rankAugmentCandidates(input);
  assert.deepEqual(ids(result), ['fit', 'mechanic']);
  for (const entry of result) {
    assert.equal(entry.rankingEvidence.basis, 'mechanism-fallback');
    assert.equal(entry.rankingEvidence.winRate, null);
    assert.equal(entry.rankingEvidence.sampleCount, null);
    assert.equal(entry.rankingEvidence.winRateGroup, null);
    assert.equal(entry.rankingEvidence.rejection, 'missing-statistics');
  }
});

test('untrusted rates never outrank a trusted group or change fallback suitability order', () => {
  const input = [row('trusted', '获得20攻击力。', 1), row('low', '你的技能可以暴击。', 10), row('fit', '获得10生命值。', 90)];
  const result = rankAugmentCandidates(input, {statistics:statMap([
    ['trusted', .4], ['low', .99, {sampleCount:199}], ['fit', .1, {comparable:false}],
  ])});
  assert.deepEqual(ids(result), ['trusted', 'fit', 'low']);
  assert.equal(result[1].rankingEvidence.rejection, 'not-comparable');
  assert.equal(result[2].rankingEvidence.rejection, 'insufficient-sample');
  assert.equal(result[2].rankingEvidence.winRate, .99, 'observed is kept but never promoted to a trusted value');
});

test('source probabilities, comparability, integer counts and exact patches are validated', () => {
  const bad = [
    stat(55), stat(-.1), stat(NaN), stat('0.6'), stat(.6, {sampleCount:'500'}),
    stat(.6, {sampleCount:500.5}), stat(.6, {sampleCount:199}), stat(.6, {comparable:undefined}),
    stat(.6, {patch:'16.20'}),
  ];
  for (const value of bad) {
    const [entry] = rankAugmentCandidates([row('a', '获得10攻击力。')], {statistics:{a:value}, policy:{statisticsPatch:'16.21'}});
    assert.equal(entry.rankingEvidence.basis, 'mechanism-fallback', JSON.stringify(value));
  }
  for (const winRate of [0, 1]) {
    const [entry] = rankAugmentCandidates([row('a', '获得10攻击力。')], {statistics:{a:stat(winRate, {sampleCount:200})}});
    assert.equal(entry.rankingEvidence.basis, 'statistics');
  }
});

test('Map and plain-record sources produce the same output without inherited properties', () => {
  const input = [row('a', '获得10攻击力。')], value = stat(.6);
  assert.deepEqual(rankAugmentCandidates(input, {statistics:{a:value}}), rankAugmentCandidates(input, {statistics:new Map([['a', value]])}));
  assert.equal(rankAugmentCandidates(input, {statistics:Object.create({a:value})})[0].rankingEvidence.basis, 'mechanism-fallback');
});

test('numeric preference order applies only after category and within a close group', () => {
  const definitions = [
    ['omnivamp','获得15%全能吸血。'], ['lifeSteal','获得15%生命偷取。'],
    ['percentPenetration','获得18%护甲穿透和法术穿透。'], ['crit','获得20%暴击几率。'],
    ['percentAttackDamage','获得20%攻击力。'],
  ];
  const input = definitions.slice().reverse().map(([id, description]) => row(id, description));
  const statistics = Object.fromEntries(definitions.map(([id]) => [id, stat(.5)]));
  assert.deepEqual(ids(rankAugmentCandidates(input, {statistics})), definitions.map(([id]) => id));
  const fixed = [
    ['highFlatAttackDamage','获得80攻击力。'], ['flatPenetration','获得20穿甲和20法术穿透。'],
    ['attackDamage','获得20攻击力。'], ['health','获得100生命值。'], ['shield','获得100护盾。'],
  ];
  assert.deepEqual(ids(rankAugmentCandidates(fixed.slice().reverse().map(([id, description]) => row(id, description)), {
    statistics:Object.fromEntries(fixed.map(([id]) => [id, stat(.5)])),
  })), fixed.map(([id]) => id));
});

test('percentage AD takes precedence over high flat AD and the high threshold is configurable', () => {
  const result = rankAugmentCandidates([row('flat', '获得80攻击力。'), row('percentage', '获得20%攻击力。')], {
    statistics:statMap([['flat', .5], ['percentage', .5]]),
  });
  assert.deepEqual(ids(result), ['percentage', 'flat']);
  assert.deepEqual(classifyAugmentPolicy({description:'获得59攻击力。'}).numericKinds, ['attackDamage']);
  assert.deepEqual(classifyAugmentPolicy({description:'获得60攻击力。'}).numericKinds, ['highFlatAttackDamage']);
  assert.deepEqual(classifyAugmentPolicy({description:'获得60攻击力。'}, {policy:{highFlatAttackDamage:80}}).numericKinds, ['attackDamage']);
  assert.deepEqual(classifyAugmentPolicy({description:'获得20%攻击力。'}).numericKinds, ['percentAttackDamage']);
});

test('classification uses actual grant descriptions, and leaves unmodeled effects unknown', () => {
  assert.equal(classifyAugmentPolicy({name:'技能暴击复活', description:''}).category, 'unknown');
  assert.equal(classifyAugmentPolicy({description:'效果资料待补充。'}).category, 'unknown');
  assert.equal(classifyAugmentPolicy({description:'获得〔数值待核实〕法术强度。'}).category, 'unknown');
  assert.equal(classifyAugmentPolicy({description:'每当你击杀英雄时，永久获得10攻击力。'}).category, 'scaling-percent');
  assert.equal(classifyAugmentPolicy({description:'将额外攻击力转化为法术强度。获得15%法术强度。'}).category, 'mechanical');
  assert.deepEqual(classifyAugmentPolicy({description:'无法获得全能吸血。'}).numericKinds, []);
  assert.deepEqual(classifyAugmentPolicy({description:'敌人获得20攻击力。'}).numericKinds, []);
  assert.deepEqual(classifyAugmentPolicy({description:'造成100物理伤害。'}).numericKinds, []);
  const shield = classifyAugmentPolicy({description:'获得相当于20%最大生命值的护盾。'});
  assert.ok(!shield.numericKinds.includes('health'), 'shield scaling is not a health grant');
  assert.ok(shield.numericKinds.includes('shield'));
  const duration = classifyAugmentPolicy({description:'获得持续10秒的护盾和全能吸血。'});
  assert.equal(duration.category, 'unknown', 'a duration is not a known flat stat amount');
});

test('hard conflicts, owned, retired, internal and ineligible definitions are removed before win rates', () => {
  const input = [row('good', '获得10生命值。'), row('conflict', '获得20攻击力。', 100, {conflicts:['cannot attack']}),
    row('owned', '获得20攻击力。'), row('banned', '获得20攻击力。', 100, {eligible:false}),
    {...row('retired', ''), augment:{id:'retired', retiredPatch:'26.20'}},
    {...row('internal', ''), augment:{id:'internal', isInternalTemplate:true}},
    {...row('notCurrent', ''), augment:{id:'notCurrent', availability:'catalog-only'}},
    {...row('special', ''), augment:{id:'special', recommendable:false}},
  ];
  assert.deepEqual(ids(rankAugmentCandidates(input, {owned:['owned'], statistics:Object.fromEntries(input.map(entry => [entry.augment.id, stat(.99)]))})), ['good']);
});

test('a no-mana hero rejects pure mana, but retains meaningful hybrid or conversion effects', () => {
  const input = [row('mana', '获得1000法力值。'), row('hybrid', '获得100法力值和100生命值。'),
    row('convert', '将法力值转化为生命值。'), row('shield', '基于最大法力值获得护盾。')];
  assert.deepEqual(ids(rankAugmentCandidates(input, {champion:manalessHero})).sort(), ['convert', 'hybrid', 'shield']);
  assert.equal(rankAugmentCandidates(input, {champion:manaHero}).length, 4);
  assert.equal(rankAugmentCandidates(input, {champion:{id:'Unknown'}}).length, 4);
});

test('known no-attack and no-crit owned effects filter required interactions, not all AD/AP', () => {
  const input = [row('onhit', '你的普攻会灼烧敌人。'), row('adSpell', '获得20攻击力。'),
    row('ap', '获得20法术强度。'), row('crit', '获得20%暴击几率。'), row('spellCrit', '你的技能可以暴击。')];
  const owned = [{id:'noAttack', description:'你无法进行普通攻击。'}, {id:'noCrit', description:'你的伤害无法暴击。'}];
  assert.deepEqual(ids(rankAugmentCandidates(input, {owned})).sort(), ['adSpell', 'ap']);
  assert.equal(rankAugmentCandidates(input, {champion:{id:'Mage', tags:['Mage']}}).length, input.length,
    'a role alone must not invent an AD scaling prohibition');
});

test('reviewed champion exceptions and augmentation overrides are JSON extension points', () => {
  const policy = JSON.parse(JSON.stringify({championOverrides:{FixtureMana:{
    excludedNumericKinds:['lifeSteal'], excludedAugmentIds:['deny'],
    numericPriority:['health', 'omnivamp'],
    augmentOverrides:{special:{category:'mechanical', numericKinds:[], reason:'reviewed fixture interaction'}},
  }}}));
  const input = [row('lifeSteal', '获得15%生命偷取。'), row('deny', '获得15%全能吸血。'),
    row('special', '无法离线推导的效果。'), row('health', '获得20%最大生命值。'), row('omnivamp', '获得15%全能吸血。')];
  assert.deepEqual(ids(rankAugmentCandidates(input, {champion:manaHero, policy,
    statistics:Object.fromEntries(input.map(entry => [entry.augment.id, stat(.5)])),
  })), ['special', 'health', 'omnivamp']);
  assert.match(classifyAugmentPolicy(input[2].augment, {champion:manaHero, policy}).categoryEvidence, /reviewed-override/);
  assert.equal(classifyAugmentPolicy({id:'x', description:''}, {policy:{augmentOverrides:{x:{category:'mechanical'}}}}).category, 'unknown',
    'an unreviewed override without a reason is ignored');
});

test('selection rate is a final tie breaker and never replaces missing win-rate evidence', () => {
  const input = [row('low', '获得20攻击力。'), row('high', '获得20攻击力。')];
  const statistics = statMap([['low', .5, {pickRate:.01}], ['high', .5, {pickRate:.8}]]);
  assert.deepEqual(ids(rankAugmentCandidates(input, {statistics})), ['high', 'low']);
  assert.deepEqual(ids(rankAugmentCandidates(input, {statistics, policy:{pickRateOrder:'lower-first'}})), ['low', 'high']);
  assert.deepEqual(ids(rankAugmentCandidates([input[0], {...input[1], mechanismScore:49}], {statistics})), ['low', 'high']);
  const noWin = rankAugmentCandidates(input, {statistics:{low:{pickRate:.01}, high:{pickRate:.8}}});
  assert.ok(noWin.every(entry => entry.rankingEvidence.basis === 'mechanism-fallback' && entry.rankingEvidence.winRate === null));
  assert.deepEqual(ids(noWin), ['low', 'high'], 'noncomparable picks are not silently imported as a current preference');
});

test('no input, source or policy objects are mutated and unrelated row metadata survives', () => {
  const rows = [row('a', '获得20攻击力。', 70, {custom:{label:'keep'}, reason:'original'})];
  const statistics = {a:stat(.5)}, policy = {statisticsPatch:'16.21'};
  const before = JSON.stringify({rows, statistics, policy});
  const [result] = rankAugmentCandidates(rows, {statistics, policy});
  assert.equal(JSON.stringify({rows, statistics, policy}), before);
  assert.equal(result.augment, rows[0].augment);
  assert.equal(result.custom, rows[0].custom);
  assert.equal(result.reason, 'original');
  assert.notEqual(result, rows[0]);
});

test('malformed containers fail conservatively without throwing or fabricating scores', () => {
  assert.deepEqual(rankAugmentCandidates(null), []);
  assert.deepEqual(rankAugmentCandidates([null, {}, {augment:null}]), []);
  const [result] = rankAugmentCandidates([row('unknown', undefined, undefined)], {policy:{closeWinRateGap:'1', minSampleCount:-1}});
  assert.equal(result.rankingEvidence.closeWinRateGap, .01);
  assert.equal(result.rankingEvidence.minSampleCount, 200);
  assert.equal(result.rankingEvidence.winRate, null);
  assert.equal(result.rankingEvidence.category, 'unknown');
});

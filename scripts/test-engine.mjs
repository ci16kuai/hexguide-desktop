import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Import from a data URL so these browser ES modules need no package.json.
const source = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
const {enrichData, getChampionTags, getSynergy, recommend} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const augment = (id, description, extra = {}) => ({id, name: id, description, ...extra});
const attack = augment('快速攻击', '获得 35% 攻击速度。');
const power = augment('法术力量', '获得 80 法术强度和 20 技能急速。');
const ward = augment('稳健成长', '获得 10 攻击力和 300 生命值。');
const caitlyn = {id: 'Caitlyn', name: '凯特琳', roles: ['Marksman']};
const lux = {id: 'Lux', name: '拉克丝', roles: ['Mage', 'Support']};

// Champion context must reverse the ranking, rather than cosmetic text changes.
assert.ok(recommend(attack, caitlyn).score > recommend(power, caitlyn).score);
assert.ok(recommend(power, lux).score > recommend(attack, lux).score);

// Existing choices can reverse a close ranking through a real output→trigger relation.
const onHit = augment('攻击治疗', '你的每次普攻都会治疗自身 10 生命值。');
const healProc = augment('治疗奖励', '每当你治疗时，获得一个护盾。');
assert.ok(recommend(ward, caitlyn).score > recommend(healProc, caitlyn).score);
assert.ok(recommend(healProc, caitlyn, [onHit]).score > recommend(ward, caitlyn, [onHit]).score);
assert.equal(getSynergy(onHit, healProc).level, 'conditional');
assert.match(getSynergy(onHit, healProc).chain, /治疗/);

// Explicit route choice changes a neutral champion's recommended ranking.
const neutral = {id: 'Unknown', name: '未知英雄', roles: []};
assert.ok(recommend(attack, neutral, [], 'attack').score > recommend(power, neutral, [], 'attack').score);
assert.ok(recommend(power, neutral, [], 'spell').score > recommend(attack, neutral, [], 'spell').score);

// Exact duplicates and explicit prohibitions are consequential, not hidden caveats.
assert.equal(recommend(attack, caitlyn, [attack]).score, 0);
assert.equal(getSynergy(attack, attack).level, 'conflict');
const noAttacks = augment('无法攻击', '你无法进行普攻，获得法术强度。');
assert.equal(getSynergy(noAttacks, onHit).level, 'conflict');
assert.ok(recommend(onHit, caitlyn, [noAttacks]).score < recommend(onHit, caitlyn).score);

// A shared label alone must never create a claimed combo.
assert.equal(getSynergy(attack, augment('攻速二', '获得 20% 攻击速度。')).level, 'unknown');
assert.equal(getSynergy(augment('金币', '获得 500 金币。'), power).level, 'unknown');
assert.equal(recommend(augment('未知', '神秘效果。'), neutral).confidence, 'unknown');
assert.equal(recommend({id: 'name-only', name: '暴击飞弹', tags: ['cc']}, lux).confidence, 'unknown');
assert.deepEqual(enrichData({augments: [{id: 'name-only', name: '暴击飞弹'}]}).augments[0].tags, []);
assert.equal(getSynergy(null, power).evidence, 'unknown');

// Specific effect chains and false-friend control distinctions.
const burn = augment('火焰', '你的普攻附带灼烧效果。');
const burnPayoff = augment('火上浇油', '你对正在灼烧的敌人伤害提高。');
assert.equal(getSynergy(burn, burnPayoff).level, 'conditional');
const slow = augment('减速', '你的技能造成减速。');
const immobilizeProc = augment('定身奖励', '每当你定身敌人时，治疗自身。');
assert.equal(getSynergy(slow, immobilizeProc).level, 'unknown');

// Data enrichment is non-mutating and preserves the authentic effect text.
const original = {meta: {}, champions: [lux], augments: [attack], combos: []};
const before = JSON.stringify(original);
const enriched = enrichData(original);
assert.equal(JSON.stringify(original), before);
assert.equal(enriched.augments[0].description, attack.description);
assert.ok(enriched.augments[0].tags.includes('attackSpeed'));
assert.ok(enriched.augments[0].mechanismNote.includes('推导'));
assert.ok(getChampionTags({id: 'Vladimir', roles: ['Mage']}).includes('noMana'));
assert.ok(!getChampionTags({id: 'Vladimir', roles: ['Mage']}).includes('mana'));
const manaAugment = augment('法力成长', '获得 500 法力值。');
for (const hero of [
  {id: 'Mordekaiser', roles: ['Fighter', 'Mage'], resource: '护盾'},
  {id: 'Rumble', roles: ['Fighter', 'Mage'], resource: '热量'},
  {id: 'LeeSin', roles: ['Fighter', 'Assassin'], resource: '能量'}
]) {
  assert.ok(!getChampionTags(hero).includes('mana'));
  assert.ok(getChampionTags(hero).includes('noMana'));
  assert.ok(recommend(manaAugment, hero).cautions.some(note => note.includes('不使用法力')));
  assert.ok(recommend(manaAugment, hero).score < recommend(manaAugment, {id: 'Ryze', roles: ['Mage'], resource: '法力'}).score);
}
assert.ok(getChampionTags({id: 'Ryze', roles: ['Mage'], resource: '法力'}).includes('mana'));
// An authoritative resource also overrides a stale fallback noMana label.
assert.ok(!getChampionTags({id: 'Vladimir', roles: ['Mage'], resource: 'Mana'}).includes('noMana'));
assert.ok(getChampionTags({id: 'Belveth', roles: ['Fighter'], resource: ''}).includes('noMana'));

// Verify real source phrasing, including "trigger" phrases that grant no shield.
const realData = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const byId = id => realData.augments.find(item => item.id === id);
assert.equal(getSynergy(byId('firebrand'), byId('infernal_conduit')).level, 'conditional');
assert.equal(getSynergy(byId('firebrand'), byId('grandmas_chili_oil')).level, 'conditional');
assert.equal(getSynergy(byId('holy_fire'), byId('infernal_conduit')).level, 'conditional');
assert.equal(getSynergy(byId('its_critical'), byId('jeweled_gauntlet')).level, 'conditional');
const realEnriched = enrichData(realData);
// Client descriptions now contain explicit placeholders for unresolved runtime
// values. The 时 in 运行时 is metadata, not a "when applied" trigger suffix.
assert.ok(realEnriched.augments.find(item => item.id === 'firebrand').effects.includes('burn'));
assert.ok(realEnriched.augments.find(item => item.id === 'infernal_conduit').triggers.includes('burn'));
assert.ok(realEnriched.augments.find(item => item.id === 'holy_fire').effects.includes('burn'));
const runtimePlaceholder = enrichData({augments: [augment('运行时占位', '你的攻击会施加一层灼烧〔运行时内容待核实〕，持续造成伤害。')]}).augments[0];
assert.ok(runtimePlaceholder.effects.includes('burn'));
assert.ok(!realEnriched.augments.find(item => item.id === 'mighty_shield').effects.includes('shield'));
assert.ok(!realEnriched.augments.find(item => item.id === 'magic_missile').tags.includes('health'));
assert.ok(!realEnriched.augments.find(item => item.id === 'critical_missile').tags.includes('cc'));
assert.ok(!getChampionTags(realData.champions.find(item => item.id === 'Mordekaiser')).includes('physical'));
const casterPurist = realEnriched.augments.find(item => item.id === 'purist___caster');
assert.ok(!casterPurist.effects.includes('attackFrequency'));
assert.ok(casterPurist.effects.includes('spellFrequency'));
assert.ok(casterPurist.tags.includes('haste'));
assert.equal(getSynergy(casterPurist, byId('typhoon')).level, 'unknown');
const clauseBoundary = enrichData({augments: [augment('句界', '获得 20 技能急速，你的所有攻速转换为法术强度。')]}).augments[0];
assert.ok(!clauseBoundary.effects.includes('attackFrequency'));
const conversionInput = enrichData({augments: [augment('转换输入', '获得 10 攻击力并把你的攻速转换为法术强度。')]}).augments[0];
assert.ok(!conversionInput.effects.includes('attackFrequency'));
const firstAid = realEnriched.augments.find(item => item.id === 'first_aid_kit');
assert.ok(!firstAid.effects.includes('heal'));
assert.ok(!firstAid.effects.includes('shield'));
for (const id of ['swift_and_safe', 'big_brain']) {
  const shieldSource = realEnriched.augments.find(item => item.id === id);
  assert.ok(shieldSource.effects.includes('shield'));
  assert.ok(!shieldSource.triggers.includes('shield'));
  assert.equal(getSynergy(firstAid, shieldSource).level, 'unknown');
  assert.equal(getSynergy(shieldSource, byId('mighty_shield')).level, 'conditional');
}
for (const id of ['Mordekaiser', 'Rumble', 'LeeSin', 'Belveth']) {
  const hero = realData.champions.find(item => item.id === id);
  assert.ok(Object.prototype.hasOwnProperty.call(hero, 'resource'));
  assert.ok(getChampionTags(hero).includes('noMana'));
  assert.ok(!getChampionTags(hero).includes('mana'));
  assert.ok(recommend(manaAugment, hero).cautions.some(note => note.includes('不使用法力')));
}
assert.ok(getChampionTags(realData.champions.find(item => item.id === 'Ryze')).includes('mana'));
for (const item of realEnriched.augments) {
  const result = recommend(item, lux, [byId('firebrand')]);
  assert.ok(Number.isFinite(result.score) && result.score >= 0 && result.score <= 100);
  assert.equal(item.description, byId(item.id).description);
  if (item.retiredPatch) assert.equal(result.score, 0);
}
console.log(`PASS: context ranking, route changes, conflicts, duplicates, unknowns, real effect chains, and all ${realData.augments.length} source descriptions.`);

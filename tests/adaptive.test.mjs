import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildLivePlan, describeEnemies, shortEquipmentEffect} from '../dist/adaptive.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const champion = id => data.champions.find(hero => hero.id === id);
const augment = id => data.augments.find(entry => entry.id === id);
const live = (id, extra = {}) => ({connection: {status: 'connected'}, phase: 'InProgress', championId: id, level: 8, gameTime: 200, stats: {}, items: [], augments: {status: 'unavailable'}, mode: {known: true, isMayhem: true, queueId: 2400}, ...extra});
const NOW = Date.now();
const teams = (enemies, extra = {}) => ({status: 'detected', ownTeam: 'ORDER', allies: [], enemies, observedAt: new Date(NOW).toISOString(), ...extra});
const opponent = (championId, ids = []) => ({championId, level: 12, items: ids.map(id => ({id, count: 1}))});
const plan = (id, extra = {}) => buildLivePlan({champion: champion(id), champions: data.champions, itemsCatalog, augments: data.augments, live: live(id), now: NOW, ...extra});

test('catalog preserves map flags and mode-specific entries with official provenance', () => {
  assert.equal(itemsCatalog.meta.version, '16.21.1');
  assert.equal(itemsCatalog.meta.sourceUrl, 'https://ddragon.leagueoflegends.com/cdn/16.21.1/data/zh_CN/item.json');
  assert.ok(Object.keys(itemsCatalog.data).length > 800);
  assert.ok(Object.values(itemsCatalog.data).some(item => item.maps['30'] === true && item.maps['12'] !== true));
  assert.match(itemsCatalog.data['3116'].description, /伤害型技能.*减速/s);
});

test('different hero mechanics produce different options rather than a generic build', () => {
  const mage = plan('Ahri');
  const marksman = plan('Jinx');
  const healer = plan('Sona');
  assert.equal(mage.choices[0].id, 'spell');
  assert.equal(marksman.choices[0].id, 'attack');
  assert.equal(healer.choices[0].id, 'support');
  assert.ok(!mage.choices.some(choice => choice.id === 'attack'));
  assert.ok(!marksman.choices.flatMap(choice => choice.items).some(item => item.id === '3089'));
  assert.ok(plan('Gwen').choices.some(choice => choice.items.some(item => item.id === '3115')));
});

test('confirmed augments change route ordering and explain the actual trigger', () => {
  const base = plan('Gwen');
  const onHit = plan('Gwen', {owned: ['firebrand']});
  assert.notEqual(base.choices[0].id, onHit.choices[0].id);
  assert.equal(onHit.choices[0].id, 'attack');
  assert.match(onHit.choices[0].why.join(' '), /火上浇油/);
  const health = plan('Ahri', {owned: [augment('goliath')]});
  assert.ok(health.choices.some(choice => choice.id === 'tank'));
  assert.match(health.context.join(' '), /歌利亚巨人/);
});

test('current items prevent duplicate suggestions and explain existing investment', () => {
  const before = plan('Ahri');
  assert.ok(before.choices.flatMap(choice => choice.items).some(item => item.id === '3089'));
  const after = plan('Ahri', {live: live('Ahri', {items: [{id: 3089, name: 'Hat', count: 1}], stats: {abilityPower: 300}})});
  assert.ok(after.choices.flatMap(choice => choice.items).every(item => item.id !== '3089'));
  assert.match(after.context.join(' '), /灭世者的死亡之帽/);
  assert.match(after.choices[0].why.join(' '), /已有法强装备/);
  assert.match(after.choices[0].why.join(' '), /300/);
});

test('levels and elapsed time change stage guidance without fabricating damage', () => {
  const early = plan('Ahri');
  const late = plan('Ahri', {live: live('Ahri', {level: 18, gameTime: 1100, currentGold: 1700})});
  assert.match(early.choices[0].why.join(' '), /保留转型空间/);
  assert.match(late.choices[0].why.join(' '), /延续已有装备和海克斯/);
  assert.match(late.context.join(' '), /18 级.*18:20/);
  assert.match(late.choices[0].watch.join(' '), /1700/);
});

test('stale snapshots from a different champion cannot alter recommendations', () => {
  const result = plan('Ahri', {live: live('Jinx', {items: [{id: 3089, count: 1}], stats: {abilityPower: 999}})});
  assert.equal(result.confidence, 'mechanism');
  assert.ok(result.choices.flatMap(choice => choice.items).some(item => item.id === '3089'));
  assert.doesNotMatch(JSON.stringify(result), /999/);
});

test('unconfirmed API or OCR augments are not silently adopted', () => {
  const result = plan('Gwen', {live: live('Gwen', {augments: {status: 'ocr-proposal', ids: ['firebrand']}})});
  assert.doesNotMatch(result.context.join(' '), /已确认海克斯：火上浇油/);
  assert.match(result.context.join(' '), /识别草稿/);
  assert.notEqual(result.choices[0].id, 'attack');
});

test('explicit mechanical restrictions remove incompatible outputs', () => {
  const noCrit = plan('Jinx', {owned: [{id: 'no-crit-test', name: '不能暴击', description: '你的伤害不能暴击。获得100攻击速度。'}]});
  assert.ok(noCrit.choices.flatMap(choice => choice.items).every(item => item.id !== '3031'));
  assert.match(noCrit.context.join(' '), /无法暴击/);
  const noAttack = plan('Jinx', {owned: [{id: 'no-attack-test', name: '不能普攻', description: '你无法进行普通攻击。'}]});
  assert.ok(noAttack.choices.every(choice => choice.id !== 'attack'));
});

test('mode and waiting states remain explicit and manual routes stay choices', () => {
  assert.equal(buildLivePlan().choices.length, 0);
  assert.equal(plan('Ahri', {live: live('Ahri', {mode: {known: true, isMayhem: false}})}).choices.length, 0);
  const result = plan('Sona', {route: 'spell'});
  assert.equal(result.choices[0].id, 'spell');
  assert.ok(result.choices.some(choice => choice.id === 'support'));
  assert.ok(result.choices.length >= 2 && result.choices.length <= 3);
  assert.match(result.label, /机制建议/);
});

test('visible opponent resistance purchases change the matching damage route only', () => {
  const armor = teams([opponent('Ornn', ['3068'])]);
  const mr = teams([opponent('Ornn', ['3065'])]);
  const physicalArmor = plan('Jinx', {live: live('Jinx', {teams: armor})});
  const physicalMr = plan('Jinx', {live: live('Jinx', {teams: mr})});
  const magicArmor = plan('Ahri', {live: live('Ahri', {teams: armor})});
  const magicMr = plan('Ahri', {live: live('Ahri', {teams: mr})});
  assert.equal(physicalArmor.buildItems[0].id, '3036');
  assert.ok(!physicalMr.buildItems.some(item => item.id === '3036'));
  assert.ok(!magicArmor.buildItems.some(item => item.id === '3135' || item.id === '3036'));
  assert.ok(magicMr.buildItems.some(item => item.id === '3135'));
  assert.match(physicalArmor.buildItems[0].reason, /奥恩.*日炎圣盾.*护甲装备/);
  assert.match(magicMr.buildItems.find(item => item.id === '3135').reason, /不代表已测得其总魔抗/);
  assert.equal(physicalArmor.enemyContext.champions[0].id, 'Ornn');
});

test('healing counter options require known combat healing or visible lifesteal conditions', () => {
  const soraka = teams([opponent('Soraka')]);
  assert.equal(plan('Ahri', {live: live('Ahri', {teams: soraka})}).buildItems[0].id, '3165');
  assert.equal(plan('Jinx', {live: live('Jinx', {teams: soraka})}).buildItems[0].id, '3033');
  const visibleLifesteal = plan('Ahri', {live: live('Ahri', {teams: teams([opponent('Jinx', ['3153'])])})});
  assert.ok(visibleLifesteal.enemyContext.signals.some(signal => signal.id === 'healing'));
  assert.equal(visibleLifesteal.buildItems[0].id, '3165');
  const warmogOnly = plan('Ahri', {live: live('Ahri', {teams: teams([opponent('Ornn', ['3083'])])})});
  assert.ok(!warmogOnly.enemyContext.signals.some(signal => signal.id === 'healing'));
  assert.ok(!warmogOnly.buildItems.some(item => item.id === '3165'));
  assert.match(warmogOnly.buildItems.find(item => item.id === '6653').reason, /未推算目标血量/);
});

test('stale missing disconnected and mismatched enemy snapshots never contribute old opponents', () => {
  const old = teams([opponent('Soraka', ['3065'])]);
  const cases = [
    live('Ahri', {teams: {...old, status: 'unavailable'}}),
    live('Ahri', {teams: {...old, observedAt: new Date(NOW - 31_000).toISOString()}}),
    live('Ahri', {teams: {...old, observedAt: ''}}),
    live('Ahri', {teams: {...old, observedAt: new Date(NOW + 20_000).toISOString()}}),
    live('Ahri', {teams: old, connection: {status: 'disconnected'}}),
    live('Jinx', {teams: old})
  ];
  for (const snapshot of cases) {
    const result = plan('Ahri', {live: snapshot});
    assert.notEqual(result.enemyContext.status, 'detected');
    assert.deepEqual(result.enemyContext.signals, []);
    assert.deepEqual(result.enemyContext.champions, []);
    assert.ok(!result.buildItems.some(item => ['3135', '3165'].includes(item.id)));
    assert.doesNotMatch(JSON.stringify(result), /索拉卡|振奋盔甲/);
  }
});

test('opponent mechanism clues remain explanations instead of measured damage or hidden stats', () => {
  const result = plan('Ahri', {live: live('Ahri', {teams: teams([opponent('Annie', ['3089']), opponent('Lux', ['3089'])])})});
  assert.ok(result.enemyContext.signals.some(signal => signal.id === 'magic-mechanisms'));
  assert.ok(result.buildItems.some(item => item.id === '3102' && /未测量本局魔法伤害占比/.test(item.reason)));
  assert.match(result.enemyContext.signals.find(signal => signal.id === 'magic-mechanisms').reason, /不代表本局实际伤害占比/);
  const unknown = describeEnemies({champion: champion('Ahri'), live: live('Ahri', {teams: teams([opponent('UnknownEnemy')])}), champions: data.champions, itemsCatalog, now: NOW});
  assert.equal(unknown.status, 'detected');
  assert.deepEqual(unknown.signals, []);
  assert.deepEqual(unknown.champions[0].tags, []);
});

test('recommended equipment has official effects and excludes owned or incompatible shop entries', () => {
  const current = live('Ahri', {items: [{id: '3135', count: 1}], teams: teams([opponent('Ornn', ['3065'])])});
  const result = plan('Ahri', {live: current});
  assert.ok(!result.buildItems.some(item => item.id === '3135'));
  assert.ok(result.buildItems.length > 0);
  for (const item of result.buildItems) {
    assert.equal(item.name, itemsCatalog.data[item.id].name);
    assert.equal(item.icon, itemsCatalog.data[item.id].icon);
    assert.ok(item.effect && item.effect.length <= 100);
    assert.equal(item.sourceUrl, itemsCatalog.meta.sourceUrl);
    assert.equal(item.catalogVersion, '16.21.1');
  }
  const altered = structuredClone(itemsCatalog);
  altered.data['3165'].maps['12'] = false;
  altered.data['3089'].requiredChampion = 'Ornn';
  altered.data['3116'].gold.purchasable = false;
  altered.data['3102'].inStore = false;
  const filtered = plan('Ahri', {itemsCatalog: altered, live: live('Ahri', {teams: teams([opponent('Soraka'), opponent('Lux')])})});
  assert.ok(!filtered.buildItems.some(item => ['3165', '3089', '3116', '3102'].includes(item.id)));
  assert.doesNotMatch(shortEquipmentEffect('造成{{unresolved}}魔法伤害。\n获得0秒护盾。\n50法术强度'), /{{|0秒/);
});

test('future augment suggestions exclude confirmed retired internal and mechanically forbidden entries', () => {
  const fixtures = [augment('recursion'), augment('firebrand'), augment('thread_the_needle'),
    {id: 'retired-test', name: '旧条目', description: '获得100技能急速。', retiredPatch: '26.1'},
    {id: 'internal-test', name: '内部模板', description: '获得100技能急速。', isInternalTemplate: true},
    {id: 'headliner-test', name: '特殊奖励', description: '获得100技能急速。', recommendable: false},
    {id: 'crit-test', name: '暴击候选', description: '获得50%暴击几率。'}];
  const noCrit = {id: 'no-crit', name: '禁暴击', description: '你的伤害不能暴击。'};
  const noAttack = {id: 'no-attack', name: '禁普攻', description: '你无法进行普通攻击。'};
  const result = plan('Ahri', {owned: ['recursion', noCrit, noAttack], augments: fixtures});
  assert.ok(result.nextAugments.length > 0 && result.nextAugments.length <= 6);
  assert.ok(result.nextAugments.every(augment => !['recursion', 'retired-test', 'internal-test', 'headliner-test', 'firebrand', 'crit-test'].includes(augment.id)));
  assert.ok(result.nextAugments.every(augment => augment.cautions.some(note => /不预测下轮出现/.test(note))));
  const restrictedBuild = plan('Jinx', {owned: [noCrit], live: live('Jinx', {teams: teams([opponent('Ornn', ['3068'])])})});
  assert.equal(restrictedBuild.buildItems[0].id, '6694');
  assert.ok(restrictedBuild.buildItems.every(item => !itemsCatalog.data[item.id].tags.includes('CriticalStrike')));
  const noAttackBuild = plan('Gwen', {owned: [noAttack], live: live('Gwen', {teams: teams([opponent('Ornn', ['3068'])])})});
  assert.ok(noAttackBuild.buildItems.every(item => !['3115', '3153'].includes(item.id)));
});

test('confirmed augments and current enemy conditions each alter the explainable next list', () => {
  const shortlist = [augment('recursion'), augment('thread_the_needle'), augment('critical_rhythm')];
  const base = plan('Jinx', {augments: shortlist});
  const armor = plan('Jinx', {augments: shortlist, live: live('Jinx', {teams: teams([opponent('Ornn', ['3068'])])})});
  assert.ok(armor.nextAugments.find(a => a.id === 'thread_the_needle').rank < base.nextAugments.find(a => a.id === 'thread_the_needle').rank);
  assert.match(armor.nextAugments.find(a => a.id === 'thread_the_needle').reason, /敌方对应抗性装备/);
  const confirmed = plan('Jinx', {augments: shortlist, owned: ['thread_the_needle']});
  assert.ok(confirmed.nextAugments.every(a => a.id !== 'thread_the_needle'));
  assert.deepEqual(buildLivePlan().nextAugments, []);
  const wrongMode = plan('Jinx', {live: live('Jinx', {mode: {known: true, isMayhem: false}, teams: teams([opponent('Soraka')])})});
  assert.deepEqual(wrongMode.buildItems, []);
  assert.deepEqual(wrongMode.nextAugments, []);
  assert.equal(wrongMode.enemyContext.status, 'unavailable');
});

test('future choices use current availability and keep missing-field mechanism fixtures compatible', () => {
  const fixtures = [
    {id: 'current', name: '当前', description: '获得60技能急速。', availability: 'current'},
    {id: 'no-field', name: '兼容测试项', description: '获得50技能急速。'},
    ...['catalog-only', 'historical', 'retired', 'unknown', ''].map(availability => ({id: `not-current-${availability}`, name: '非当前', description: '获得100技能急速。', availability}))
  ];
  const result = plan('Ahri', {augments: fixtures});
  assert.deepEqual(new Set(result.nextAugments.map(a => a.id)), new Set(['current', 'no-field']));
  const real = plan('Ahri');
  assert.ok(real.nextAugments.every(candidate => augment(candidate.id).availability === 'current'));
});

test('cannot attack excludes own attack effects while retaining enemy-attack defensive triggers', () => {
  const noAttack = {id: 'no-attack', name: '禁普攻', description: '你无法进行普通攻击。'};
  const catalog = structuredClone(itemsCatalog);
  // The same defensive trigger can use either 攻击 or 普通攻击 in official
  // localized text; neither requires the holder to perform that attack.
  catalog.data['3075'].description = '150生命值\n75护甲\n在被一次普通攻击命中后，对攻击者造成魔法伤害，并对其施加重伤效果。';
  const result = plan('Ornn', {owned: [noAttack], itemsCatalog: catalog, live: live('Ornn', {teams: teams([opponent('Jinx', ['3153'])])})});
  const thorns = result.buildItems.find(item => item.id === '3075');
  assert.ok(thorns, 'being unable to attack does not prevent retaliatory armor from triggering');
  assert.match(thorns.reason, /被敌方攻击命中/);
  assert.ok(result.choices.every(choice => choice.id !== 'attack'));
  assert.ok(result.buildItems.every(item => !['3115', '3153'].includes(item.id)));
  // Missing item tags must not make an explicit self-attack effect compatible.
  catalog.data['3068'].tags = ['Armor', 'Health'];
  catalog.data['3068'].description = '你的普通攻击会造成额外魔法伤害。';
  const ownTrigger = plan('Ornn', {owned: [noAttack], itemsCatalog: catalog});
  assert.ok(ownTrigger.buildItems.every(item => item.id !== '3068'));
});

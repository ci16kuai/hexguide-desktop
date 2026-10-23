import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildLivePlan} from '../dist/adaptive.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const champion = id => data.champions.find(hero => hero.id === id);
const augment = id => data.augments.find(entry => entry.id === id);
const live = (id, extra = {}) => ({connection: {status: 'connected'}, phase: 'InProgress', championId: id, level: 8, gameTime: 200, stats: {}, items: [], augments: {status: 'unavailable'}, mode: {known: true, isMayhem: true, queueId: 2400}, ...extra});
const plan = (id, extra = {}) => buildLivePlan({champion: champion(id), itemsCatalog, augments: data.augments, live: live(id), ...extra});

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

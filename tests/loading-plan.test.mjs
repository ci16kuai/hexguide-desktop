import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildLivePlan, describeEnemies} from '../dist/adaptive.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-10-24T03:00:00.000Z');
const hero = id => data.champions.find(champion => champion.id === id);
const enemy = (championId, ids = []) => ({championId, level: 18, items: ids.map(id => ({id, count: 1}))});
const loading = (id = 'Ahri', extra = {}) => ({
  connection: {status: 'connected'}, stage: 'loading', phase: 'GameStart',
  championId: id, championSource: 'loading-screen', gameId: 'new-game',
  mode: {known: true, isMayhem: true, queueId: 2400},
  teams: {status: 'detected', source: 'loading-roster', ownTeam: 'ORDER', allies: [],
    enemies: [enemy('Soraka'), enemy('Ornn')], observedAt: new Date(now).toISOString()},
  ...extra
});
const plan = (snapshot = loading(), extra = {}) => buildLivePlan({
  champion: hero(snapshot.championId), champions: data.champions,
  augments: data.augments, itemsCatalog, live: snapshot, now, ...extra
});

test('a fresh real loading roster provides a labelled hero-and-lineup preset before live API', () => {
  const result = plan();
  assert.equal(result.stage, 'loading-preview');
  assert.equal(result.label, '开局前预览');
  assert.equal(result.confidence, 'mechanism-with-roster');
  assert.equal(result.enemyContext.status, 'detected');
  assert.equal(result.enemyContext.source, 'loading-roster');
  assert.match(result.enemyContext.summary, /仅依据阵容机制预设.*尚未读取装备、等级或实战面板/);
  assert.equal(result.buildItems[0].id, '3165', 'known healing mechanisms are useful before purchases');
  assert.ok(result.buildItems.some(item => item.id === '6653'), 'frontline mechanisms provide an opening sustained-damage option');
  assert.ok(result.nextAugments.length > 0);
  assert.ok(result.nextAugments.every(augment => augment.mechanismLabel === '开局海克斯方向'));
  assert.ok(result.nextAugments.every(augment => augment.cautions.some(note => /不预测下轮出现/.test(note))));
  assert.ok(result.enemyContext.champions.every(enemy => enemy.icon && enemy.level === null && enemy.items.length === 0));
  const otherPhase = plan(loading('Ahri', {phase: 'InProgress'}));
  assert.equal(otherPhase.stage, 'loading-preview', 'LCU may enter InProgress before Live Client Data is ready');
});

test('loading presets discard previous-game augments route inventory levels gold and panels', () => {
  const poisoned = loading('Ahri', {
    level: 18, gameTime: 1800, currentGold: 987654, stats: {abilityPower: 999999},
    items: [{id: '3165', count: 1}],
    teams: {...loading().teams, enemies: [enemy('Soraka', ['3065']), enemy('Ornn', ['3068'])]}
  });
  const result = plan(poisoned, {owned: ['goliath', 'firebrand'], route: 'tank'});
  assert.deepEqual(result.buildItems, plan().buildItems);
  assert.deepEqual(result.nextAugments, plan().nextAugments);
  assert.equal(result.choices[0].id, 'spell');
  assert.ok(!result.enemyContext.signals.some(signal => ['armor', 'magic-resist'].includes(signal.id)));
  assert.ok(result.enemyContext.champions.every(enemy => enemy.items.length === 0 && enemy.level === null));
  assert.doesNotMatch(JSON.stringify(result), /987654|999999|18 级|30:00|已确认海克斯：|振奋盔甲|日炎圣盾|你选择的路线/);
  assert.match(result.context.join(' '), /不沿用上一局海克斯或玩法方向/);
});

test('entering the game resumes confirmed augments current items and visible enemy equipment', () => {
  const opening = plan();
  const snapshot = {
    ...loading(), stage: 'live', phase: 'InProgress', championSource: 'live-client',
    level: 8, gameTime: 220, currentGold: 1400, stats: {abilityPower: 120}, items: [{id: '3165', count: 1}],
    teams: {...loading().teams, source: 'live-client', enemies: [enemy('Soraka', ['3065']), enemy('Ornn', ['3068'])]}
  };
  const entered = plan(snapshot);
  const confirmed = plan(snapshot, {owned: ['goliath'], route: 'tank'});
  assert.equal(entered.stage, 'live');
  assert.equal(entered.enemyContext.source, 'live-client');
  assert.ok(entered.enemyContext.signals.some(signal => signal.id === 'magic-resist'));
  assert.ok(entered.buildItems.some(item => item.id === '3135'));
  assert.ok(!entered.buildItems.some(item => item.id === '3165'), 'already bought equipment is no longer suggested');
  assert.ok(opening.buildItems.some(item => item.id === '3165'));
  assert.equal(confirmed.choices[0].id, 'tank');
  assert.match(confirmed.context.join(' '), /已确认海克斯：歌利亚巨人/);
  assert.ok(confirmed.nextAugments.every(augment => augment.id !== 'goliath'));
  assert.notDeepEqual(confirmed.nextAugments, opening.nextAugments);
  assert.match(entered.context.join(' '), /8 级.*3:40.*120/);
});

test('loading never fabricates a lineup preset for stale missing mismatched or unverified rosters', () => {
  const cases = [
    loading('Ahri', {connection: {status: 'disconnected'}}),
    loading('Ahri', {championSource: 'champ-select'}),
    loading('Ahri', {phase: 'Lobby'}),
    loading('Ahri', {mode: {known: false}}),
    loading('Ahri', {mode: {known: true, isMayhem: false}}),
    loading('Ahri', {teams: {...loading().teams, source: 'live-client'}}),
    loading('Ahri', {teams: {...loading().teams, status: 'unavailable'}}),
    loading('Ahri', {teams: {...loading().teams, observedAt: new Date(now - 31_000).toISOString()}}),
    loading('Ahri', {teams: {...loading().teams, observedAt: new Date(now + 6_000).toISOString()}}),
    loading('Ahri', {teams: {...loading().teams, observedAt: ''}}),
    loading('Ahri', {teams: {...loading().teams, enemies: []}}),
    loading('Ahri', {teams: {...loading().teams, enemies: [enemy('UnknownHero')]}})
  ];
  for (const snapshot of cases) {
    const result = plan(snapshot, {owned: ['goliath'], route: 'tank'});
    assert.equal(result.stage, 'waiting');
    assert.deepEqual(result.buildItems, []);
    assert.deepEqual(result.nextAugments, []);
    assert.deepEqual(result.choices, []);
  }
  const mismatch = plan(loading('Jinx'), {champion: hero('Ahri')});
  assert.equal(mismatch.stage, 'waiting');
  assert.deepEqual(mismatch.buildItems, []);
  const noHero = plan(loading(), {champion: undefined});
  assert.equal(noHero.stage, 'waiting');
  assert.deepEqual(noHero.buildItems, []);
  const idle = plan({connection: {status: 'waiting'}, phase: 'None', mode: {known: false}});
  assert.equal(idle.stage, 'waiting');
  assert.deepEqual(idle.buildItems, []);
});

test('a new loading roster replaces the old game even when the same hero is selected again', () => {
  const previous = loading('Ahri', {stage: 'live', championSource: 'live-client', phase: 'InProgress', gameId: 'old-game',
    teams: {...loading().teams, source: 'live-client', enemies: [enemy('Soraka', ['3065'])]}});
  assert.ok(plan(previous).buildItems.some(item => item.id === '3135'));
  const nextGame = loading('Ahri', {gameId: 'next-game', teams: {...loading().teams, enemies: [enemy('Jinx'), enemy('Ashe')]}});
  const result = plan(nextGame, {owned: ['goliath'], route: 'tank'});
  assert.equal(result.stage, 'loading-preview');
  assert.deepEqual(result.enemyContext.champions.map(enemy => enemy.id), ['Jinx', 'Ashe']);
  assert.ok(!result.buildItems.some(item => ['3135', '3165'].includes(item.id)));
  assert.ok(result.buildItems.some(item => item.id === '3157'));
  assert.equal(result.choices[0].id, 'spell');
  assert.doesNotMatch(JSON.stringify(result), /索拉卡|已确认海克斯：/);
});

test('enemy roster-only formatting never reports old purchases even when called directly', () => {
  const result = describeEnemies({champion: hero('Ahri'), live: loading('Ahri', {
    teams: {...loading().teams, enemies: [enemy('Ornn', ['3065', '3068'])]}
  }), champions: data.champions, itemsCatalog, now});
  assert.equal(result.source, 'loading-roster');
  assert.deepEqual(result.champions[0].items, []);
  assert.equal(result.champions[0].level, null);
  assert.ok(!result.signals.some(signal => signal.id === 'armor' || signal.id === 'magic-resist'));
  assert.ok(result.signals.every(signal => signal.itemNames.length === 0));
  assert.doesNotMatch(JSON.stringify(result), /振奋盔甲|日炎圣盾/);
});

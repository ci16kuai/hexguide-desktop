import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveAugmentItemIntents} from '../server/augment-item-intents.mjs';
import {QUEST_ITEM_RULES} from '../dist/item-acquisition.js';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const augment = id => {
  const found = data.augments.find(augment => augment.id === id);
  assert.ok(found, `real catalog augment ${id}`);
  return found;
};
const resolve = (...ids) => resolveAugmentItemIntents({owned:ids.map(augment), itemsCatalog});

test('Sheen is a champion-independent set of current spellblade upgrades, never a forced Trinity purchase', () => {
  const [intent] = resolve('upgrade_sheen');
  assert.equal(intent.kind, 'family');
  assert.deepEqual(new Set(intent.itemIds), new Set(['2510','3078','3100','3508','6662']));
  assert.equal(intent.augmentId, 'upgrade_sheen');
  assert.ok(intent.itemIds.every(id => /咒刃/.test(itemsCatalog.data[id].description)));
  assert.ok(!intent.itemIds.includes('3057'), 'component is not a completed target');
});

for (const [augmentId, itemIds] of [
  ['upgrade_infinity_edge',['3031']], ['upgrade_collector',['6676']],
  ['upgrade_zhonyas',['3157']], ['upgrade_immolate',['3068','6664']],
  ['upgrade_cutlass',['4004']], ['upgrade_deaths_dance',['6333']],
  ['upgrade_hubris',['126697']], ['upgrade_mikaels_blessing',['3222']],
  ['upgrade_stormsurge',['4646']], ['upgrade_thornmail',['3075']],
  ['game_2143',['6610']], ['game_2140',['3074']], ['game_1379',['124011']],
  ['quest_steel_your_heart',['3084']],
]) test(`${augmentId} resolves the catalog's actual current completed item options`, () => {
  const intents = resolve(augmentId);
  assert.equal(intents.length, 1);
  assert.deepEqual(new Set(intents[0].itemIds), new Set(itemIds));
  assert.equal(intents[0].kind, itemIds.length > 1 ? 'family' : 'item');
  assert.ok(intents[0].reason.includes(augment(augmentId).name));
});

test('all catalog equipment upgrades resolve without champion-specific branches', () => {
  const upgrades = data.augments.filter(augment => /^(?:升级|强化)[:：]/.test(augment.name) && augment.id !== 'snowball_upgrade');
  assert.equal(upgrades.length, 14);
  for (const entry of upgrades) assert.ok(resolveAugmentItemIntents({owned:[entry], itemsCatalog}).length, entry.id);
});

test('gold Ravenous upgrade does not activate the separate Ultra Hydra reward quest', () => {
  assert.deepEqual(resolve('game_2140')[0].itemIds, ['3074']);
  for (const rule of QUEST_ITEM_RULES) {
    assert.deepEqual(resolve(rule.augmentId), [], rule.augmentId);
    assert.deepEqual(resolveAugmentItemIntents({owned:[{id:'alias',gameDataId:rule.gameDataId,name:'quest',description:'升级：贪欲九头蛇'}],itemsCatalog}), []);
  }
  assert.ok(!resolve('upgrade_zhonyas')[0].itemIds.includes('228002'), 'mention of reward does not authorize recommending it');
});

for (const [augmentId, mechanism, expectedItem] of [
  ['apex_inventor','item-haste','3157'], ['forged_by_the_master','item-damage','3153'],
  ['vulnerability','item-damage','6653'], ['combusting_interest','burn','6653'],
  ['infernal_conduit','burn','3068'], ['jeweled_gauntlet','critical','123430'],
  ['jeweled_bracelet','critical','123430'], ['critical_healing','critical','123430'],
  ['crit_n_cast','critical','3031'], ['soul_siphon','critical','3031'],
  ['critical_rhythm','critical','3031'], ['double_tap','on-hit','3124'],
  ['bees','on-hit','3115'], ['fan_the_hammer','on-hit','3153'],
  ['adapt','ability-power','3089'], ['escapade','attack-damage','6333'],
  ['eureka','ability-power','3089'], ['marksmage','ability-power','3115'],
  ['no_mana_no_problem','mana','3003'], ['mind_to_matter','mana','3119'],
  ['overflow','mana','3003'], ['blue_barrier','mana','3119'],
  ['heavy_hitter','own-health','3748'], ['pressure_cooker','own-health','3084'],
]) test(`${augmentId} supplies a bounded ${mechanism} synergy without assigning measured gains`, () => {
  const intent = resolve(augmentId).find(intent => intent.mechanism === mechanism);
  assert.equal(intent?.kind, 'mechanism');
  assert.ok(intent.itemIds.includes(expectedItem));
  assert.ok(intent.itemIds.length <= 64);
  assert.equal(intent.winRate, undefined);
  assert.equal(intent.bonus, undefined);
});

test('broad mechanism expansion excludes rewards, alternate old-mode recipes, and unavailable items', () => {
  const intents = data.augments.flatMap(entry => resolveAugmentItemIntents({owned:[entry],itemsCatalog}));
  const rewards = new Set(QUEST_ITEM_RULES.flatMap(rule => rule.rewardIds));
  for (const id of intents.flatMap(intent => intent.itemIds)) {
    assert.ok(!rewards.has(id), `no reward ${id}`);
    assert.ok(!/^77\d{4}$/.test(id), `no alternate recipe namespace ${id}`);
    assert.equal(itemsCatalog.data[id].maps['12'], true);
    assert.equal(itemsCatalog.data[id].gold.purchasable, true);
    assert.notEqual(itemsCatalog.data[id].inStore, false);
  }
});

test('damage-triggered armor shred or grievous wounds is not invented as item damage', () => {
  const ids = resolve('forged_by_the_master')[0].itemIds;
  for (const id of ['3033','3071','3165','6609','8010']) assert.ok(!ids.includes(id), id);
  assert.ok(ids.includes('3181'), 'an actual every-fifth-hit damage proc still qualifies');
});

test('casual item mentions, normal skill haste, unresolved runtime text, and Snowball are not item commitments', () => {
  for (const id of ['snowball_upgrade','recursion','ethereal_weapon','donation','transmute_prismatic'])
    assert.deepEqual(resolve(id), [], id);
  assert.deepEqual(resolveAugmentItemIntents({owned:[{id:'casual',name:'例子',description:'例如死亡之舞是一件装备。'}],itemsCatalog}), []);
  assert.deepEqual(resolveAugmentItemIntents({owned:[{id:'unknown',name:'升级：未知装备',description:'获得500金币。'}],itemsCatalog}), []);
});

test('new named item upgrades work through the catalog and recipes, without adding augment or champion IDs', () => {
  const item = (id,name,gold,from=[],into=[]) => ({id,name,gold:{total:gold,purchasable:true},maps:{12:true},from,into});
  const fixture = {data:{'10':item('10','测试原件',1000,[],['11','12']),
    '11':item('11','测试剑',3000,['10']), '12':item('12','测试法杖',3000,['10'])}};
  const owned = [{id:'future_upgrade',name:'强化：测试原件',description:'提升它的效果。'}];
  const result = resolveAugmentItemIntents({owned,itemsCatalog:fixture});
  assert.equal(result.length,1);
  assert.equal(result[0].kind,'family');
  assert.deepEqual(result[0].itemIds,['11','12']);
  assert.deepEqual(resolveAugmentItemIntents({owned,itemsCatalog:new Map(Object.entries(fixture.data))}),result);
});

test('duplicates and malformed inputs do not invent confirmed choices or unbounded intents', () => {
  assert.deepEqual(resolveAugmentItemIntents({owned:['upgrade_sheen',null,{}],itemsCatalog}),[]);
  const one = resolve('upgrade_sheen');
  assert.deepEqual(resolve('upgrade_sheen','upgrade_sheen'),one);
  assert.deepEqual(resolveAugmentItemIntents({owned:null,itemsCatalog:null}),[]);
});

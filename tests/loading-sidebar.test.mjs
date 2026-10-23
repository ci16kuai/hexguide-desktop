import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar, SessionConflictError} from '../server/sidebar.mjs';

// Isolated protocol fixtures only: no installed app, live client, real capture,
// player identity or real session directory is accessed by these tests.
const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const noAttack = {id:'fixture_loading_no_attack', name:'隔离测试：无法普攻', description:'你无法进行普通攻击。', availability:'current', recommendable:true};
const ids = [noAttack.id, 'with_haste', 'ravenous_bind'];
const frame = () => ({status:'recognized', code:'title-layout-confirmed', proposals:ids.map(id => ({id}))});
const opponent = (championId, itemIds = [], level = null) => ({championId, level, items:itemIds.map(id => ({id, count:1}))});
const confirmation = (model, id = noAttack.id) => ({id, gameId:model.gameId, revision:model.sessionRevision});

function setup({dataDirectory, scanner} = {}) {
  let clock = Date.parse('2026-10-24T03:00:00.000Z');
  let captures = 0;
  const observedAt = () => new Date(clock).toISOString();
  const roster = (source = 'loading-roster', enemies = [opponent('Soraka'), opponent('Ornn')]) => ({
    status:'detected', source, ownTeam:'ORDER', allies:[opponent('Gwen')], enemies, observedAt:observedAt()
  });
  const liveSnapshot = (values = {}) => ({
    connection:{status:'connected'}, phase:'InProgress', stage:'live', gameId:'fixture-old-game',
    championId:'Gwen', championSource:'live-client', level:12, gameTime:600, currentGold:1200,
    items:[], stats:{abilityPower:200}, augments:{status:'unavailable',ids:[]},
    mode:{known:true,isMayhem:true,queueId:2400}, teams:roster('live-client'), observedAt:observedAt(), ...values
  });
  const loadingSnapshot = (values = {}) => ({
    connection:{status:'connected'}, phase:'GameStart', stage:'loading', gameId:'fixture-new-game',
    championId:'Gwen', championSource:'loading-screen', level:null, gameTime:null, currentGold:null,
    items:[], stats:{}, augments:{status:'unavailable',ids:[]},
    mode:{known:true,isMayhem:true,queueId:2400}, teams:roster(), observedAt:observedAt(), ...values
  });
  let snapshot = liveSnapshot();
  const collector = {getSnapshot:() => structuredClone(snapshot)};
  const sidebar = new BackgroundSidebar({
    collector, data:{...data, augments:[...data.augments, noAttack]}, itemsCatalog, dataDirectory,
    now:() => clock, scanner:async () => { captures++; return scanner ? scanner() : frame(); }
  });
  return {sidebar, collector, liveSnapshot, loadingSnapshot, roster, captured:() => captures,
    update:values => { snapshot = {...snapshot, ...values}; }, replace:values => { snapshot = values; },
    advance:milliseconds => { clock += milliseconds; }};
}

async function folder(t) {
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:/Chatgpt/work/2026-10-24/hexguide-live-test/tests';
  await mkdir(root, {recursive:true});
  const directory = await mkdtemp(path.join(root, 'loading-sidebar-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return directory;
}

test('isolated sidebar loading-to-live flow clears old choices, previews the roster and atomically updates the confirmed plan', async t => {
  const dataDirectory = await folder(t);
  const {sidebar, replace, update, loadingSnapshot, liveSnapshot, roster, captured, advance} = setup({dataDirectory});
  t.after(() => sidebar.stop());

  await sidebar.setSession({owned:['goliath'],route:'tank'});
  await sidebar.scan();
  const old = sidebar.getModel();
  assert.deepEqual(old.owned.map(augment => augment.id), ['goliath']);
  assert.equal(old.route, 'tank');
  assert.equal(old.offers.length, 3);
  const previousCaptures = captured();

  replace(loadingSnapshot());
  const loading = sidebar.getModel();
  assert.equal(loading.phase, 'GameStart');
  assert.equal(loading.stage, 'loading');
  assert.equal(loading.championSource, 'loading-screen');
  assert.equal(loading.gameId, 'fixture-new-game', 'GameStart already belongs to the new game');
  assert.deepEqual(loading.owned, []);
  assert.equal(loading.route, 'auto');
  assert.deepEqual(loading.offers, []);
  assert.equal(loading.plan.stage, 'loading-preview');
  assert.equal(loading.plan.label, '开局前预览');
  assert.equal(loading.plan.enemyContext.source, 'loading-roster');
  assert.ok(loading.plan.buildItems.length > 0 && loading.plan.nextAugments.length > 0);
  assert.ok(loading.plan.enemyContext.champions.every(enemy => enemy.level === null && enemy.items.length === 0));
  assert.doesNotMatch(loading.plan.context.join(' '), /已确认海克斯：|当前 12 级|面板：/);
  assert.ok(loading.sessionRevision > old.sessionRevision);
  await assert.rejects(sidebar.confirmOffer(confirmation(old)), SessionConflictError);
  await assert.rejects(sidebar.confirmOffer(confirmation(loading)), SessionConflictError);
  assert.equal((await sidebar.scan()).status, 'waiting');
  await sidebar.pollOnce();
  assert.equal(captured(), previousCaptures, 'loading never starts OCR, including an explicit scan request');

  update({phase:'InProgress'});
  const inProgressLoading = sidebar.getModel();
  assert.equal(inProgressLoading.plan.stage, 'loading-preview');
  assert.equal(inProgressLoading.sessionRevision, loading.sessionRevision, 'a later phase is not another new game');
  await sidebar.pollOnce();
  assert.equal((await sidebar.scan()).status, 'waiting');
  assert.equal(captured(), previousCaptures, 'InProgress without a ready live API remains a roster preview');

  advance(5000);
  replace(liveSnapshot({gameId:'fixture-new-game', level:5, gameTime:40, currentGold:950, stats:{abilityPower:45}, teams:roster('live-client')}));
  const entered = sidebar.getModel();
  assert.equal(entered.stage, 'live');
  assert.equal(entered.championSource, 'live-client');
  assert.equal(entered.plan.stage, 'live');
  assert.deepEqual(entered.owned, []);
  assert.ok(entered.plan.choices.some(choice => choice.id === 'attack'));
  assert.ok(entered.plan.buildItems.some(item => item.id === '3153'));
  await sidebar.pollOnce();
  const offered = sidebar.getModel();
  assert.equal(captured(), previousCaptures + 1);
  assert.deepEqual(offered.offers.map(augment => augment.id), ids);
  assert.deepEqual(offered.owned, [], 'recognition alone cannot select a card');

  const choices = await Promise.allSettled([
    sidebar.confirmOffer(confirmation(offered)),
    sidebar.confirmOffer(confirmation(offered))
  ]);
  assert.equal(choices.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(choices.find(result => result.status === 'rejected').reason instanceof SessionConflictError);
  const selected = choices.find(result => result.status === 'fulfilled').value;
  assert.equal(selected.sessionRevision, offered.sessionRevision + 1);
  assert.deepEqual(selected.owned.map(augment => augment.id), [noAttack.id]);
  assert.deepEqual(selected.offers, []);
  assert.ok(selected.plan.choices.every(choice => choice.id !== 'attack'));
  assert.ok(selected.plan.buildItems.every(item => !['3115', '3153'].includes(item.id)));
  assert.ok(selected.plan.nextAugments.every(augment => augment.id !== noAttack.id));
  assert.notDeepEqual(selected.plan.buildItems, offered.plan.buildItems);
  assert.notDeepEqual(selected.plan.nextAugments, offered.plan.nextAugments);
  assert.match(selected.plan.context.join(' '), new RegExp(noAttack.name));
  const saved = JSON.parse(await readFile(path.join(dataDirectory, 'session.json'), 'utf8'));
  assert.equal(saved.gameId, 'fixture-new-game');
  assert.deepEqual(saved.owned, [noAttack.id]);
  assert.equal(saved.revision, selected.sessionRevision);

  update({items:[{id:'3165',count:1}], teams:roster('live-client', [opponent('Soraka', ['3065'], 6), opponent('Ornn', ['3068'], 6)])});
  const adapted = sidebar.getModel();
  assert.equal(adapted.sessionRevision, selected.sessionRevision, 'visible purchases update the plan without requiring another selection');
  assert.ok(adapted.plan.buildItems.some(item => item.id === '3135'));
  assert.ok(adapted.plan.buildItems.every(item => item.id !== '3165'));
  assert.ok(adapted.plan.enemyContext.signals.some(signal => signal.id === 'magic-resist'));
  assert.notDeepEqual(adapted.plan.nextAugments, selected.plan.nextAugments);

  update({stage:'waiting', championSource:null, championId:null, level:null, gameTime:null, currentGold:null, items:[], stats:{},
    connection:{status:'waiting'}, teams:{status:'unavailable', ownTeam:null, allies:[], enemies:[], observedAt:new Date('2026-10-24T03:00:05.000Z').toISOString()}});
  const interrupted = sidebar.getModel();
  assert.equal(interrupted.stage, 'waiting');
  assert.equal(interrupted.plan.stage, 'waiting', 'a temporary Live Client Data gap never reopens the loading preset');
  assert.deepEqual(interrupted.plan.buildItems, []);
  assert.deepEqual(interrupted.plan.nextAugments, []);
  assert.deepEqual(interrupted.owned.map(augment => augment.id), [noAttack.id], 'temporary data loss retains confirmed choices');
  assert.equal(interrupted.sessionRevision, selected.sessionRevision);
  replace(liveSnapshot({gameId:'fixture-new-game', level:6, gameTime:70}));
  const resumed = sidebar.getModel();
  assert.equal(resumed.plan.stage, 'live');
  assert.deepEqual(resumed.owned.map(augment => augment.id), [noAttack.id]);
});

test('a delayed OCR capture from the previous game cannot attach offers to a GameStart roster', async t => {
  let finish;
  const {sidebar, replace, loadingSnapshot, captured} = setup({scanner:() => new Promise(resolve => { finish = resolve; })});
  t.after(() => sidebar.stop());
  await sidebar.setSession({owned:['goliath'], route:'tank'});
  const scanning = sidebar.scan();
  assert.equal(captured(), 1);
  replace(loadingSnapshot());
  finish(frame());
  assert.equal((await scanning).status, 'waiting');
  const model = sidebar.getModel();
  assert.equal(model.plan.stage, 'loading-preview');
  assert.equal(model.gameId, 'fixture-new-game');
  assert.deepEqual(model.offers, []);
  assert.deepEqual(model.ocr.proposals, []);
  assert.deepEqual(model.owned, []);
  assert.equal(model.route, 'auto');
  assert.equal(captured(), 1);
});

test('loading entry clears saved choices even when a game ID was not yet discovered', async t => {
  const {sidebar, replace, loadingSnapshot, liveSnapshot, captured} = setup();
  t.after(() => sidebar.stop());
  replace(liveSnapshot({gameId:null}));
  await sidebar.setSession({owned:['goliath'], route:'tank'});
  await sidebar.scan();
  const old = sidebar.getModel();
  assert.equal(old.gameId, null);
  assert.equal(old.offers.length, 3);
  replace(loadingSnapshot({gameId:null}));
  const current = sidebar.getModel();
  assert.deepEqual(current.owned, []);
  assert.deepEqual(current.offers, []);
  assert.equal(current.route, 'auto');
  assert.equal(current.plan.stage, 'loading-preview');
  assert.ok(current.sessionRevision > old.sessionRevision);
  await assert.rejects(sidebar.confirmOffer(confirmation(old)), SessionConflictError);
  await sidebar.pollOnce();
  assert.equal(captured(), 1);
});

test('an empty-state capture crossing loading stays invalid even if the new live stage arrives before it finishes', async t => {
  let finish;
  const {sidebar, replace, liveSnapshot, loadingSnapshot, captured} = setup({scanner:() => new Promise(resolve => { finish = resolve; })});
  t.after(() => sidebar.stop());
  // No stored selection, discovered ID or usable old clock exists to provide
  // another boundary signal. Entering loading itself must invalidate capture.
  replace(liveSnapshot({gameId:null, gameTime:null}));
  const scanning = sidebar.scan();
  assert.equal(captured(), 1);
  const old = sidebar.getModel();
  assert.deepEqual(old.owned, []);
  assert.deepEqual(old.offers, []);
  assert.equal(old.route, 'auto');
  replace(loadingSnapshot({gameId:null}));
  assert.equal(sidebar.getModel().plan.stage, 'loading-preview');
  replace(liveSnapshot({gameId:null, gameTime:2, level:3}));
  assert.equal(sidebar.getModel().plan.stage, 'live');
  finish(frame());
  assert.equal((await scanning).status, 'waiting');
  const current = sidebar.getModel();
  assert.deepEqual(current.offers, []);
  assert.deepEqual(current.ocr.proposals, []);
  assert.deepEqual(current.owned, []);
});

test('a delayed old session write during loading is acknowledged with clean authoritative state and cannot repopulate the new live game', async t => {
  const dataDirectory = await folder(t);
  const {sidebar, replace, loadingSnapshot, liveSnapshot} = setup({dataDirectory});
  t.after(() => sidebar.stop());
  await sidebar.setSession({owned:['goliath'], route:'tank'});
  const old = sidebar.getSession();
  replace(loadingSnapshot());
  // This is the body of an old main-window pending write, not an OCR card
  // confirmation. It arrives only after the authoritative new-game boundary.
  const response = await sidebar.setSession({owned:old.owned, route:old.route});
  assert.deepEqual(response.owned, []);
  assert.equal(response.route, 'auto');
  assert.equal(response.gameId, 'fixture-new-game');
  const loading = sidebar.getModel();
  assert.deepEqual(loading.owned, []);
  assert.equal(loading.route, 'auto');
  assert.equal(loading.plan.stage, 'loading-preview');
  const revision = loading.sessionRevision;
  const repeated = await sidebar.setSession({owned:['goliath'], route:'tank'});
  assert.deepEqual(repeated.owned, []);
  assert.equal(repeated.route, 'auto');
  assert.equal(repeated.revision, revision, 'retrying stale loading writes cannot mutate the clean revision');
  replace(liveSnapshot({gameId:'fixture-new-game', gameTime:2, level:3}));
  const entered = sidebar.getModel();
  assert.equal(entered.plan.stage, 'live');
  assert.deepEqual(entered.owned, []);
  assert.equal(entered.route, 'auto');
  assert.doesNotMatch(entered.plan.context.join(' '), /已确认海克斯：|你选择的路线：/);
  await sidebar.stop();
  const saved = JSON.parse(await readFile(path.join(dataDirectory, 'session.json'), 'utf8'));
  assert.equal(saved.gameId, 'fixture-new-game');
  assert.deepEqual(saved.owned, []);
  assert.equal(saved.route, 'auto');
});

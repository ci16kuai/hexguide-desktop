import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LiveCollector} from '../server/collector.mjs';
import {BackgroundSidebar} from '../server/sidebar.mjs';

// Synthetic clock/protocol fixtures only. The 40-second sequence below is
// simulated, not recorded game footage or a claim of real-game acceptance.
// Every request and capture is injected; no installed helper or game is touched.
const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const {champions:officialChampions} = JSON.parse(await readFile(new URL('../server/resources/champions-16.21.1.json', import.meta.url), 'utf8'));
const noAttack = {id:'fixture_timing_no_attack', name:'隔离测试：无法普攻', description:'你无法进行普通攻击。', availability:'current', recommendable:true};
const offerIds = [noAttack.id, 'with_haste', 'ravenous_bind'];
const local = {summonerId:42, puuid:'fixture-timing-local'};

function harness() {
  const epoch = Date.parse('2026-10-24T08:00:00.000Z');
  const state = {wallTime:0, phase:'GameStart', gameId:987654, gameTime:0, gameAvailable:true, captures:0, bought:false, enemyMr:false};
  const now = () => new Date(epoch + state.wallTime);
  const roster = () => ({gameData:{gameId:state.gameId, queue:{id:3270, gameMode:'KIWI'},
    teamOne:[{...local, championId:887}],
    teamTwo:[{summonerId:77, puuid:'fixture-timing-opponent-a', championId:16}, {summonerId:78, puuid:'fixture-timing-opponent-b', championId:516}],
    playerChampionSelections:[]}});
  const player = (riotId, championId, team, items = []) => ({riotId, rawChampionName:`game_character_displayname_${championId}`, team,
    level:state.gameTime === 0 ? 1 : 6, items:items.map(itemID => ({itemID, count:1}))});
  const live = () => ({
    activePlayer:{riotId:'fixture-local#timing', level:state.gameTime === 0 ? 1 : 6, currentGold:1234, championStats:{abilityPower:130}},
    allPlayers:[player('fixture-local#timing','Gwen','ORDER',state.bought ? [3165] : []),
      player('fixture-enemy-a#timing','Soraka','CHAOS',state.enemyMr ? [3065] : []), player('fixture-enemy-b#timing','Ornn','CHAOS')],
    gameData:{gameTime:state.gameTime, gameMode:'KIWI'}
  });
  const augmentedData = {...data, augments:[...data.augments, noAttack]};
  const collector = new LiveCollector({champions:data.champions, officialChampions, augments:augmentedData.augments, now,
    discover:async () => ({port:55555, authorization:'Basic fixture-only'}), request:async url => {
      if (url.endsWith('/lol-gameflow/v1/gameflow-phase')) return state.phase;
      if (url.endsWith('/lol-gameflow/v1/session')) return roster();
      if (url.endsWith('/lol-summoner/v1/current-summoner')) return local;
      if (url.includes(':2999/')) { if (!state.gameAvailable) throw new Error('isolated temporary endpoint failure'); return live(); }
      throw new Error('Unexpected fixture endpoint');
    }});
  const sidebar = new BackgroundSidebar({collector, data:augmentedData, itemsCatalog, now:() => now().getTime(), scanner:async () => {
    state.captures++;
    return {status:'recognized', code:'title-layout-confirmed', proposals:offerIds.map(id => ({id}))};
  }});
  return {state, collector, sidebar, async tick(milliseconds, values = {}) {
    state.wallTime = milliseconds;
    Object.assign(state, values);
    const snapshot = await collector.pollOnce();
    await sidebar.pollOnce();
    return {snapshot, model:sidebar.getModel()};
  }};
}

test('isolated ready-API zero-clock loading remains observable for forty simulated seconds, then confirmation updates the running build', async t => {
  const h = harness();
  t.after(() => { h.collector.stop(); return h.sidebar.stop(); });
  // A saved previous-game selection must be discarded once at this game's
  // loading boundary, rather than clearing/reopening the model on every poll.
  await h.sidebar.setSession({owned:['goliath'], route:'tank'});
  let revision;
  let loadingPolls = 0;
  for (let elapsed = 0; elapsed <= 40_000; elapsed += 2_000) {
    const {snapshot, model} = await h.tick(elapsed, {phase:elapsed === 0 ? 'GameStart' : 'InProgress', gameTime:0});
    loadingPolls++;
    assert.equal(snapshot.stage, 'loading');
    assert.equal(snapshot.championSource, 'loading-screen');
    assert.equal(snapshot.gameTime, null);
    assert.equal(snapshot.level, null);
    assert.equal(snapshot.currentGold, null);
    assert.deepEqual(snapshot.items, []);
    assert.deepEqual(snapshot.stats, {});
    assert.equal(model.plan.stage, 'loading-preview');
    assert.equal(model.plan.label, '开局前预览');
    assert.equal(model.plan.enemyContext.status, 'detected');
    assert.equal(model.plan.enemyContext.source, 'loading-roster');
    assert.deepEqual(model.plan.enemyContext.champions.map(enemy => enemy.id), ['Soraka', 'Ornn']);
    assert.ok(model.plan.buildItems.length > 0);
    assert.deepEqual(model.plan.nextAugments, []);
    assert.deepEqual(model.owned, []);
    assert.equal(model.route, 'auto');
    if (revision === undefined) revision = model.sessionRevision;
    assert.equal(model.sessionRevision, revision, 'repeated fresh zero-clock polls preserve one opening session');
    assert.equal(h.state.captures, 0, 'a ready API does not start card OCR while its clock is still zero');
  }
  assert.equal(loadingPolls, 21, 'the preview survives many independent two-second consumer sampling opportunities');

  const {snapshot, model:offered} = await h.tick(42_000, {gameTime:0.25});
  assert.equal(snapshot.stage, 'live');
  assert.equal(snapshot.championSource, 'live-client');
  assert.equal(snapshot.gameTime, 0.25);
  assert.equal(offered.plan.stage, 'live');
  assert.equal(offered.sessionRevision, revision);
  assert.equal(h.state.captures, 1);
  assert.deepEqual(offered.offers.map(augment => augment.id), offerIds);
  assert.ok(offered.plan.choices.some(choice => choice.id === 'attack'));
  assert.ok(offered.plan.buildItems.some(item => item.id === '3153'));
  const selected = await h.sidebar.confirmOffer({id:noAttack.id, gameId:offered.gameId, revision:offered.sessionRevision});
  assert.deepEqual(selected.owned.map(augment => augment.id), [noAttack.id]);
  assert.ok(selected.plan.choices.every(choice => choice.id !== 'attack'));
  assert.ok(selected.plan.buildItems.every(item => !['3115','3153'].includes(item.id)));
  assert.notDeepEqual(selected.plan.nextAugments, offered.plan.nextAugments);

  const {model:adapted} = await h.tick(44_000, {gameTime:4, bought:true, enemyMr:true});
  assert.equal(adapted.sessionRevision, selected.sessionRevision);
  assert.ok(adapted.plan.buildItems.some(item => item.id === '3135'));
  assert.ok(adapted.plan.buildItems.every(item => item.id !== '3165'));
  assert.notDeepEqual(adapted.plan.nextAugments, selected.plan.nextAugments);
});

test('a later zero-clock retransmission never becomes a new preset or clears the confirmed running session', async t => {
  const h = harness();
  t.after(() => { h.collector.stop(); return h.sidebar.stop(); });
  await h.tick(0);
  const {model:offered} = await h.tick(2_000, {phase:'InProgress', gameTime:1});
  const selected = await h.sidebar.confirmOffer({id:noAttack.id, gameId:offered.gameId, revision:offered.sessionRevision});
  const revision = selected.sessionRevision;
  const {model:running} = await h.tick(4_000, {gameTime:120});
  assert.deepEqual(running.owned.map(augment => augment.id), [noAttack.id]);
  const {snapshot, model:replayed} = await h.tick(6_000, {gameTime:0});
  assert.equal(snapshot.stage, 'live');
  assert.equal(snapshot.championSource, 'live-client');
  assert.equal(replayed.plan.stage, 'live');
  assert.deepEqual(replayed.owned.map(augment => augment.id), [noAttack.id]);
  assert.equal(replayed.sessionRevision, revision);
  assert.ok(replayed.plan.choices.every(choice => choice.id !== 'attack'));
  const {model:resumed} = await h.tick(8_000, {gameTime:122});
  assert.equal(resumed.plan.stage, 'live');
  assert.equal(resumed.sessionRevision, revision);
  assert.deepEqual(resumed.owned.map(augment => augment.id), [noAttack.id]);
});

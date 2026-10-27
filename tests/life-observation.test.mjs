import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChampionIndex, emptySnapshot, LiveCollector, snapshotFromLive} from '../server/collector.mjs';

const now = new Date('2026-10-25T06:00:00Z');
const champions = [{id:'Ahri',name:'九尾妖狐',key:103},{id:'Annie',name:'黑暗之女',key:1}];
const index = buildChampionIndex(champions);
const unavailable = {status:'unavailable',isDead:null};
const live = () => ({
  activePlayer:{riotId:'local#fixture',summonerName:'local fixture name',level:7,currentGold:900,championStats:{currentHealth:100,attackDamage:71}},
  allPlayers:[
    {riotId:'other#fixture',summonerName:'other fixture name',rawChampionName:'game_character_displayname_Annie',team:'CHAOS',isDead:true,items:[]},
    {riotId:'local#fixture',summonerName:'local fixture name',rawChampionName:'game_character_displayname_Ahri',team:'ORDER',isDead:false,items:[{itemID:3020,displayName:'法师之靴',count:1}]},
  ],
  gameData:{gameTime:160,gameMode:'KIWI'},
});
const snapshot = data => snapshotFromLive(data,{index,now});

test('self life observation accepts only the local player’s explicit boolean flag', () => {
  for (const isDead of [false,true]) {
    const data = live();
    data.allPlayers[1].isDead = isDead;
    data.allPlayers[0].isDead = !isDead;
    assert.deepEqual(snapshot(data).life,{status:'detected',isDead});
  }
});

test('missing or malformed own isDead is unknown even when other sources suggest a death', () => {
  for (const value of [undefined,null,'false','true',0,1,NaN,{},[],new Boolean(false)]) {
    const data = live();
    data.allPlayers[1].isDead = value;
    data.activePlayer.isDead = true;
    data.activePlayer.championStats.currentHealth = 0;
    data.allPlayers[1].respawnTimer = 12;
    data.allPlayers[1].scores = {deaths:3};
    assert.deepEqual(snapshot(data).life,unavailable,String(value));
  }
  const data = live();
  delete data.allPlayers[1].isDead;
  assert.deepEqual(snapshot(data).life,unavailable);
});

test('zero health does not override a valid alive flag and positive health does not override dead', () => {
  const data = live();
  data.activePlayer.championStats.currentHealth = 0;
  assert.deepEqual(snapshot(data).life,{status:'detected',isDead:false});
  data.activePlayer.championStats.currentHealth = 1000;
  data.allPlayers[1].isDead = true;
  assert.deepEqual(snapshot(data).life,{status:'detected',isDead:true});
});

test('the local side may be either team and list order never selects another player’s life', () => {
  const data = live();
  data.allPlayers.reverse();
  data.allPlayers[0].team = 'CHAOS';
  data.allPlayers[1].team = 'ORDER';
  assert.deepEqual(snapshot(data).life,{status:'detected',isDead:false});
  assert.equal(snapshot(data).championId,'Ahri');
});

test('split Riot ID and unique legacy-name identity retain the existing local matching contract', () => {
  const split = live();
  delete split.activePlayer.riotId;
  split.activePlayer.riotIdGameName = 'local';
  split.activePlayer.riotIdTagLine = 'fixture';
  delete split.allPlayers[1].riotId;
  split.allPlayers[1].riotIdGameName = 'local';
  split.allPlayers[1].riotIdTagLine = 'fixture';
  assert.deepEqual(snapshot(split).life,{status:'detected',isDead:false});
  const legacy = live();
  delete legacy.activePlayer.riotId;
  legacy.allPlayers[1].isDead = true;
  assert.deepEqual(snapshot(legacy).life,{status:'detected',isDead:true});
});

test('unknown local identity, absent lists and duplicate legacy names never expose other-player life', () => {
  const unmatched = live();
  unmatched.activePlayer.riotId = 'absent#fixture';
  unmatched.activePlayer.summonerName = 'absent fixture name';
  const legacyCollision = live();
  delete legacyCollision.activePlayer.riotId;
  legacyCollision.allPlayers[0].summonerName = legacyCollision.activePlayer.summonerName;
  for (const data of [null,{}, {activePlayer:{}}, {activePlayer:live().activePlayer,allPlayers:null}, unmatched,legacyCollision]) {
    assert.deepEqual(snapshot(data).life,unavailable);
  }
});

test('known Riot ID conflict cannot cause a respawn trigger via a matching legacy name', () => {
  const data = live();
  data.activePlayer.riotId = 'absent#fixture';
  data.allPlayers[1].isDead = true;
  const result = snapshot(data);
  assert.deepEqual(result.life,unavailable);
  // This change adds a cautious life boundary without changing older hero or
  // inventory mapping behavior, which intentionally keeps a name fallback.
  assert.equal(result.championId,'Ahri');
  assert.equal(result.items[0].id,3020);
});

test('ambiguous Riot IDs cannot cause a respawn trigger via a unique legacy name', () => {
  const data = live();
  data.allPlayers[0].riotId = data.activePlayer.riotId;
  data.allPlayers[1].isDead = true;
  assert.deepEqual(snapshot(data).life,unavailable);
});

test('life exports only a boolean and status; neither life nor roster gains player identity', () => {
  const data = live();
  Object.assign(data.allPlayers[1],{respawnTimer:9,scores:{deaths:5},position:{x:100,y:200},puuid:'private fixture puuid'});
  const result = snapshot(data);
  assert.deepEqual(Object.keys(result.life).sort(),['isDead','status']);
  assert.deepEqual(result.teams.allies.map(player => Object.keys(player).sort()),[['championId','championName','items','level','performance']]);
  assert.deepEqual(result.teams.allies[0].performance,{kills:null,deaths:5,assists:null,creepScore:null});
  for (const forbidden of ['local#fixture','other#fixture','fixture name','puuid','respawnTimer','position','scores']) {
    assert.ok(!JSON.stringify(result).includes(forbidden),forbidden);
  }
  const withoutLife = value => { const {life,...rest} = value; return rest; };
  const changed = structuredClone(data);
  changed.allPlayers[1].isDead = true;
  assert.deepEqual(withoutLife(snapshot(changed)),withoutLife(result));
});

function collectorHarness() {
  const state = {phase:'GameStart',game:null};
  const requests = [];
  const collector = new LiveCollector({champions,now:() => now,discover:async () => ({port:55555,authorization:'Basic fixture only'}),request:async url => {
    requests.push(url);
    if (url.endsWith('/lol-gameflow/v1/gameflow-phase')) return state.phase;
    if (url.endsWith('/lol-gameflow/v1/session')) return {gameData:{gameId:12345,queue:{id:3270,gameMode:'KIWI'},
      teamOne:[{summonerId:42,championId:103,isDead:true}],teamTwo:[{summonerId:77,championId:1,isDead:false}]}};
    if (url.endsWith('/lol-summoner/v1/current-summoner')) return {summonerId:42};
    if (url.endsWith('/liveclientdata/allgamedata')) { if (!state.game) throw new Error('fixture unavailable'); return state.game; }
    throw new Error('unexpected fixture endpoint');
  }});
  return {collector,state,requests};
}

test('empty and verified loading snapshots always report unavailable life', async () => {
  assert.deepEqual(emptySnapshot(now).life,unavailable);
  const h = collectorHarness();
  assert.deepEqual((await h.collector.pollOnce()).life,unavailable);
  h.state.game = live();
  h.state.game.gameData.gameTime = 0;
  h.state.game.allPlayers[1].isDead = true;
  const loading = await h.collector.pollOnce();
  assert.equal(loading.stage,'loading');
  assert.deepEqual(loading.life,unavailable);
  h.state.phase = 'InProgress';
  h.state.game.gameData.gameTime = 0.01;
  const playing = await h.collector.pollOnce();
  assert.equal(playing.stage,'live');
  assert.deepEqual(playing.life,{status:'detected',isDead:true});
  // No new transport, credential discovery or endpoint was added for life.
  assert.ok(h.requests.every(url => /\/(gameflow-phase|session|current-summoner|allgamedata)$/.test(url)));
});

test('collector publishes death and return to life without retaining the last flag across missing data', async () => {
  const h = collectorHarness();
  h.state.phase = 'InProgress';
  h.state.game = live();
  for (const isDead of [false,true,true,false]) {
    h.state.game.allPlayers[1].isDead = isDead;
    const result = await h.collector.pollOnce();
    assert.deepEqual(result.life,{status:'detected',isDead});
    result.life.isDead = !isDead;
    assert.deepEqual(h.collector.getSnapshot().life,{status:'detected',isDead});
  }
  delete h.state.game.allPlayers[1].isDead;
  assert.deepEqual((await h.collector.pollOnce()).life,unavailable);
  h.state.game = null;
  const disconnected = await h.collector.pollOnce();
  assert.equal(disconnected.stage,'waiting');
  assert.deepEqual(disconnected.life,unavailable);
  h.state.phase = 'Lobby';
  assert.deepEqual((await h.collector.pollOnce()).life,unavailable);
});

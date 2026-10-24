import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveCollector} from '../server/collector.mjs';

const now = new Date('2026-10-24T04:00:00Z');
const champions = [{id:'Ahri',name:'九尾妖狐'},{id:'Annie',name:'黑暗之女'},{id:'Nunu',name:'雪原双子'}];
const officialChampions = [{id:'Ahri',key:'103'},{id:'Annie',key:'1'},{id:'Nunu',key:'20'}];
const identity = {summonerId:42,puuid:'local-player-fixture',displayName:'private-local-name'};
const roster = () => ({
  gameData:{gameId:12345,queue:{id:3270,gameMode:'KIWI'},
    teamOne:[{summonerId:42,puuid:'local-player-fixture',championId:103,profileIconId:99,summonerName:'private-local-name'}],
    teamTwo:[{summonerId:77,puuid:'enemy-player-fixture',championId:1,summonerName:'private-enemy-name',items:[{itemID:9999}]}],
    playerChampionSelections:[],
  },
  gameName:'private-custom-room',
});
const live = () => ({activePlayer:{riotId:'local#fixture',level:3,currentGold:1200,championStats:{abilityPower:40}},allPlayers:[
  {riotId:'local#fixture',rawChampionName:'game_character_displayname_Ahri',team:'ORDER',level:3,items:[{itemID:3020,displayName:'法师之靴',count:1}]},
  {riotId:'enemy#fixture',rawChampionName:'game_character_displayname_Nunu',team:'CHAOS',level:3,items:[{itemID:3083,displayName:'狂徒铠甲',count:1}]},
],gameData:{gameTime:8.5,gameMode:'KIWI'}});

function harness({phase='GameStart',session=roster(),currentSummoner=identity,game=null,...options} = {}) {
  const state = {phase,session,currentSummoner,game};
  const requests = [];
  const collector = new LiveCollector({champions,officialChampions,now:() => now,discover:async () => ({port:55555,authorization:'Basic fixture-only'}),...options,request:async (url,requestOptions) => {
    requests.push({url,options:requestOptions});
    if (url.endsWith('/lol-gameflow/v1/gameflow-phase')) { if (state.lcuAvailable === false) throw new Error('LCU unavailable'); return state.phase; }
    if (url.endsWith('/lol-gameflow/v1/session')) { if (!state.session) throw new Error('session unavailable'); return state.session; }
    if (url.endsWith('/lol-summoner/v1/current-summoner')) { if (!state.currentSummoner) throw new Error('identity unavailable'); return state.currentSummoner; }
    if (url.endsWith('/lol-champ-select/v1/session')) return {localPlayerCellId:2,myTeam:[{cellId:2,championId:103}],theirTeam:[{championId:1}]};
    if (url.includes(':2999/')) { if (!state.game) throw new Error('not started'); return state.game; }
    throw new Error('unexpected endpoint');
  }});
  return {collector,state,requests};
}

test('GameStart exposes only the real loading roster without inventing live stats or items', async () => {
  const h = harness();
  const snapshot = await h.collector.pollOnce();
  assert.equal(snapshot.phase,'GameStart');
  assert.equal(snapshot.stage,'loading');
  assert.equal(snapshot.gameId,'12345');
  assert.equal(snapshot.championId,'Ahri');
  assert.equal(snapshot.championSource,'loading-screen');
  assert.equal(snapshot.connection.status,'connected');
  assert.equal(snapshot.mode.isMayhem,true);
  for (const key of ['level','gameTime','currentGold']) assert.equal(snapshot[key],null,key);
  assert.deepEqual(snapshot.items,[]);
  assert.deepEqual(snapshot.stats,{});
  assert.deepEqual(snapshot.augments,{status:'unavailable',ids:[]});
  assert.deepEqual(snapshot.teams,{
    status:'detected',source:'loading-roster',ownTeam:'ORDER',
    allies:[{championId:'Ahri',championName:'九尾妖狐',level:null,items:[]}],
    enemies:[{championId:'Annie',championName:'黑暗之女',level:null,items:[]}],
    observedAt:now.toISOString(),
  });
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['private-','local-player-fixture','enemy-player-fixture','summonerId','puuid','profileIconId','gameName','9999','authorization']) assert.ok(!serialized.includes(secret),secret);
  const identityRequest = h.requests.find(call => call.url.endsWith('current-summoner'));
  assert.equal(identityRequest.options.insecureLcu,true);
  const gameRequest = h.requests.find(call => call.url.includes(':2999/'));
  assert.equal(gameRequest.options.authorization,undefined);
  snapshot.teams.enemies[0].championId = 'Nunu';
  assert.equal(h.collector.getSnapshot().teams.enemies[0].championId,'Annie');
});

test('InProgress can still be a loading screen, then real Live Client data replaces the preview', async () => {
  const h = harness({phase:'InProgress'});
  const loading = await h.collector.pollOnce();
  assert.equal(loading.phase,'InProgress');
  assert.equal(loading.stage,'loading');
  assert.equal(loading.teams.source,'loading-roster');
  h.state.game = live();
  const playing = await h.collector.pollOnce();
  assert.equal(playing.stage,'live');
  assert.equal(playing.championSource,'live-client');
  assert.equal(playing.gameTime,8.5);
  assert.equal(playing.level,3);
  assert.deepEqual(playing.items,[{id:3020,name:'法师之靴',count:1}]);
  assert.deepEqual(playing.teams.enemies,[{championId:'Nunu',championName:'雪原双子',level:3,items:[{id:3083,name:'狂徒铠甲',count:1}]}]);
  assert.equal(playing.teams.source,undefined);
});

test('a partial HTTP 200 live response does not displace a verified loading roster', async () => {
  for (const game of [{},{activePlayer:{},allPlayers:[]},{activePlayer:{riotId:'not-ready#fixture'},allPlayers:[{riotId:'someone-else#fixture',rawChampionName:'game_character_displayname_Nunu'}]}]) {
    const h = harness({phase:'InProgress',game});
    const loading = await h.collector.pollOnce();
    assert.equal(loading.connection.status,'connected');
    assert.equal(loading.stage,'loading');
    assert.equal(loading.championId,'Ahri');
    assert.equal(loading.championSource,'loading-screen');
    assert.equal(loading.teams.source,'loading-roster');
    assert.deepEqual(loading.teams.enemies.map(player => player.championId),['Annie']);
    assert.equal(loading.level,null);
    assert.deepEqual(loading.items,[]);
    h.state.game = live();
    const playing = await h.collector.pollOnce();
    assert.equal(playing.stage,'live');
    assert.equal(playing.level,3);
  }
});

test('a ready Live API with a strictly zero clock preserves the verified loading preview until time starts', async () => {
  // The real client exposed a ready API while its loading screen remained
  // visible. The controlled zero-clock values below are regression inputs,
  // not claimed captures of that real screen's unavailable historical clock.
  let clock = now.getTime();
  const game = live();
  game.gameData.gameTime = 0;
  game.activePlayer.level = 1;
  const h = harness({game,now:() => new Date(clock)});
  for (const elapsed of [0,2000,44000]) {
    clock = now.getTime() + elapsed;
    h.state.phase = elapsed ? 'InProgress' : 'GameStart';
    const loading = await h.collector.pollOnce();
    assert.equal(loading.stage,'loading');
    assert.equal(loading.championSource,'loading-screen');
    assert.equal(loading.championId,'Ahri');
    assert.equal(loading.teams.source,'loading-roster');
    assert.deepEqual(loading.teams.enemies.map(player => player.championId),['Annie']);
    assert.equal(loading.teams.observedAt,new Date(clock).toISOString());
    for (const key of ['gameTime','level','currentGold']) assert.equal(loading[key],null,key);
    assert.deepEqual(loading.items,[]);
    assert.deepEqual(loading.stats,{});
    assert.deepEqual(loading.augments,{status:'unavailable',ids:[]});
  }
  game.gameData.gameTime = 0.01;
  game.activePlayer.level = 3;
  const started = await h.collector.pollOnce();
  assert.equal(started.stage,'live');
  assert.equal(started.gameTime,0.01);
  assert.equal(started.level,3);
  assert.equal(started.items[0].id,3020);
  game.gameData.gameTime = 0;
  const retransmitted = await h.collector.pollOnce();
  assert.equal(retransmitted.stage,'live');
  assert.equal(retransmitted.championSource,'live-client');
  assert.equal(retransmitted.teams.source,undefined);
  h.state.game = null;
  const disconnected = await h.collector.pollOnce();
  assert.equal(disconnected.stage,'waiting');
  assert.equal(disconnected.teams.status,'unavailable');
  h.state.session.gameData.gameId = 87654;
  h.state.game = game;
  const nextGame = await h.collector.pollOnce();
  assert.equal(nextGame.stage,'loading');
  assert.equal(nextGame.gameId,'87654');
});

test('zero clocks alone never invent loading rosters without verified new-game identity and sides', async () => {
  for (const change of [
    h => {h.state.lcuAvailable = false;},
    h => {h.state.currentSummoner = null;},
    h => {h.state.currentSummoner = {summonerId:999,puuid:'not-local'};},
    h => {h.state.phase = 'Reconnect';},
    h => {delete h.state.session.gameData.teamTwo;},
  ]) {
    const game = live();
    game.gameData.gameTime = 0;
    const h = harness({phase:'InProgress',game});
    change(h);
    const snapshot = await h.collector.pollOnce();
    assert.notEqual(snapshot.stage,'loading');
    assert.notEqual(snapshot.championSource,'loading-screen');
    assert.notEqual(snapshot.teams.source,'loading-roster');
  }
  for (const gameTime of [undefined,null,'0',NaN,Infinity,-1]) {
    const game = live();
    game.gameData.gameTime = gameTime;
    const h = harness({phase:'InProgress',game});
    assert.notEqual((await h.collector.pollOnce()).stage,'loading');
  }
});

test('observed custom KIWI 3v3 schema locates Teemo in teamTwo and survives GameStart to live handoff', async () => {
  // Shape observed in the real client on 2026-10-24. Every account, room and
  // authentication value below is synthetic; only public champion IDs remain.
  const observedChampions = [
    {id:'Leona',key:89,name:'曙光女神'}, {id:'Malzahar',key:90,name:'虚空先知'},
    {id:'Jinx',key:222,name:'暴走萝莉'}, {id:'Ashe',key:22,name:'寒冰射手'},
    {id:'Thresh',key:412,name:'魂锁典狱长'}, {id:'Teemo',key:17,name:'迅捷斥候'},
  ];
  const member = (championId, offset) => ({championId,puuid:`fixture-puuid-${offset}`,summonerId:1000 + offset,profileIconId:0});
  const teamOne = [member(89,1),member(90,2),member(222,3)];
  const teamTwo = [member(22,4),member(412,5),member(17,6)];
  const session = {gameData:{gameId:987654321,gameName:'fixture-private-room',isCustomGame:true,password:'fixture-private-password',
    queue:{id:3270,gameMode:'KIWI',isCustom:true,category:'Custom'},spectatorKey:'fixture-private-spectator-key',spectatorsAllowed:false,
    teamOne,teamTwo,
    playerChampionSelections:[...teamOne,...teamTwo].map(({championId,puuid}) => ({championId,puuid,selectedSkinIndex:0,spell1Id:4,spell2Id:32})),
  }};
  const h = harness({session,champions:observedChampions,officialChampions:observedChampions,currentSummoner:{puuid:'fixture-puuid-6',summonerId:1006,displayName:'fixture-private-local'}});
  for (const phase of ['GameStart','InProgress']) {
    h.state.phase = phase;
    const loading = await h.collector.pollOnce();
    assert.equal(loading.phase,phase);
    assert.equal(loading.stage,'loading');
    assert.equal(loading.championId,'Teemo');
    assert.equal(loading.championSource,'loading-screen');
    assert.equal(loading.teams.ownTeam,'CHAOS');
    assert.deepEqual(loading.teams.allies.map(player => player.championId),['Ashe','Thresh','Teemo']);
    assert.deepEqual(loading.teams.enemies.map(player => player.championId),['Leona','Malzahar','Jinx']);
    assert.deepEqual(loading.mode,{queueId:3270,isMayhem:true,known:true});
    assert.ok(loading.teams.enemies.every(player => player.level === null && player.items.length === 0));
    const exported = JSON.stringify(loading);
    for (const privateField of ['fixture-puuid','fixture-private','password','spectatorKey','summonerId','puuid','spell1Id','selectedSkinIndex']) assert.ok(!exported.includes(privateField),privateField);
  }
  h.state.game = {activePlayer:{riotId:'fixture-private-local#0000',level:3,currentGold:1300,championStats:{abilityPower:33}},
    allPlayers:[...teamOne.map(({championId}) => ({team:'ORDER',rawChampionName:`game_character_displayname_${observedChampions.find(champion => champion.key === championId).id}`,level:3,items:[]})),
      ...teamTwo.map(({championId}) => ({team:'CHAOS',rawChampionName:`game_character_displayname_${observedChampions.find(champion => champion.key === championId).id}`,level:3,items:championId === 17 ? [{itemID:3115,displayName:'纳什之牙',count:1}] : [],...(championId === 17 ? {riotId:'fixture-private-local#0000'} : {})}))],
    gameData:{gameTime:4,gameMode:'KIWI'},
  };
  const playing = await h.collector.pollOnce();
  assert.equal(playing.stage,'live');
  assert.equal(playing.championId,'Teemo');
  assert.equal(playing.championSource,'live-client');
  assert.equal(playing.teams.source,undefined);
  assert.deepEqual(playing.teams.enemies.map(player => player.championId),['Leona','Malzahar','Jinx']);
  assert.deepEqual(playing.items,[{id:3115,name:'纳什之牙',count:1}]);
  assert.equal(playing.level,3);
  assert.equal(playing.gameTime,4);
});

test('the local player may be teamTwo and champion selections can fill IDs only by stable identity', async () => {
  const session = roster();
  [session.gameData.teamOne,session.gameData.teamTwo] = [session.gameData.teamTwo,session.gameData.teamOne];
  session.gameData.teamTwo[0].championId = 0;
  session.gameData.teamOne[0].championId = 0;
  session.gameData.playerChampionSelections = [
    {summonerId:77,championId:20,summonerInternalName:'private-enemy-name'},
    {puuid:'local-player-fixture',championId:103,summonerInternalName:'private-local-name'},
  ];
  const h = harness({session});
  const snapshot = await h.collector.pollOnce();
  assert.equal(snapshot.teams.ownTeam,'CHAOS');
  assert.equal(snapshot.championId,'Ahri');
  assert.deepEqual(snapshot.teams.enemies.map(player => player.championId),['Nunu']);
  assert.ok(!JSON.stringify(snapshot).includes('private-'));
  session.gameData.playerChampionSelections.push({puuid:'local-player-fixture',championId:1});
  const ambiguous = await h.collector.pollOnce();
  assert.equal(ambiguous.championId,null);
  assert.equal(ambiguous.teams.allies[0].championId,null);
});

test('champion select does not request a local identity, inspect enemies, or retain a loading game ID', async () => {
  const h = harness({phase:'ChampSelect'});
  const snapshot = await h.collector.pollOnce();
  assert.equal(snapshot.stage,'champ-select');
  assert.equal(snapshot.gameId,null);
  assert.equal(snapshot.championId,'Ahri');
  assert.equal(snapshot.championSource,'champ-select');
  assert.equal(snapshot.teams.status,'unavailable');
  assert.equal(h.requests.length,3);
  assert.ok(h.requests.every(call => !call.url.endsWith('current-summoner') && !call.url.includes(':2999/')));
});

test('unknown, conflicting, duplicate, or missing own identity never guesses an opponent side', async () => {
  const changes = [
    h => {h.state.currentSummoner = null;},
    h => {h.state.currentSummoner = {summonerId:999,puuid:'someone-else'};},
    h => {h.state.currentSummoner = {summonerId:42,puuid:'conflicting-puuid'};},
    h => {h.state.session.gameData.teamTwo.push({...h.state.session.gameData.teamOne[0]});},
    h => {h.state.session.gameData.teamTwo = [];},
    h => {delete h.state.session.gameData.teamOne;},
    h => {h.state.currentSummoner = {displayName:'private-local-name'};},
  ];
  for (const change of changes) {
    const h = harness();
    change(h);
    const snapshot = await h.collector.pollOnce();
    assert.equal(snapshot.championId,null);
    assert.equal(snapshot.teams.status,'unavailable');
    assert.equal(snapshot.teams.ownTeam,null);
    assert.deepEqual(snapshot.teams.enemies,[]);
  }
});

test('loading roster data is never reused after failure, invalid game IDs, a new game, or return to lobby', async () => {
  const h = harness();
  assert.equal((await h.collector.pollOnce()).teams.status,'detected');
  h.state.session = null;
  let snapshot = await h.collector.pollOnce();
  assert.equal(snapshot.championId,null);
  assert.equal(snapshot.gameId,null);
  assert.equal(snapshot.teams.status,'unavailable');
  for (const gameId of [0,-1,Infinity,'','../../old','0']) {
    h.state.session = roster();
    h.state.session.gameData.gameId = gameId;
    snapshot = await h.collector.pollOnce();
    assert.equal(snapshot.gameId,null);
    assert.equal(snapshot.teams.status,'unavailable');
  }
  h.state.session = roster();
  h.state.session.gameData.gameId = 45678;
  h.state.session.gameData.teamTwo[0].championId = 20;
  snapshot = await h.collector.pollOnce();
  assert.equal(snapshot.gameId,'45678');
  assert.equal(snapshot.teams.enemies[0].championId,'Nunu');
  h.state.phase = 'Lobby';
  snapshot = await h.collector.pollOnce();
  assert.equal(snapshot.stage,'waiting');
  assert.equal(snapshot.gameId,null);
  assert.equal(snapshot.championId,null);
  assert.equal(snapshot.teams.status,'unavailable');
});

test('a live match never falls back to opening presets during a temporary API outage', async () => {
  const h = harness({phase:'InProgress',game:live()});
  assert.equal((await h.collector.pollOnce()).stage,'live');
  const identityRequests = h.requests.filter(call => call.url.endsWith('current-summoner')).length;
  h.state.game = null;
  const reconnecting = await h.collector.pollOnce();
  assert.equal(reconnecting.phase,'InProgress');
  assert.equal(reconnecting.gameId,'12345');
  assert.equal(reconnecting.stage,'waiting');
  assert.equal(reconnecting.championId,null);
  assert.equal(reconnecting.championSource,null);
  assert.equal(reconnecting.teams.status,'unavailable');
  assert.deepEqual(reconnecting.items,[]);
  assert.equal(h.requests.filter(call => call.url.endsWith('current-summoner')).length,identityRequests);
  h.state.game = live();
  assert.equal((await h.collector.pollOnce()).stage,'live');
  h.state.game = null;
  h.state.session.gameData.gameId = 76543;
  const newMatch = await h.collector.pollOnce();
  assert.equal(newMatch.stage,'loading');
  assert.equal(newMatch.gameId,'76543');
  assert.equal(newMatch.teams.status,'detected');
});

test('missing LCU game IDs after a live observation wait for reconnection without returning to loading', async () => {
  const h = harness({phase:'InProgress',game:live()});
  assert.equal((await h.collector.pollOnce()).stage,'live');
  h.state.game = null;
  delete h.state.session.gameData.gameId;
  let reconnecting = await h.collector.pollOnce();
  assert.equal(reconnecting.stage,'waiting');
  assert.equal(reconnecting.gameId,null);
  assert.equal(reconnecting.championId,null);
  assert.equal(reconnecting.teams.status,'unavailable');
  h.state.session = null;
  reconnecting = await h.collector.pollOnce();
  assert.equal(reconnecting.stage,'waiting');
  assert.equal(reconnecting.gameId,null);
  h.state.session = roster();
  reconnecting = await h.collector.pollOnce();
  assert.equal(reconnecting.gameId,'12345');
  assert.equal(reconnecting.stage,'waiting');
  h.state.phase = 'Lobby';
  assert.equal((await h.collector.pollOnce()).stage,'waiting');
  h.state.phase = 'GameStart';
  assert.equal((await h.collector.pollOnce()).stage,'loading');
});

test('a match first seen through Live Client binds its later LCU ID without reopening loading presets', async () => {
  const h = harness({phase:'InProgress',game:live()});
  h.state.lcuAvailable = false;
  const initial = await h.collector.pollOnce();
  assert.equal(initial.stage,'live');
  assert.equal(initial.gameId,null);
  assert.equal(initial.championId,'Ahri');
  h.state.lcuAvailable = true;
  h.state.game = null;
  const recoveredLcu = await h.collector.pollOnce();
  assert.equal(recoveredLcu.gameId,'12345');
  assert.equal(recoveredLcu.stage,'waiting');
  assert.equal(recoveredLcu.teams.status,'unavailable');
  assert.equal(recoveredLcu.championSource,null);
  assert.ok(h.requests.every(call => !call.url.endsWith('current-summoner')));
  h.state.session.gameData.gameId = 34567;
  const nextGame = await h.collector.pollOnce();
  assert.equal(nextGame.gameId,'34567');
  assert.equal(nextGame.stage,'loading');
  assert.equal(nextGame.teams.source,'loading-roster');
});

test('an observed GameStart boundary permits new loading presets after a live match without an ID', async () => {
  const h = harness({phase:'InProgress',game:live()});
  h.state.lcuAvailable = false;
  assert.equal((await h.collector.pollOnce()).stage,'live');
  h.state.lcuAvailable = true;
  h.state.phase = 'GameStart';
  h.state.game = null;
  assert.equal((await h.collector.pollOnce()).stage,'loading');
  h.state.game = live();
  assert.equal((await h.collector.pollOnce()).stage,'live');
  h.state.game = null;
  assert.equal((await h.collector.pollOnce()).stage,'waiting');
});

test('an initial Reconnect waits for real gameplay and never assumes it is an opening loading screen', async () => {
  const h = harness({phase:'Reconnect'});
  const waiting = await h.collector.pollOnce();
  assert.equal(waiting.phase,'Reconnect');
  assert.equal(waiting.stage,'waiting');
  assert.equal(waiting.teams.status,'unavailable');
  assert.equal(waiting.championId,null);
  assert.ok(h.requests.every(call => !call.url.endsWith('current-summoner')));
  h.state.game = live();
  assert.equal((await h.collector.pollOnce()).stage,'live');
});

test('GameStart polling stays at the active interval while the Live Client endpoint is still starting', async t => {
  const h = harness({interval:10,idleInterval:1000,maxBackoff:15000});
  t.after(() => h.collector.stop());
  h.collector.start();
  await new Promise(resolve => setTimeout(resolve,45));
  h.collector.stop();
  assert.ok(h.requests.filter(call => call.url.endsWith('gameflow-phase')).length >= 2);
  assert.equal(h.collector.getSnapshot().stage,'loading');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChampionIndex, snapshotFromLive} from '../server/collector.mjs';

const now = new Date('2026-10-27T03:00:00Z');
const index = buildChampionIndex([{id:'Ahri',name:'九尾妖狐'},{id:'MasterYi',name:'无极剑圣'}]);
const live = () => ({
  activePlayer:{riotId:'local#private',level:10,championStats:{}},
  allPlayers:[
    {riotId:'local#private',rawChampionName:'game_character_displayname_Ahri',team:'ORDER',level:10,items:[]},
    {riotId:'enemy#private',rawChampionName:'game_character_displayname_MasterYi',team:'CHAOS',level:11,items:[]},
  ],
  gameData:{gameTime:600,gameMode:'KIWI'},
});
const snapshot = data => snapshotFromLive(data,{index,now});
const unknown = {kills:null,deaths:null,assists:null,creepScore:null};

test('live roster exposes only bounded score observations for each corresponding side', () => {
  const data = live();
  data.allPlayers[0].scores = {kills:0,deaths:3,assists:8,creepScore:42};
  data.allPlayers[1].scores = {kills:12,deaths:2,assists:5,creepScore:61};
  const result = snapshot(data);
  assert.deepEqual(result.teams.allies[0].performance,data.allPlayers[0].scores);
  assert.deepEqual(result.teams.enemies[0].performance,data.allPlayers[1].scores);
  assert.equal(result.teams.observedAt,now.toISOString());
  assert.notEqual(result.teams.enemies[0].performance,data.allPlayers[1].scores);
  data.allPlayers[1].scores.kills = 99;
  assert.equal(result.teams.enemies[0].performance.kills,12);
});

test('partial score observations retain unknown fields as null instead of fabricated zero', () => {
  const data = live();
  data.allPlayers[1].scores = {deaths:0,assists:'8',creepScore:null};
  const result = snapshot(data);
  assert.deepEqual(result.teams.enemies[0].performance,{...unknown,deaths:0});
  assert.equal(Object.hasOwn(result.teams.allies[0],'performance'),false);
  data.allPlayers[1].scores = {kills:12};
  assert.deepEqual(snapshot(data).teams.enemies[0].performance,{...unknown,kills:12});
});

test('missing, malformed or wholly invalid scores omit performance without coercion', () => {
  for (const scores of [undefined,null,[],{},{kills:'12'},{deaths:false},'scores',12]) {
    const data = live();
    data.allPlayers[1].scores = scores;
    assert.equal(Object.hasOwn(snapshot(data).teams.enemies[0],'performance'),false,JSON.stringify(scores));
  }
  const data = live();
  data.allPlayers[1].scores = Object.create({kills:9});
  assert.equal(Object.hasOwn(snapshot(data).teams.enemies[0],'performance'),false);
  data.allPlayers[1].scores = Object.assign([],{kills:9});
  assert.equal(Object.hasOwn(snapshot(data).teams.enemies[0],'performance'),false);
});

test('each performance counter accepts inclusive integer bounds and rejects malformed values independently', () => {
  for (const [key,maximum] of Object.entries({kills:1000,deaths:1000,assists:1000,creepScore:10000})) {
    for (const value of [0,maximum]) {
      const data = live();
      data.allPlayers[1].scores = {[key]:value};
      assert.deepEqual(snapshot(data).teams.enemies[0].performance,{...unknown,[key]:value},`${key}=${value}`);
    }
    for (const value of [-1,maximum+1,0.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER,'1',true,false,null,undefined,{},[],new Number(1)]) {
      const data = live();
      const other = key === 'kills' ? 'deaths' : 'kills';
      data.allPlayers[1].scores = {[other]:1,[key]:value};
      assert.deepEqual(snapshot(data).teams.enemies[0].performance,{...unknown,[other]:1},`${key}=${String(value)}`);
    }
  }
});

test('performance is an allowlist and never publishes raw scores, identity, location or inferred economy', () => {
  const data = live();
  Object.assign(data.allPlayers[1],{
    summonerName:'private enemy name',puuid:'private-id',position:{x:1,y:2},currentGold:9999,
    scores:{kills:7,deaths:2,assists:3,creepScore:44,wardScore:99,goldEarned:9999,
      summonerName:'private score name',riotId:'score#private',position:{x:3,y:4}},
  });
  const result = snapshot(data), enemy = result.teams.enemies[0];
  assert.deepEqual(Object.keys(enemy).sort(),['championId','championName','items','level','performance']);
  assert.deepEqual(enemy.performance,{kills:7,deaths:2,assists:3,creepScore:44});
  const serialized = JSON.stringify(result);
  for (const forbidden of ['private','puuid','summonerName','riotId','position','scores','wardScore','goldEarned','9999']) {
    assert.equal(serialized.includes(forbidden),false,forbidden);
  }
  assert.equal(result.currentGold,null);
});

test('performance cannot turn unknown sides into opponent data', () => {
  const data = live();
  data.allPlayers[1].scores = {kills:7};
  data.allPlayers[1].team = 'unknown';
  assert.equal(snapshot(data).teams.status,'unavailable');
  assert.deepEqual(snapshot(data).teams.enemies,[]);
});

test('missing new scores neither retain an old observation nor infer counters from other fields', () => {
  const data = live();
  data.allPlayers[1].scores = {kills:12};
  assert.deepEqual(snapshot(data).teams.enemies[0].performance,{...unknown,kills:12});
  delete data.allPlayers[1].scores;
  Object.assign(data.allPlayers[1],{kills:12,performance:{kills:12},isDead:true,respawnTimer:30});
  Object.assign(data.activePlayer.championStats,{kills:12,deaths:3});
  assert.equal(Object.hasOwn(snapshot(data).teams.enemies[0],'performance'),false);
  assert.equal(Object.hasOwn(snapshot(data).teams.allies[0],'performance'),false);
});

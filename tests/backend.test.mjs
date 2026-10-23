import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, writeFile, rm, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {buildChampionIndex, findOwnPlayer, snapshotFromLive, parseLockfile, discoverLcu, LiveCollector} from '../server/collector.mjs';
import {createLocalServer} from '../server/http.mjs';
import {requestLocalJson} from '../server/transport.mjs';
import {matchOcrProposals, createOcrScanner} from '../server/ocr.mjs';

const now = new Date('2026-10-23T12:00:00Z');
const champions = [{id:'Ahri', name:'九尾妖狐', title:'阿狸', aliases:['狐狸']}, {id:'Annie', name:'黑暗之女', title:'安妮'}];
const officialChampions = [{id:'Ahri', key:103, name:'Ahri'}, {id:'Annie', key:1, name:'Annie'}];
const index = buildChampionIndex(champions, officialChampions);
const augmentIndex = new Map([['1234', 'test_augment']]);
const live = () => ({
  activePlayer:{riotId:'本人#ABCD', summonerName:'Same Name', level:12, currentGold:900, fullRunes:{generalRunes:[{id:1234}]}, championStats:{abilityPower:240, attackDamage:71, maxHealth:1800, resourceType:'MANA', moveSpeed:380, attackSpeed:1.12}},
  allPlayers:[
    {riotId:'别人的名字#ZZZZ', summonerName:'Same Name', championName:'Annie', rawChampionName:'game_character_displayname_Annie', items:[{itemID:3006, displayName:'Other boots', count:1}]},
    {riotId:'本人#ABCD', summonerName:'Same Name', championName:'九尾妖狐', rawChampionName:'game_character_displayname_Ahri', level:12, items:[{itemID:3020, displayName:'法师之靴', count:1},{itemID:0, displayName:'Empty', count:1}]},
  ],
  gameData:{gameTime:605.4, gameMode:'ARAM', mapNumber:12},
});

test('own player is matched by Riot ID even when names collide or the other player comes first', () => {
  const result = snapshotFromLive(live(), {index, augmentIndex, now});
  assert.equal(result.championId, 'Ahri');
  assert.equal(result.championSource, 'live-client');
  assert.equal(result.level, 12);
  assert.equal(result.gameTime, 605.4);
  assert.deepEqual(result.items, [{id:3020, name:'法师之靴', count:1}]);
  assert.equal(result.stats.abilityPower, 240);
  assert.equal(result.mode.known, false);
  assert.equal(result.mode.isMayhem, false);
  assert.deepEqual(result.augments, {status:'unavailable', ids:[]});
  const serialized = JSON.stringify(result);
  for (const privateData of ['本人', '别人的名字', 'Same Name', 'ZZZZ', 'generalRunes', 'allPlayers']) assert.ok(!serialized.includes(privateData));
});

test('unique legacy summonerName is supported, duplicates are not guessed', () => {
  const data = live();
  delete data.activePlayer.riotId;
  assert.equal(findOwnPlayer(data), null);
  data.activePlayer.summonerName = 'Me';
  data.allPlayers[1].summonerName = 'Me';
  assert.equal(findOwnPlayer(data), data.allPlayers[1]);
  data.activePlayer.summonerName = 'Absent';
  const result = snapshotFromLive(data, {index, now});
  assert.equal(result.connection.status, 'error');
  assert.equal(result.championId, null);
  assert.deepEqual(result.items, []);
});

test('split Riot ID fields and localized champion names resolve to the existing champion ID', () => {
  const data = live();
  delete data.activePlayer.riotId;
  data.activePlayer.riotIdGameName = '本人';
  data.activePlayer.riotIdTagLine = 'ABCD';
  delete data.allPlayers[1].rawChampionName;
  assert.equal(snapshotFromLive(data, {index, now}).championId, 'Ahri');
});

test('unknown heroes and invalid stat values never borrow another player’s data', () => {
  const data = live();
  data.allPlayers[1].rawChampionName = 'game_character_displayname_Unknown';
  data.allPlayers[1].championName = 'Unknown';
  data.activePlayer.championStats.abilityPower = '9000';
  data.activePlayer.championStats.attackDamage = Infinity;
  data.activePlayer.championStats.ignoredPersonalField = 'private';
  const result = snapshotFromLive(data, {index, now});
  assert.equal(result.championId, null);
  assert.ok(!('abilityPower' in result.stats));
  assert.ok(!('attackDamage' in result.stats));
  assert.ok(!('ignoredPersonalField' in result.stats));
});

test('only explicit, fully recognized augment arrays are detected; ordinary runes never are', () => {
  const data = live();
  assert.equal(snapshotFromLive(data, {index, augmentIndex, now}).augments.status, 'unavailable');
  data.allPlayers[1].augments = [{id:1234}, 1234];
  assert.deepEqual(snapshotFromLive(data, {index, augmentIndex, now}).augments, {status:'detected', ids:['test_augment']});
  data.allPlayers[1].augments.push(9999);
  assert.deepEqual(snapshotFromLive(data, {index, augmentIndex, now}).augments, {status:'unavailable', ids:[]});
  data.allPlayers[1].augments = [];
  assert.equal(snapshotFromLive(data, {index, augmentIndex, now}).augments.status, 'unavailable');
});

test('lockfile parsing validates port/protocol and keeps authorization only in memory', () => {
  const parsed = parseLockfile('LeagueClient:1234:54321:not-a-real-secret:https');
  assert.equal(parsed.port, 54321);
  assert.equal(parsed.authorization, `Basic ${Buffer.from('riot:not-a-real-secret').toString('base64')}`);
  for (const malformed of ['x', 'a:1:0:s:https', 'a:1:65536:s:https', 'a:1:1:s:http', 'a:1:1::https', 'a:pid:1:s:https']) assert.equal(parseLockfile(malformed), null);
});

test('lockfile discovery uses configured directory and handles a closed client', async () => {
  const calls = [];
  const found = await discoverLcu({platform:'test', leagueDirectory:'League custom', read:async file => {
    calls.push(file);
    if (file === path.join('League custom', 'lockfile')) return 'LeagueClient:1234:54321:example:https';
    throw new Error('Not found');
  }});
  assert.equal(found.port, 54321);
  assert.equal(calls.length, 1);
  assert.equal(await discoverLcu({platform:'test', read:async () => {throw new Error('Not found');}}), null);
});

test('LCU champ-select follows only localPlayerCellId and uses pinned numeric champion mapping', async () => {
  const requested = [];
  const collector = new LiveCollector({champions, officialChampions, now:() => now, discover:async () => ({port:55555, authorization:'Basic local-test'}), request:async (url, options) => {
    requested.push({url, options});
    if (url.endsWith('gameflow-phase')) return 'ChampSelect';
    if (url.endsWith('/lol-gameflow/v1/session')) return {gameData:{queue:{id:2400},gameId:123}};
    if (url.endsWith('/lol-champ-select/v1/session')) return {localPlayerCellId:2,myTeam:[{cellId:1,championId:1},{cellId:2,championId:103}]};
    throw new Error('Unexpected endpoint');
  }});
  const result = await collector.pollOnce();
  assert.equal(result.championId, 'Ahri');
  assert.equal(result.championSource, 'champ-select');
  assert.deepEqual(result.mode, {queueId:2400,isMayhem:true,known:true});
  assert.equal(result.gameId, null);
  assert.equal(requested.length, 3);
  assert.ok(requested.every(call => call.options.insecureLcu === true));
});

test('in-game snapshots retain LCU queue and game ID; ordinary ARAM never becomes Mayhem', async () => {
  let queueId = 450;
  const requests = [];
  const ca = Buffer.from('fixture-ca');
  const collector = new LiveCollector({champions, officialChampions, ca, now:() => now, discover:async () => ({port:55555,authorization:'Basic local-test'}), request:async (url, options) => {
    requests.push({url, options});
    if (url.endsWith('gameflow-phase')) return 'InProgress';
    if (url.endsWith('/lol-gameflow/v1/session')) return {gameData:{queue:{id:queueId},gameId:12345}};
    if (url.includes(':2999/')) return live();
    throw new Error('Unexpected endpoint');
  }});
  let result = await collector.pollOnce();
  assert.equal(result.gameId, '12345');
  assert.deepEqual(result.mode, {queueId:450,isMayhem:false,known:true});
  const gameRequest = requests.find(call => call.url.includes(':2999/'));
  assert.equal(gameRequest.options.ca, ca);
  assert.equal(gameRequest.options.insecureLcu, undefined);
  assert.equal(gameRequest.options.authorization, undefined);
  queueId = 2400;
  result = await collector.pollOnce();
  assert.equal(result.mode.isMayhem, true);
  // The page cannot mutate the collector's state through its returned copy.
  result.items[0].name = 'Changed';
  assert.equal(collector.getSnapshot().items[0].name, '法师之靴');
});

test('offline collection returns waiting and clears stale game/hero data', async () => {
  let available = true;
  const collector = new LiveCollector({champions, officialChampions, now:() => now, discover:async () => null, request:async () => {
    if (available) return live();
    throw new Error('Connection refused');
  }});
  assert.equal((await collector.pollOnce()).championId, 'Ahri');
  available = false;
  const result = await collector.pollOnce();
  assert.equal(result.connection.status, 'waiting');
  assert.equal(result.championId, null);
  assert.equal(result.level, null);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.stats, {});
});

test('collector stop cancels its next scheduled poll', async () => {
  let calls = 0;
  const collector = new LiveCollector({champions, officialChampions, interval:10,idleInterval:10,now:() => now, discover:async () => null, request:async () => {calls++; return live();}});
  collector.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  collector.stop();
  const previous = calls;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, previous);
  assert.ok(calls >= 1);
});

function request(port, target, {headers = {}, method = 'GET', body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port, path:target, method, headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP accepts only local Host, same-origin and correct token; static traversal and writes fail', async t => {
  const scratchRoot = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-23\\hexguide-desktop';
  await mkdir(scratchRoot, {recursive:true});
  const folder = await mkdtemp(path.join(scratchRoot, 'backend-test-'));
  const root = path.join(folder,'dist');
  await mkdir(root);
  await writeFile(path.join(root,'index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(path.join(folder,'secret.txt'), 'not accessible');
  let stopped = false;
  let scans = 0;
  const local = await createLocalServer({staticDirectory:root, token:'a'.repeat(64), scanner:async () => {scans++; return {status:'waiting',message:'fixture',proposals:[]};}, collector:{getSnapshot:() => ({connection:{status:'waiting'}}), stop:() => {stopped = true;}}});
  t.after(async () => {await local.close(); await rm(folder,{recursive:true,force:true});});
  const token = {'X-Hexguide-Session':local.token};
  const sameOrigin = `http://127.0.0.1:${local.port}`;
  assert.equal(local.server.address().address, '127.0.0.1');
  assert.equal((await request(local.port,'/')).status, 200);
  assert.equal((await request(local.port,'/api/live')).status, 401);
  assert.equal((await request(local.port,'/api/live',{headers:{'X-Hexguide-Session':'wrong'}})).status, 401);
  const good = await request(local.port,'/api/live',{headers:{...token,Origin:sameOrigin}});
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.body).connection.status, 'waiting');
  assert.equal(good.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(local.port,'/api/health',{headers:token})).status, 200);
  assert.equal((await request(local.port,'/api/live',{headers:{...token,Host:'attacker.example'}})).status, 403);
  assert.equal((await request(local.port,'/api/live',{headers:{...token,Origin:'https://attacker.example'}})).status, 403);
  assert.equal((await request(local.port,'/api/live',{headers:{...token,Origin:'null'}})).status, 403);
  assert.equal((await request(local.port,'/',{headers:{Host:'localhost:'+local.port}})).status, 403);
  assert.equal((await request(local.port,'/api/live',{method:'POST',headers:token})).status, 405);
  assert.equal((await request(local.port,'/api/live',{headers:{...token,'Content-Length':'4'},body:'test'})).status, 405);
  assert.equal((await request(local.port,'/api/live',{method:'OPTIONS',headers:token})).status, 405);
  for (const target of ['/server/main.mjs','/%2e%2e/secret.txt','/%2e%2e%5csecret.txt','/.env','/%00']) assert.equal((await request(local.port,target)).status,404,target);
  const head = await request(local.port,'/',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.body,'');
  const health = await request(local.port,'/api/health?token='+local.token);
  assert.equal(health.status,401,'query tokens are not credentials');
  assert.equal((await request(local.port,'/api/ocr',{method:'POST',headers:token,body:'{}'})).status,200);
  assert.equal(scans,1);
  assert.equal((await request(local.port,'/api/ocr',{method:'POST',headers:token,body:'{"text":"arbitrary input"}'})).status,400);
  assert.equal((await request(local.port,'/api/ocr',{method:'POST',headers:token,body:'['})).status,400);
  assert.equal((await request(local.port,'/api/ocr',{method:'POST',headers:token,body:' '.repeat(4097)})).status,413);
  assert.equal((await request(local.port,'/api/ocr',{method:'POST',body:'{}'})).status,401);
  assert.equal((await request(local.port,'/api/ocr',{method:'POST',headers:{...token,Origin:'https://attacker.example'},body:'{}'})).status,403);
  assert.equal(scans,1,'bad input and cross-origin requests never start OCR');
  assert.equal(stopped,false);
});

test('the Riot transport rejects external, HTTP and misleading loopback hostnames before network use', async () => {
  for (const url of ['https://example.com/data','http://127.0.0.1:2999/data','https://localhost:2999/data','https://127.0.0.1.attacker.test/data']) await assert.rejects(requestLocalJson(url),/Only the local Riot/);
});

const augments = [
  {id:'fire',name:'烈焰之魂',enName:'Fire Soul',availability:'current',recommendable:true},
  {id:'ice',name:'冰霜之魂',enName:'Ice Soul',availability:'current',recommendable:true},
  {id:'gold',name:'黄金之心',enName:'Golden Heart',availability:'current',recommendable:true},
  {id:'retired',name:'已移除选项',availability:'retired',recommendable:false},
  {id:'template',name:'内部模板项',availability:'current',isInternalTemplate:true},
  {id:'short',name:'短词',availability:'current',recommendable:true},
];

test('OCR matches unique exact normalized names, preserves left-to-right order and skips reference data', () => {
  const result = matchOcrProposals({status:'recognized',diagnostics:{width:1920,height:1080},lines:[{text:'ICE SOUL',x:1320,y:350,width:160,height:30},{text:'烈 焰 之 魂',x:430,y:350,width:160,height:30},{text:'黄金之心',x:890,y:350,width:160,height:30},{text:'已移除选项 内部模板项 短词',x:200,y:700,width:400,height:20}]},augments);
  assert.equal(result.status,'recognized');
  assert.deepEqual(result.proposals.map(p => p.id),['fire','gold','ice']);
  assert.ok(result.proposals.every(p => p.confidence === 'exact'));
  assert.ok(!('text' in result),'raw capture text is not echoed to the browser');
});

test('OCR cannot guess fuzzy, ambiguous or more-than-three candidate names', () => {
  assert.equal(matchOcrProposals({status:'recognized',lines:[{text:'烈炎之魂'}]},augments).status,'unavailable');
  assert.equal(matchOcrProposals({status:'recognized',lines:[{text:'烈焰之魂 冰霜之魂'}]},augments).status,'unavailable');
  const many = [...augments,{id:'extra',name:'第四种选项',availability:'current',recommendable:true}];
  assert.equal(matchOcrProposals({status:'recognized',lines:['烈焰之魂','冰霜之魂','黄金之心','第四种选项'].map((text,x) => ({text,x}))},many).status,'unavailable');
  const duplicate = [...augments,{id:'alias-collision',name:'其他选项',aliases:['Fire Soul'],availability:'current',recommendable:true}];
  assert.equal(matchOcrProposals({status:'recognized',lines:[{text:'Fire Soul'}]},duplicate).status,'unavailable');
  assert.deepEqual(matchOcrProposals({status:'waiting',message:'游戏窗口未在前台'},augments),{status:'waiting',message:'游戏窗口未在前台',proposals:[]});
});

test('OCR is single-flight, launches the fixed local script with explicit arguments and fails safely', async () => {
  let finish;
  let call;
  const scan = createOcrScanner({applicationDirectory:'H:\\App',dataDirectory:'H:\\App Data',augments,platform:'win32',executeScript:async (...args) => {
    call = args;
    return new Promise(resolve => {finish=resolve;});
  }});
  const first = scan();
  assert.equal((await scan()).status,'waiting');
  finish({stdout:JSON.stringify({status:'recognized',diagnostics:{width:1920,height:1080},lines:[{text:'烈焰之魂',x:430,y:350,width:160,height:30},{text:'黄金之心',x:890,y:350,width:160,height:30},{text:'冰霜之魂',x:1320,y:350,width:160,height:30}]})});
  assert.equal((await first).proposals[0].id,'fire');
  assert.equal(call[0],'powershell.exe');
  assert.equal(call[1].at(-2),'-DataDir');
  assert.equal(call[1].at(-1),'H:\\App Data');
  assert.equal(call[2].maxBuffer,1024 * 1024);
  assert.equal(call[2].timeout,15000);
  assert.equal(call[2].windowsHide,true);
  const unavailable = createOcrScanner({applicationDirectory:'H:\\App',platform:'win32',executeScript:async () => {throw new Error('private error');}});
  const failure = await unavailable();
  assert.equal(failure.status,'unavailable');
  assert.ok(!JSON.stringify(failure).includes('private error'));
  assert.equal((await createOcrScanner({platform:'other'})()).status,'unavailable');
});

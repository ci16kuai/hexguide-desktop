import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {BackgroundSidebar, SessionValidationError} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const current = data.augments.filter(a => a.availability === 'current' && !a.retiredPatch && a.recommendable !== false && !a.isInternalTemplate);
const ids = current.slice(0, 3).map(a => a.id);
const recognized = () => ({status:'recognized', message:'fixture', proposals:ids.map(id => ({id, name:'Do not trust remote name', confidence:'exact'}))});
function setup(options = {}) {
  let clock = Date.parse('2026-10-23T12:00:00Z');
  let snapshot = {connection:{status:'connected', message:'fixture'}, phase:'InProgress', gameId:'123', championId:'Ahri', level:12, gameTime:600, items:[{id:3020,name:'法师之靴',count:1}], stats:{abilityPower:250}, augments:{status:'unavailable',ids:[]}, mode:{known:true,isMayhem:true}, observedAt:new Date(clock).toISOString()};
  const collector = {getSnapshot:() => structuredClone(snapshot)};
  const sidebar = new BackgroundSidebar({collector, data, itemsCatalog, now:() => clock, scanner:async () => recognized(), ...options});
  return {sidebar, collector, update:values => {snapshot = {...snapshot,...values};}, advance:ms => {clock += ms;}};
}
async function folder(t) {
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-23\\hexguide-desktop';
  await mkdir(root, {recursive:true});
  const result = await mkdtemp(path.join(root, 'sidebar-test-'));
  t.after(() => rm(result,{recursive:true,force:true}));
  return result;
}

test('shared selections are validated and persist only assistant IDs and route', async t => {
  const directory = await folder(t);
  const {sidebar, collector} = setup({dataDirectory:directory});
  await sidebar.load();
  assert.equal(sidebar.getModel().ocr.enabled, true);
  const saved = await sidebar.setSession({owned:[ids[0]],route:'spell'});
  assert.deepEqual(saved.owned,[ids[0]]);
  assert.equal(saved.gameId,'123');
  const disk = JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
  assert.deepEqual(Object.keys(disk).sort(),['gameId','owned','revision','route','selectionSources']);
  assert.deepEqual(Object.keys(disk.selectionSources),['manualBarrier']);
  assert.equal(typeof disk.selectionSources.manualBarrier,'boolean');
  assert.ok(!JSON.stringify(disk).includes('Do not trust remote name'));
  const restored = await new BackgroundSidebar({collector,data,dataDirectory:directory}).load();
  assert.deepEqual(restored.getSession().owned,[ids[0]]);
  assert.equal(restored.getSession().route,'spell');
  assert.equal(restored.getModel().ocr.enabled,true,'automatic recognition defaults to on when no pause preference was saved');
  for (const value of [{owned:[],route:'unknown'},{owned:['not-real'],route:'auto'},{owned:[ids[0],ids[0]],route:'auto'},{owned:[],route:'auto',playerName:'forbidden'},{owned:[],route:'auto',token:'forbidden'},null]) await assert.rejects(sidebar.setSession(value),SessionValidationError);
  for (const value of [{enabled:1},{enabled:true,extra:true},[],null]) assert.throws(() => sidebar.setOcr(value),SessionValidationError);
  await sidebar.stop();
});

test('recognition pause is restored independently of selections and rapid changes persist in order', async t => {
  const directory = await folder(t);
  const {sidebar,collector} = setup({dataDirectory:directory});
  await sidebar.load();
  assert.equal(sidebar.getModel().ocr.enabled,true);
  sidebar.setOcr({enabled:false});
  sidebar.setOcr({enabled:true});
  sidebar.setOcr({enabled:false});
  await sidebar.stop();
  const preference = JSON.parse(await readFile(path.join(directory,'recognition.json'),'utf8'));
  assert.deepEqual(preference,{enabled:false});
  await writeFile(path.join(directory,'session.json'),'{broken session');
  const restored = await new BackgroundSidebar({collector,data,dataDirectory:directory}).load();
  assert.deepEqual(restored.getSession().owned,[]);
  assert.equal(restored.getModel().ocr.enabled,false);
  assert.equal(restored.getModel().ocr.status,'disabled');
  restored.setOcr({enabled:true});
  await restored.stop();
  const resumed = await new BackgroundSidebar({collector,data,dataDirectory:directory}).load();
  assert.equal(resumed.getModel().ocr.enabled,true);
  await resumed.stop();
});

test('malformed recognition preferences do not disable automatic recognition or restore extra data', async t => {
  const directory = await folder(t);
  const {collector} = setup();
  for (const contents of ['invalid json',JSON.stringify({enabled:'false'}),JSON.stringify({enabled:false,owned:[ids[0]]}),JSON.stringify([])]) {
    await writeFile(path.join(directory,'recognition.json'),contents);
    const sidebar = await new BackgroundSidebar({collector,data,dataDirectory:directory}).load();
    assert.equal(sidebar.getModel().ocr.enabled,true);
    assert.deepEqual(sidebar.getSession().owned,[]);
    await sidebar.stop();
  }
});

test('confirmed state survives reconnects but clears on new game ID, end phase, or clock reset', async () => {
  const {sidebar,update} = setup();
  await sidebar.setSession({owned:[ids[0]],route:'tank'});
  update({phase:'Reconnect',gameTime:null});
  assert.deepEqual(sidebar.getSession().owned,[ids[0]]);
  update({phase:'None',connection:{status:'waiting'},gameId:null,gameTime:null});
  assert.deepEqual(sidebar.getSession().owned,[ids[0]],'transient loss is not a game boundary');
  update({phase:'InProgress',gameId:'456',gameTime:20,connection:{status:'connected'}});
  assert.deepEqual(sidebar.getSession().owned,[]);
  assert.equal(sidebar.getSession().route,'auto');
  assert.equal(sidebar.getSession().gameId,'456');
  await sidebar.setSession({owned:[ids[1]],route:'attack'});
  update({phase:'EndOfGame'});
  assert.deepEqual(sidebar.getSession().owned,[]);
  update({phase:'InProgress',gameId:null,gameTime:800});
  await sidebar.setSession({owned:[ids[2]],route:'crit'});
  update({gameTime:40});
  assert.deepEqual(sidebar.getSession().owned,[],'clock reset detects a new game even without LCU game ID');
  update({gameTime:900});
  await sidebar.setSession({owned:[ids[0]],route:'tank'});
  update({phase:'Reconnect',gameTime:null});
  sidebar.getSession();
  update({phase:'InProgress',gameTime:4});
  assert.deepEqual(sidebar.getSession().owned,[],'reconnect with no clock does not discard the last known game clock');
});

test('OCR candidates are not confirmed selections; empty frames retain three cards only for 60 seconds', async () => {
  let result = recognized();
  const {sidebar,advance} = setup({scanner:async () => result});
  const scanned = await sidebar.scan();
  assert.equal(scanned.status,'recognized');
  const first = sidebar.getModel();
  assert.deepEqual(first.owned,[]);
  assert.deepEqual(first.offers.map(a => a.id),ids,'physical left-to-right card order is retained');
  assert.deepEqual(first.ocr.proposals.map(a => a.id),ids);
  assert.deepEqual(first.offers.map(a => a.rank).sort(),[1,2,3]);
  assert.ok(first.offers.every(a => a.reason && Array.isArray(a.cautions)));
  assert.ok(first.offers.every(a => typeof a.icon === 'string' && typeof a.rarity === 'string'));
  assert.ok(!JSON.stringify(first).includes('Do not trust remote name'),'names come from trusted current dataset');
  advance(30000);
  result = {status:'waiting',message:'No cards',proposals:[]};
  await sidebar.scan();
  assert.deepEqual(sidebar.getModel().offers,first.offers);
  assert.equal(sidebar.getModel().ocr.observedAt,first.ocr.observedAt,'empty frames never extend recognized frame lifetime');
  advance(30001);
  assert.deepEqual(sidebar.getModel().offers,[]);
  assert.deepEqual(sidebar.getModel().ocr.proposals,[]);
});

test('mixed-quality offers and confirmed augments retain their own catalog rarity independent of rank', async () => {
  const mixed = ['big_shot', current.find(a => a.rarity === 'silver').id, 'its_critical'];
  const {sidebar} = setup({scanner:async () => ({status:'recognized', proposals:mixed.map(id => ({id, confidence:'exact'}))})});
  await sidebar.scan();
  const model = sidebar.getModel();
  assert.deepEqual(model.offers.map(a => a.id),mixed);
  assert.deepEqual(model.offers.map(a => a.rarity),['prismatic','silver','gold']);
  assert.deepEqual(model.offers.map(a => a.name),mixed.map(id => data.augments.find(a => a.id === id).name));
  assert.deepEqual([...model.offers.map(a => a.rank)].sort(),[1,2,3]);
  await sidebar.setSession({owned:mixed, route:'auto'});
  assert.deepEqual(sidebar.getModel().owned.map(a => a.rarity),['prismatic','silver','gold']);
});

test('manual and background scan requests share one capture and ignore late results from an ended game', async () => {
  let calls = 0;
  let finish;
  const {sidebar,update} = setup({scanner:() => {calls++;return new Promise(resolve => {finish=resolve;});}});
  sidebar.setOcr({enabled:true});
  const first = sidebar.scan();
  const concurrent = sidebar.scan();
  assert.equal(calls,1);
  update({gameId:'new-game',gameTime:1});
  sidebar.getSession();
  finish(recognized());
  assert.equal((await first).status,'waiting');
  assert.equal((await concurrent).status,'waiting');
  assert.deepEqual(sidebar.getModel().offers,[]);
});

test('automatic recognition defaults on, honors pauses, current game and interval without visible UI', async () => {
  let scans = 0;
  const {sidebar,update,advance} = setup({scanner:async () => {scans++;return recognized();}});
  update({stage:'live', gameTime:1, life:{status:'detected',isDead:false}});
  await sidebar.pollOnce();
  assert.equal(scans,1);
  sidebar.setOcr({enabled:false});
  advance(7000);
  update({observedAt:'2026-10-23T12:00:07.000Z'});
  await sidebar.pollOnce();
  assert.equal(scans,1);
  sidebar.setOcr({enabled:true});
  await sidebar.pollOnce();
  assert.equal(scans,2);
  await sidebar.pollOnce();
  assert.equal(scans,2);
  advance(7000);
  update({observedAt:'2026-10-23T12:00:14.000Z'});
  await sidebar.pollOnce();
  assert.equal(scans,3);
  update({phase:'ChampSelect'});
  advance(7000);
  await sidebar.pollOnce();
  assert.equal(scans,3);
  update({phase:'InProgress',mode:{known:true,isMayhem:false}});
  await sidebar.pollOnce();
  assert.equal(scans,3);
  update({mode:{known:true,isMayhem:true}});
  sidebar.setOcr({enabled:false});
  await sidebar.pollOnce();
  assert.equal(scans,3);
});

test('pausing recognition discards an in-flight frame without losing confirmed choices', async () => {
  let finish;
  const {sidebar} = setup({scanner:() => new Promise(resolve => {finish=resolve;})});
  await sidebar.setSession({owned:[ids[0]],route:'spell'});
  const scan = sidebar.scan();
  sidebar.setOcr({enabled:false});
  finish(recognized());
  assert.equal((await scan).status,'waiting');
  const model = sidebar.getModel();
  assert.equal(model.ocr.enabled,false);
  assert.equal(model.ocr.status,'disabled');
  assert.deepEqual(model.offers,[]);
  assert.deepEqual(model.owned.map(entry => entry.id),[ids[0]]);
});

test('confirming a selected card dismisses old offers and recommendations reflect confirmed state', async () => {
  const {sidebar} = setup();
  await sidebar.scan();
  await sidebar.setSession({owned:[ids[0]],route:'spell'});
  const model = sidebar.getModel();
  assert.deepEqual(model.offers,[]);
  assert.deepEqual(model.owned.map(a => a.id),[ids[0]]);
  assert.equal(typeof model.owned[0].icon,'string');
  assert.equal(model.owned[0].rarity,current.find(a => a.id === ids[0]).rarity);
  assert.equal(typeof model.owned[0].summary,'string');
  assert.doesNotMatch(model.owned[0].summary,/<[^>]*>/);
  assert.equal(model.route,'spell');
  assert.match(model.plan.summary,/1 个已确认海克斯/);
  assert.equal(model.champion.id,'Ahri');
  assert.equal(model.level,12);
  assert.equal(model.items[0].name,'法师之靴');
  assert.ok(Array.isArray(model.plan.context),'the complete plan is retained rather than a title/summary/choices projection');
  assert.ok(model.plan.confidence);
  assert.ok(model.plan.label);
});

test('sidebar exposes the same sanitized team observation and current gold as the collector', () => {
  const teams = {status:'detected',ownTeam:'ORDER',allies:[{championId:'Ahri',championName:'九尾妖狐',level:12,items:[]}],enemies:[{championId:'Annie',championName:'黑暗之女',level:13,items:[{id:3089,name:'灭世者的死亡之帽',count:1}]}],observedAt:'2026-10-23T12:00:00.000Z'};
  const {sidebar,update} = setup();
  update({teams,currentGold:1234});
  const model = sidebar.getModel();
  assert.deepEqual(model.teams,teams);
  assert.equal(model.currentGold,1234);
  model.teams.enemies[0].championId = 'Mutated';
  assert.equal(sidebar.getModel().teams.enemies[0].championId,'Annie');
  update({teams:undefined});
  assert.equal(sidebar.getModel().teams.status,'unavailable');
});

function request(port, target, {headers={},method='GET',body} = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port,path:target,method,headers},response => {
      const chunks=[];
      response.on('data',chunk => chunks.push(chunk));
      response.on('end',() => resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);
    req.end(body);
  });
}

test('sidebar and shared session endpoints retain Host, Origin, token, body limit and strict write validation', async t => {
  const directory = await folder(t);
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>fixture</title>');
  let captures=0;
  const {sidebar,collector} = setup({scanner:async () => {captures++;return recognized();}});
  const local = await createLocalServer({collector,sidebar,staticDirectory:directory,token:'b'.repeat(64)});
  t.after(() => local.close());
  const headers = {'X-Hexguide-Session':local.token,'Content-Type':'application/json'};
  const guarded = value => { const current = sidebar.getSession(); return {...value,expectedRevision:current.revision,expectedGameEpoch:current.gameEpoch,expectedGameId:current.gameId}; };
  for (const endpoint of ['/api/session','/api/sidebar']) {
    assert.equal((await request(local.port,endpoint)).status,401);
    assert.equal((await request(local.port,endpoint,{headers:{...headers,Origin:'https://attacker.example'}})).status,403);
    assert.equal((await request(local.port,endpoint,{headers:{...headers,Host:'attacker.example'}})).status,403);
    assert.equal((await request(local.port,endpoint,{headers})).status,200);
  }
  let response = await request(local.port,'/api/session',{headers,method:'POST',body:JSON.stringify(guarded({owned:[ids[0]],route:'tank'}))});
  assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(response.body).owned,[ids[0]]);
  assert.equal((await request(local.port,'/api/session',{headers,method:'POST',body:'{"owned":[],"route":"auto","secret":true}'})).status,400);
  assert.equal((await request(local.port,'/api/session',{headers,method:'POST',body:' '.repeat(4097)})).status,413);
  assert.equal((await request(local.port,'/api/sidebar/ocr',{headers,method:'POST',body:'{"enabled":"true"}'})).status,400);
  assert.equal((await request(local.port,'/api/sidebar/ocr',{headers:{...headers,Origin:'null'},method:'POST',body:'{"enabled":true}'})).status,403);
  response = await request(local.port,'/api/sidebar/ocr',{headers,method:'POST',body:'{"enabled":true}'});
  assert.equal(response.status,200);
  assert.equal(JSON.parse(response.body).ocr.enabled,true);
  assert.equal(captures,0,'enabling state alone does not execute capture in the HTTP handler');
  await request(local.port,'/api/session',{headers,method:'POST',body:JSON.stringify(guarded({owned:[],route:'auto'}))});
  assert.equal((await request(local.port,'/api/ocr',{headers,method:'POST',body:'{}'})).status,200);
  assert.equal(captures,1);
  const model = JSON.parse((await request(local.port,'/api/sidebar',{headers})).body);
  assert.equal(model.offers.length,3);
  assert.deepEqual(model.owned,[]);
});

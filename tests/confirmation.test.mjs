import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BackgroundSidebar, SessionValidationError, SessionConflictError} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json', import.meta.url), 'utf8'));
const {version:appVersion} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const noAttack = {id:'fixture_no_attack', name:'隔离测试：无法普攻', description:'你无法进行普通攻击。', availability:'current', recommendable:true};
const offers = [noAttack.id, 'with_haste', 'ravenous_bind'];
function setup(options = {}) {
  let clock = Date.parse('2026-10-24T00:00:00Z');
  let snapshot = {connection:{status:'connected'}, phase:'InProgress', gameId:'fixture-123', championId:'Gwen', level:12, gameTime:600, items:[], stats:{abilityPower:200}, mode:{known:true,isMayhem:true}, observedAt:new Date(clock).toISOString()};
  const collector = {getSnapshot:() => structuredClone(snapshot)};
  const sidebar = new BackgroundSidebar({collector, data:{...data, augments:[...data.augments, noAttack]}, itemsCatalog, now:() => clock, scanner:async () => ({status:'recognized', code:'title-layout-confirmed', proposals:offers.map(id => ({id}))}), ...options});
  return {sidebar, collector, update:values => {snapshot = {...snapshot,...values};}, advance:ms => {clock += ms;}};
}
const confirmation = (model, id = noAttack.id) => ({id, gameId:model.gameId, revision:model.sessionRevision});
async function folder(t) {
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:/Chatgpt/work/2026-10-24/hexguide-live-test/tests';
  await mkdir(root, {recursive:true});
  const directory = await mkdtemp(path.join(root, 'confirm-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return directory;
}

test('new browsing rules are visible immediately while the active game keeps its offers and confirmed choices', async t => {
  const {sidebar, collector, update} = setup();
  const retired = {...noAttack, availability:'retired-in-source', recommendable:false, retiredPatch:'26.22'};
  const fresh = {...noAttack, id:'fixture_new_augment', name:'新资料强化符文'};
  const catalog = (augmentPatch, augments) => {
    const content = JSON.stringify({meta:{augmentPatch}, augments});
    return {content, augmentPatch, revision:createHash('sha256').update(content).digest('hex')};
  };
  const original = catalog('26.21', [...data.augments, noAttack]);
  const nextAugments = [...data.augments, retired, fresh];
  const next = catalog('26.22', nextAugments);
  let browsing = original, match = original;
  const server = await createLocalServer({collector, sidebar, getCatalog:scope => scope === 'match' ? match : browsing,
    staticDirectory:fileURLToPath(new URL('../dist', import.meta.url))});
  t.after(() => server.close());
  const request = (endpoint, options) => fetch(`http://127.0.0.1:${server.port}${endpoint}`, options);
  const authorization = {headers:{'X-HexGuide-Session':server.token}};
  const status = () => request('/api/status', authorization).then(response => response.json());

  await sidebar.scan();
  await sidebar.confirmOffer(confirmation(sidebar.getModel()));
  sidebar.scanner = async () => ({status:'recognized', proposals:['recursion','firebrand','thread_the_needle'].map(id => ({id}))});
  await sidebar.scan();
  const before = sidebar.getModel();
  assert.equal(before.pendingOffers.length, 1);
  browsing = next;
  sidebar.stageCatalog(nextAugments, () => { match = next; });
  assert.equal((await request('/api/status')).status, 401);
  assert.deepEqual(await status(), {appVersion, catalogRevision:next.revision, augmentPatch:'26.22', matchCatalogRevision:original.revision, matchAugmentPatch:'26.21'});
  assert.deepEqual(await request('/api/health', authorization).then(response => response.json()), {ok:true, version:appVersion, localOnly:true});
  for (const [endpoint, expected] of [['/data.json', next], ['/data.json?scope=match', original]]) {
    const response = await request(endpoint);
    assert.equal(response.headers.get('X-HexGuide-Catalog-Revision'), expected.revision);
    assert.equal(await response.text(), expected.content);
  }
  assert.equal(sidebar.getModel().sessionRevision, before.sessionRevision);
  assert.deepEqual(sidebar.getModel().owned.map(augment => augment.id), [noAttack.id]);
  assert.deepEqual(sidebar.getModel().pendingOffers, before.pendingOffers);

  update({connection:{status:'waiting'}, phase:'None', gameId:null, gameTime:null});
  assert.deepEqual(sidebar.getSession().owned, [noAttack.id]);
  assert.equal((await status()).matchCatalogRevision, original.revision);
  update({connection:{status:'connected'}, phase:'InProgress', stage:'live', gameId:'new-game', gameTime:1});
  const current = sidebar.getModel();
  assert.equal(current.gameId, 'new-game');
  assert.deepEqual(current.owned, []);
  assert.deepEqual(current.pendingOffers, []);
  assert.equal((await status()).matchCatalogRevision, next.revision);
  assert.equal((await request('/data.json?scope=match', {method:'HEAD'})).headers.get('X-HexGuide-Catalog-Revision'), next.revision);
  const staleSelection = await request('/api/session', {method:'POST', headers:authorization.headers,
    body:JSON.stringify({owned:[noAttack.id], route:'auto', expectedGameId:before.gameId,
      expectedGameEpoch:before.gameEpoch, expectedRevision:before.sessionRevision})});
  assert.equal(staleSelection.status, 409);
  assert.deepEqual((await staleSelection.json()).session, sidebar.getSession());
  await assert.rejects(sidebar.setSession({owned:[noAttack.id], route:'auto'}), SessionValidationError);
  assert.deepEqual((await sidebar.setSession({owned:[fresh.id], route:'auto'})).owned, [fresh.id]);
});

test('restart with a newer catalog retains already owned retired augments from the same game', async t => {
  const dataDirectory = await folder(t);
  await writeFile(path.join(dataDirectory, 'session.json'), JSON.stringify({gameId:'fixture-123', revision:4, route:'tank', owned:[noAttack.id]}));
  const retired = {...noAttack, availability:'retired-in-source', recommendable:false, retiredPatch:'26.22'};
  const {sidebar} = setup({dataDirectory, data:{...data, augments:[...data.augments, retired]}});
  await sidebar.load();
  t.after(() => sidebar.stop());
  assert.deepEqual(sidebar.getModel().owned.map(augment => augment.id), [noAttack.id]);
  assert.deepEqual((await sidebar.setSession({owned:[noAttack.id], route:'spell'})).owned, [noAttack.id]);
  await sidebar.setSession({owned:[], route:'auto'});
  await assert.rejects(sidebar.setSession({owned:[noAttack.id], route:'auto'}), SessionValidationError);
});

test('atomic confirmation returns a recalculated build and next list, then reacts to opponent equipment', async t => {
  const dataDirectory = await folder(t);
  const {sidebar,update} = setup({dataDirectory});
  await sidebar.scan();
  const before = sidebar.getModel();
  assert.ok(before.plan.choices.some(choice => choice.id === 'attack'));
  assert.ok(before.plan.buildItems.some(item => item.id === '3115'));
  const confirmed = await sidebar.confirmOffer(confirmation(before));
  assert.equal(confirmed.sessionRevision, before.sessionRevision + 1);
  assert.deepEqual(confirmed.owned.map(a => a.id), [noAttack.id]);
  assert.deepEqual(confirmed.offers, []);
  assert.ok(confirmed.plan.choices.every(choice => choice.id !== 'attack'));
  assert.ok(confirmed.plan.buildItems.every(item => !['3115','3153'].includes(item.id)));
  assert.ok(confirmed.plan.nextAugments.length > 0);
  assert.ok(confirmed.plan.nextAugments.every(augment => augment.id !== noAttack.id));
  assert.ok(confirmed.plan.context.some(text => text.includes(noAttack.name)));
  const saved = JSON.parse(await readFile(path.join(dataDirectory,'session.json'),'utf8'));
  assert.deepEqual(saved.owned,[noAttack.id]);
  const beforeEnemy = confirmed.plan.nextAugments.map(a => a.id);
  update({teams:{status:'detected', observedAt:'2026-10-24T00:00:00Z', allies:[], enemies:[{championId:'Ornn',level:12,items:[{id:'3065',count:1}]}]}});
  const adapted = sidebar.getModel();
  assert.equal(adapted.sessionRevision, confirmed.sessionRevision, 'live enemy changes must remain visible at the same selection revision');
  assert.ok(adapted.plan.buildItems.some(item => item.id === '3135'));
  assert.ok(adapted.plan.enemyContext.signals.some(signal => signal.id === 'magic-resist'));
  assert.notDeepEqual(adapted.plan.nextAugments.map(a => a.id), beforeEnemy);
  await sidebar.stop();
});

test('confirmation retains unanswered choices beyond a minute and rejects rerolled, foreign-game and stale concurrent choices', async () => {
  const {sidebar,update,advance} = setup();
  await sidebar.scan();
  const first = sidebar.getModel();
  const pair = await Promise.allSettled([sidebar.confirmOffer(confirmation(first)),sidebar.confirmOffer(confirmation(first))]);
  assert.equal(pair.filter(result => result.status === 'fulfilled').length,1);
  assert.ok(pair.find(result => result.status === 'rejected').reason instanceof SessionConflictError);
  await sidebar.setSession({owned:[],route:'auto'});
  await sidebar.scan();
  const stale = sidebar.getModel();
  sidebar.scanner = async () => ({status:'recognized',proposals:['recursion','firebrand','thread_the_needle'].map(id => ({id}))});
  await sidebar.scan();
  await assert.rejects(sidebar.confirmOffer(confirmation(stale)),SessionConflictError);
  await sidebar.scan();
  const expired = sidebar.getModel();
  advance(60_001);
  const late = await sidebar.confirmOffer(confirmation(expired,'recursion'));
  assert.deepEqual(late.owned.map(augment => augment.id),['recursion']);
  await sidebar.scan();
  const oldGame = sidebar.getModel();
  update({gameId:'fixture-next',gameTime:1});
  await assert.rejects(sidebar.confirmOffer(confirmation(oldGame,'recursion')),SessionConflictError);
  assert.deepEqual(sidebar.getSession().owned,[]);
  for (const value of [{...confirmation(oldGame),extra:true},{id:'missing',gameId:null,revision:0},{id:noAttack.id,gameId:'../bad',revision:0},{id:noAttack.id,gameId:null,revision:-1},null]) await assert.rejects(sidebar.confirmOffer(value),SessionValidationError);
});

test('sidebar retains only whitelisted OCR codes and diagnostic counts', async () => {
  const {sidebar,update} = setup({scanner:async () => ({status:'unavailable',code:'title-name-unmatched',diagnostics:{width:2560,height:1440,lineCount:3,frameId:'private',text:'private screen text',path:'C:/private',layoutCount:0,exactTitleCount:NaN,initializationMs:0,captureMs:20.5,recognitionMs:NaN,totalMs:60001,runtimeReused:true}})});
  await sidebar.scan();
  assert.equal(sidebar.getModel().ocr.code,'title-name-unmatched');
  assert.deepEqual(sidebar.getModel().ocr.diagnostics,{width:2560,height:1440,lineCount:3,layoutCount:0,initializationMs:0,captureMs:20.5,runtimeReused:true});
  assert.doesNotMatch(JSON.stringify(sidebar.getModel().ocr),/private/);
  sidebar.scanner = async () => ({status:'waiting',code:'private screen text'});
  await sidebar.scan();
  assert.equal(sidebar.getModel().ocr.code,undefined);
  assert.equal(sidebar.getModel().ocr.diagnostics,undefined);
  sidebar.scanner = async () => ({status:'unavailable',code:'ocr-no-text'});
  await sidebar.scan();
  update({phase:'EndOfGame'});
  assert.equal(sidebar.getModel().ocr.code,undefined);
});

test('confirmation never reports success after a game boundary during persistence', async () => {
  const {sidebar,update} = setup();
  await sidebar.scan();
  const model = sidebar.getModel();
  let finish;
  sidebar.persist = () => new Promise(resolve => {finish=resolve;});
  const confirmationPending = sidebar.confirmOffer(confirmation(model));
  update({phase:'EndOfGame'});
  finish();
  await assert.rejects(confirmationPending,SessionConflictError);
  assert.deepEqual(sidebar.getSession().owned,[]);
});

test('null game IDs are allowed while first LCU discovery during saving is not a new game', async () => {
  const {sidebar,update} = setup();
  update({gameId:null});
  await sidebar.scan();
  const model=sidebar.getModel();
  assert.equal(model.gameId,null);
  let finish;
  sidebar.persist=() => new Promise(resolve => {finish=resolve;});
  const pending=sidebar.confirmOffer(confirmation(model));
  update({gameId:'first-discovery'});
  finish();
  const result=await pending;
  assert.equal(result.gameId,'first-discovery');
  assert.deepEqual(result.owned.map(a=>a.id),[noAttack.id]);
});

test('a transient poll exception does not permanently stop background recognition', async t => {
  const {sidebar} = setup();
  t.after(() => sidebar.stop());
  let count=0;
  const resumed = new Promise(resolve => {
    sidebar.pollOnce = async () => { if (++count === 1) throw new Error('isolated fixture failure'); sidebar.stopped=true;resolve(); };
  });
  sidebar.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sidebar.getModel().ocr.code,'scan-loop-failed');
  assert.equal(sidebar.getModel().selectionDiagnostics.scanCode,'scan-loop-failed');
  await Promise.race([resumed,new Promise((_,reject) => { const timeout=setTimeout(() => reject(new Error('Recognition loop failed to resume')),2500);timeout.unref(); })]);
  assert.equal(count,2);
});

function request(port,target,{headers={},method='GET',body}={}) {
  return new Promise((resolve,reject) => {
    const req=http.request({host:'127.0.0.1',port,path:target,method,headers},res => { const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))})); });
    req.on('error',reject);req.end(body);
  });
}
test('confirmation HTTP endpoint authenticates and returns current model or conflict without a second GET', async t => {
  const directory=await folder(t);
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>isolated fixture</title>');
  const {sidebar,collector}=setup();
  await sidebar.scan();
  const original=sidebar.getModel();
  const local=await createLocalServer({collector,sidebar,staticDirectory:directory,token:'fixture-confirmation-token'});
  t.after(()=>local.close());
  const headers={'X-Hexguide-Session':local.token,'Content-Type':'application/json'};
  const body=JSON.stringify({...confirmation(original),pendingId:original.pendingOffers[0].pendingId});
  assert.equal((await request(local.port,'/api/session/confirm',{method:'POST',body})).status,401);
  assert.equal((await request(local.port,'/api/session/confirm',{method:'POST',body,headers:{...headers,Origin:'https://foreign.example'}})).status,403);
  assert.equal((await request(local.port,'/api/session/confirm',{method:'POST',body:'{}',headers})).status,400);
  const response=await request(local.port,'/api/session/confirm',{method:'POST',body,headers});
  assert.equal(response.status,200);
  assert.deepEqual(response.body.owned.map(a=>a.id),[noAttack.id]);
  assert.equal(response.body.sessionRevision,original.sessionRevision+1);
  assert.ok(response.body.plan.buildItems.length && response.body.plan.nextAugments.length);
  assert.equal((await request(local.port,'/api/session/confirm',{method:'POST',body,headers})).status,409);
});

test('explicit session reset clears unanswered rounds even with empty owned choices and requires current authenticated guards', async t => {
  const directory=await folder(t);
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>isolated fixture</title>');
  const {sidebar,collector}=setup(); await sidebar.scan(); const original=sidebar.getModel();
  assert.deepEqual(original.owned,[]); assert.equal(original.route,'auto'); assert.equal(original.pendingOffers.length,1);
  const local=await createLocalServer({collector,sidebar,staticDirectory:directory,token:'fixture-reset-token'});
  t.after(()=>local.close()); const headers={'X-Hexguide-Session':local.token,'Content-Type':'application/json'};
  const body=JSON.stringify({gameId:original.gameId,revision:original.sessionRevision});
  assert.equal((await request(local.port,'/api/session/reset',{method:'POST',body})).status,401);
  assert.equal((await request(local.port,'/api/session/reset',{method:'POST',body,headers:{...headers,Origin:'https://foreign.example'}})).status,403);
  assert.equal((await request(local.port,'/api/session/reset',{method:'POST',body:'{}',headers})).status,400);
  assert.equal((await request(local.port,'/api/session/reset',{method:'POST',body:JSON.stringify({gameId:original.gameId,revision:original.sessionRevision,extra:true}),headers})).status,400);
  const result=await request(local.port,'/api/session/reset',{method:'POST',body,headers});
  assert.equal(result.status,200); assert.deepEqual(result.body.pendingOffers,[]); assert.deepEqual(result.body.offers,[]);
  assert.deepEqual(result.body.owned,[]); assert.equal(result.body.route,'auto');
  assert.equal(result.body.sessionRevision,original.sessionRevision+1);
  assert.equal((await request(local.port,'/api/session/reset',{method:'POST',body,headers})).status,409);
});

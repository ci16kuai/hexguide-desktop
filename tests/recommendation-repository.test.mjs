import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm, readdir} from 'node:fs/promises';
import path from 'node:path';
import {RecommendationRepository, validateRecommendationSnapshot, validateReferenceBuildSnapshot, RECOMMENDATION_CACHE_LIMITS as LIMITS} from '../server/recommendation-repository.mjs';

const TIME = Date.parse('2026-10-25T04:00:00Z');
const HEROES = [{id:'Ahri',key:103}, {id:'Annie',key:1}, {id:'Jinx',key:222}, {id:'Ashe',key:22}];
const AUGMENTS = [{id:'alpha', gameDataId:101}, {id:'beta', gameDataId:102}, {id:'gamma',gameDataId:103}];
const CACHE_NAME = 'recommendation-cache-v1.json';
const WORK = 'H:/Chatgpt/work/2026-10-25/hexguide-build-policy/repository-tests';
const clone = value => structuredClone(value);
const metrics = (extra = {}) => ({sampleCount:1000, winRate:0.55, pickRate:0.25, ...extra});
function snapshot(id = 103, fetchedAt = TIME) {
  const profile = metrics({itemSet:[{id:3100},{id:3089},{id:4645}], routes:[metrics({
    purchaseOrder:[{id:3100},{id:4645},{id:3089}],
    starters:[metrics({items:[{id:1052}]})],
    boots:[metrics({item:{id:0},kind:'boots'})],
    laterItems:[metrics({item:{id:3135},kind:'later'})]
  })]});
  const items = metrics({all:[metrics({id:3100})], slots:{1:[metrics({id:3100})]}});
  const builds = metrics({archetypes:[metrics({key:'ap', profiles:[profile]})]});
  const augment = metrics({id:101, rank:1, tier:'S', augmentTier:'A', augmentRank:2,
    stageAgnostic:false,availableStages:[1,2]});
  return {
    championId:id,
    meta:{sourceName:'ARAMKit',sourceUrl:'https://aramkit.com/',patch:'16.21',dataDate:'2026-10-24',
      buildTimeUnixMs:TIME - 3600000,fetchedAt:new Date(fetchedAt).toISOString(),dataPath:'data/16.21-fixture',
      scope:'all',pairCoverage:'published-top-10'},
    detail:{champion:{id,stats:metrics({physicalDamageToChampions:5000,magicDamageToChampions:30000,trueDamageToChampions:1000})},
      augmentCombinations:[metrics({augmentIds:[101,102]})],
      augments:{all:[augment],stages:{1:[clone(augment)],2:[clone(augment)]}},
      items:{filtered:clone(items),unfiltered:clone(items)},builds:{filtered:clone(builds),unfiltered:clone(builds)}},
    single:{items:[{augmentId:101,...clone(items)}],builds:[{augmentId:101,...clone(builds)}]}
  };
}
function reference(championId = 'Ahri', mode = 'aram', observedAt = TIME) {
  const sourceUrl = mode === 'aram'
    ? `https://op.gg/lol/modes/aram/${championId.toLowerCase()}/items?patch=16.21`
    : `https://op.gg/lol/champions/${championId.toLowerCase()}/items?patch=16.21&type=ranked`;
  return {championId,mode,patch:'16.21',comparable:true,source:'OP.GG',sourceUrl,
    sourceChampionId:HEROES.find(hero=>hero.id===championId)?.key,region:'global',
    tier:mode==='aram'?'all':'emerald_plus',position:mode==='aram'?null:'mid',
    observedAt:new Date(observedAt).toISOString(),items:[{id:3100,winRate:0.53,sampleCount:500,pickRate:0.2,scope:'single-item'}]};
}
function statistics() {
  const cohortId = 'aramhex-cn-fixture';
  const row = (augmentId, sourceAugmentId, games, wins, extra = {}) => ({augmentId,sourceAugmentId,
    games,wins,cohortId,lowSample:games < 3000,provisional:false,winRate:99,...extra});
  return {schemaVersion:1,meta:{mode:'aram-mayhem',patch:'16.21',cohortId,lowSampleThreshold:3000,
    source:{name:'AramHex',url:'https://github.com/czgreat/aramhex-data'}},
    champions:[{championId:'Ahri',sourceChampionId:'103',cohortId,games:20000,wins:12000,
      augments:[row('alpha','101',6000,3600),row('beta','102',1000,900),row('gamma','103',4000,2400,{provisional:true})]}]};
}
function repository(extra = {}) {
  return new RecommendationRepository({champions:HEROES,augments:AUGMENTS,
    statisticsSnapshot:statistics(),now:() => TIME,referenceClient:{async load(){return null;}},...extra});
}
async function directory(t) {
  await mkdir(WORK,{recursive:true});
  const folder = await mkdtemp(path.join(WORK,'test-'));
  t.after(async () => {
    assert.ok(path.resolve(folder).startsWith(path.resolve(WORK) + path.sep));
    await rm(folder,{recursive:true,force:true});
  });
  return folder;
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {resolve=yes;});
  return {promise,resolve};
}

test('construct/load/get never starts network; unknown champions cannot trigger it', async () => {
  let calls=0;
  const repo=repository({client:{load(){calls++;throw new Error('must not request');}}});
  await repo.load();
  assert.equal(repo.get('Ahri').status,'missing');
  assert.equal(repo.get(103).augmentStatistics.alpha.winRate,0.6);
  assert.equal(repo.get(103).championId,'Ahri');
  assert.equal(repo.get('Ahri').sourceChampionId,103);
  assert.equal(repo.get('unknown').championId,null);
  assert.equal(repo.get('unknown').sourceChampionId,null);
  assert.equal((await repo.ensure('unknown')).status,'unknown-champion');
  assert.equal(calls,0);
  assert.equal(repo.get('Ahri').ordinaryAram,null);
  assert.deepEqual(repo.get('Ahri').configuredWeights,{mayhem:0.8,aram:0.2});
  await repo.close();
});

test('static rates use exact wins/games; low samples are retained but not comparable', () => {
  const rows=repository().get('Ahri').augmentStatistics;
  assert.equal(rows.alpha.winRate,0.6);
  assert.equal(rows.alpha.comparable,true);
  assert.equal(rows.beta.winRate,0.9);
  assert.equal(rows.beta.comparable,false);
  assert.equal(rows.beta.pickRate,null);
  assert.equal(rows.gamma,undefined);
  assert.equal(rows.alpha.source,'AramHex');
  assert.ok(Object.isFrozen(rows));
});

test('static cohorts, patches, mode, identity, exclusion and repeated IDs fail closed', () => {
  for (const change of [
    s=>s.meta.patch='16.20', s=>s.meta.mode='aram', s=>s.champions[0].cohortId='another',
    s=>s.champions[0].sourceChampionId='1',s=>s.champions[0].augments[0].cohortId='pbe',
    s=>s.champions[0].augments[0].sourceAugmentId='999',
    s=>s.meta.excludedAugments={'101':{}},
    s=>s.champions[0].augments.push(clone(s.champions[0].augments[0]))
  ]) {
    const source=statistics(); change(source);
    assert.equal(repository({statisticsSnapshot:source}).get('Ahri').augmentStatistics.alpha,undefined);
  }
  const duplicate=statistics();duplicate.champions.push(clone(duplicate.champions[0]));
  assert.deepEqual(Object.keys(repository({statisticsSnapshot:duplicate}).get('Ahri').augmentStatistics),[]);
  assert.equal(repository({champions:[{id:'Ahri',key:1}]}).get('Ahri').status,'unknown-champion');
});

test('ensure deduplicates a champion request and stores immutable validated aggregates', async () => {
  const gate=deferred();let calls=0;let seen;
  const repo=repository({client:{async load(value){calls++;seen=value;await gate.promise;return snapshot();}}});
  const first=repo.ensure('Ahri');const second=repo.ensure(103);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(repo.get('Ahri').status,'loading');
  assert.equal(calls,1);
  gate.resolve();
  const results=await Promise.all([first,second]);
  assert.deepEqual(seen,{championId:103,patch:'16.21'});
  assert.equal(results[0].status,'ready');
  assert.strictEqual(results[0].snapshot,results[1].snapshot);
  assert.ok(Object.isFrozen(results[0].snapshot.detail.items.filtered.all));
  assert.equal((await repo.ensure('Ahri')).status,'ready');assert.equal(calls,1);
  await repo.close();
});

test('the allowlisted raw shape preserves item slots/routes/rounds and removes unrelated content', () => {
  const raw=snapshot();
  raw.playerName='must-not-persist';raw.account={puuid:'must-not-persist'};
  raw.detail.champion.identity='must-not-persist';raw.detail.items.filtered.all[0].image='data:image/png;secret';
  raw.meta.arbitrarySession='must-not-persist';
  const accepted=validateRecommendationSnapshot(raw,{championId:103,patch:'16.21',now:TIME});
  assert.ok(!JSON.stringify(accepted).includes('must-not-persist'));
  assert.ok(!JSON.stringify(accepted).includes('data:image'));
  assert.equal(accepted.detail.items.filtered.slots[1][0].id,3100);
  assert.deepEqual(accepted.detail.augments.all[0].availableStages,[1,2]);
  assert.equal(accepted.detail.augments.stages[1][0].id,101);
  assert.deepEqual(accepted.single.builds[0].archetypes[0].profiles[0].routes[0].purchaseOrder.map(x=>x.id),[3100,4645,3089]);
  assert.equal(accepted.single.builds[0].archetypes[0].profiles[0].routes[0].boots[0].item.id,0);
  raw.detail.items.filtered.all[0].id=999;assert.equal(accepted.detail.items.filtered.all[0].id,3100);
});

test('snapshot validation rejects foreign cohorts, invalid rates and inconsistent builds', () => {
  for (const change of [
    s=>s.meta.patch='16.20',s=>s.meta.sourceUrl='https://untrusted.test/',s=>s.meta.scope='high',
    s=>s.meta.dataPath='data/16.21/../../bad',s=>s.meta.dataDate='2026-02-31',
    s=>s.detail.champion.id=1,s=>s.detail.items.filtered.all[0].winRate=1.2,
    s=>s.detail.builds.filtered.archetypes[0].profiles[0].routes[0].purchaseOrder[0].id=999,
    s=>s.detail.augments.all.push(clone(s.detail.augments.all[0])),
    s=>s.single.items[0].all.push(clone(s.single.items[0].all[0])),
    s=>s.detail.items.filtered.slots['7']=[],s=>s.detail.augments.stages['5']=[],
    s=>s.meta.buildTimeUnixMs=TIME+3600000
  ]) {
    const raw=snapshot();change(raw);
    assert.throws(()=>validateRecommendationSnapshot(raw,{championId:103,patch:'16.21',now:TIME}));
  }
});

test('TTL refreshes exactly after 24 hours, without changing metadata freshness', async () => {
  let clock=TIME;let calls=0;
  const repo=repository({now:()=>clock,client:{async load(){calls++;return snapshot(103,clock);}}});
  await repo.ensure('Ahri');clock+=LIMITS.ttlMs-1;
  await repo.ensure('Ahri');assert.equal(calls,1);
  clock++;assert.equal(repo.get('Ahri').status,'stale');
  await repo.ensure('Ahri');assert.equal(calls,2);assert.equal(repo.get('Ahri').status,'ready');
  assert.equal(repo.get('Ahri').snapshot.meta.fetchedAt,new Date(clock).toISOString());
  await repo.close();
});

test('provider failure backs off exponentially and never replaces last valid snapshot', async () => {
  let clock=TIME;let calls=0;
  const repo=repository({now:()=>clock,client:{async load(){calls++;if(calls>1)throw Object.assign(new Error('private network detail'),{code:'timeout'});return snapshot();}}});
  await repo.ensure('Ahri');const good=repo.get('Ahri').snapshot;
  clock+=LIMITS.ttlMs;
  const failed=await repo.ensure('Ahri');assert.equal(failed.status,'stale');assert.equal(failed.errorCode,'timeout');
  assert.strictEqual(failed.snapshot,good);assert.equal(failed.retryAt,clock+LIMITS.retryMs);
  for(let i=0;i<20;i++)await repo.ensure('Ahri');assert.equal(calls,2);
  clock+=LIMITS.retryMs;await repo.ensure('Ahri');assert.equal(calls,3);
  assert.equal(repo.get('Ahri').retryAt,clock+LIMITS.retryMs*2);
  assert.ok(!JSON.stringify(repo.get('Ahri')).includes('private network detail'));
  await repo.close();
});

test('an old provider memory snapshot cannot reset repository freshness', async () => {
  let clock=TIME;let calls=0;
  const repo=repository({now:()=>clock,client:{async load(){calls++;return snapshot();}}});
  await repo.ensure('Ahri');const first=repo.get('Ahri').snapshot;
  clock+=LIMITS.ttlMs;
  assert.equal((await repo.ensure('Ahri')).status,'stale');
  assert.strictEqual(repo.get('Ahri').snapshot,first);
  assert.equal(repo.get('Ahri').errorCode,'invalid-data');
  await repo.ensure('Ahri');assert.equal(calls,2);await repo.close();
});

test('bounded LRU persists only three champions and reopens without network', async t => {
  const dataDirectory=await directory(t);let calls=0;
  const client={async load({championId}){calls++;return snapshot(championId);}};
  const repo=repository({dataDirectory,client});
  for(const hero of HEROES)await repo.ensure(hero.id);
  assert.equal(repo.get('Ahri').status,'missing');
  await repo.close();
  const saved=JSON.parse(await readFile(path.join(dataDirectory,CACHE_NAME),'utf8'));
  assert.equal(saved.entries.length,3);
  assert.deepEqual(saved.entries.map(x=>x.championId),['Annie','Jinx','Ashe']);
  assert.deepEqual((await readdir(dataDirectory)).filter(x=>x.endsWith('.tmp')),[]);
  const restored=repository({dataDirectory,client});await restored.load();
  assert.equal(restored.get('Ashe').status,'ready');
  await restored.ensure('Ashe');assert.equal(calls,4);
  assert.equal(restored.get('Ashe').snapshot.meta.sourceName,'ARAMKit');
  await restored.close();
});

test('corrupt, oversized and cross-patch cache files are ignored without network', async t => {
  const dataDirectory=await directory(t);const file=path.join(dataDirectory,CACHE_NAME);
  for(const contents of ['{broken',JSON.stringify({schemaVersion:1,patch:'16.20',entries:[]}),
    JSON.stringify({schemaVersion:1,patch:'16.21',entries:Array(4).fill({})}), ' '.repeat(LIMITS.fileBytes+1)]) {
    await writeFile(file,contents);
    const repo=repository({dataDirectory});await repo.load();
    assert.equal(repo.get('Ahri').snapshot,null);assert.equal(repo.get('Ahri').storageStatus,'invalid-cache');
    await repo.close();assert.equal((await readFile(file,'utf8')).length,contents.length);
  }
});

test('invalid refreshed data cannot overwrite a valid disk cache', async t => {
  const dataDirectory=await directory(t);let clock=TIME;let calls=0;
  const client={async load(){calls++;const raw=snapshot(103,clock);if(calls>1)raw.detail.champion.id=1;return raw;}};
  const repo=repository({dataDirectory,client,now:()=>clock});
  await repo.ensure('Ahri');await repo.close();
  const before=await readFile(path.join(dataDirectory,CACHE_NAME),'utf8');
  const second=repository({dataDirectory,client,now:()=>clock});await second.load();clock+=LIMITS.ttlMs;
  assert.equal((await second.ensure('Ahri')).status,'stale');await second.close();
  assert.equal(await readFile(path.join(dataDirectory,CACHE_NAME),'utf8'),before);
});

test('only three network requests may be in flight, and close waits for accepted work', async () => {
  const gate=deferred();let calls=0;
  const repo=repository({client:{async load({championId}){calls++;await gate.promise;return snapshot(championId);}}});
  const jobs=HEROES.slice(0,3).map(hero=>repo.ensure(hero.id));
  await new Promise(resolve=>setImmediate(resolve));
  const busy=await repo.ensure('Ashe');assert.equal(busy.errorCode,'busy');assert.equal(calls,3);
  let closed=false;const closing=repo.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  gate.resolve();await Promise.all(jobs);await closing;assert.equal(closed,true);
  await repo.ensure('Ashe');assert.equal(calls,3);
});

test('read-only storage failure keeps the accepted in-memory aggregate usable', async t => {
  const dataDirectory=await directory(t);
  await mkdir(path.join(dataDirectory,CACHE_NAME));
  const repo=repository({dataDirectory,client:{async load(){return snapshot();}}});
  assert.equal((await repo.ensure('Ahri')).status,'ready');await repo.close();
  assert.equal(repo.get('Ahri').status,'ready');assert.equal(repo.get('Ahri').storageStatus,'write-failed');
});

test('a reference request never delays the availability of completed Mayhem data', async () => {
  const gate=deferred();
  const repo=repository({client:{async load(){return snapshot();}},referenceClient:{async load(){await gate.promise;return null;}}});
  const loading=repo.ensure('Ahri');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(repo.get('Ahri').status,'ready');
  assert.equal(repo.get('Ahri').mayhemStatus,'ready');
  assert.equal(repo.get('Ahri').referenceStatus,'loading');
  assert.ok(repo.get('Ahri').snapshot);
  gate.resolve();await loading;
  assert.equal(repo.get('Ahri').status,'ready');assert.equal(repo.get('Ahri').referenceErrorCode,'unavailable');
  await repo.close();
});

test('ordinary ARAM remains usable when Mayhem fails, and survives a cache reload', async t => {
  const dataDirectory=await directory(t);let requested;
  const repo=repository({dataDirectory,client:{async load(){throw new Error('provider unavailable');}},
    referenceClient:{async load(options){requested=options;return reference();}}});
  const result=await repo.ensure('Ahri');
  assert.deepEqual(requested,{championId:'Ahri',championSlug:'ahri',patch:'16.21'});
  assert.equal(result.status,'ready');assert.equal(result.snapshot,null);
  assert.equal(result.mayhemStatus,'error');assert.equal(result.referenceStatus,'ready');
  assert.equal(result.ordinaryAram.mode,'aram');assert.equal(result.summonersRift,null);
  await repo.close();
  const restored=repository({dataDirectory});await restored.load();
  assert.equal(restored.get('Ahri').ordinaryAram.items[0].winRate,0.53);
  assert.equal(restored.get('Ahri').ordinaryAram.sourceChampionId,103);
  assert.equal(restored.get('Ahri').ordinaryAram.region,'global');
  assert.equal(restored.get('Ahri').ordinaryAram.tier,'all');
  assert.equal(restored.get('Ahri').ordinaryAram.position,null);
  assert.equal(restored.get('Ahri').referenceStatus,'ready');assert.equal(restored.get('Ahri').snapshot,null);
  await restored.close();
});

test('Summoners Rift fallback is explicitly separate from ordinary ARAM', async () => {
  const repo=repository({client:{async load(){return snapshot();}},referenceClient:{async load(){return reference('Ahri','summoners-rift');}}});
  const result=await repo.ensure('Ahri');assert.equal(result.ordinaryAram,null);
  assert.equal(result.summonersRift.mode,'summoners-rift');assert.equal(result.snapshot.championId,103);
  assert.equal(result.summonersRift.tier,'emerald_plus');assert.equal(result.summonersRift.position,'mid');
  await repo.close();
});

test('reference snapshots validate exact hero/mode/patch/source routes and whitelist fields', () => {
  const raw=reference();raw.html='<html>never save</html>';raw.items[0].player='never save';
  raw.observedAt=TIME;
  const accepted=validateReferenceBuildSnapshot(raw,{championId:'Ahri',patch:'16.21',now:TIME});
  assert.equal(accepted.observedAt,new Date(TIME).toISOString());assert.ok(!JSON.stringify(accepted).includes('never save'));
  for(const change of [
    s=>s.mode='mayhem',s=>s.championId='Jinx',s=>s.patch='16.20',s=>s.comparable=false,
    s=>s.source='another',s=>s.sourceUrl='https://op.gg/lol/champions/ahri/items?patch=16.21',
    s=>s.sourceUrl='https://op.gg/lol/modes/aram/jinx/items?patch=16.21',
    s=>s.sourceUrl='https://op.gg/lol/modes/aram/ahri/items?patch=16.20',
    s=>s.sourceUrl='https://op.gg/lol/modes/aram/ahri/items?token=private',
    s=>s.sourceUrl='https://user:password@op.gg/lol/modes/aram/ahri/items',
    s=>s.items[0].winRate=53,s=>s.items[0].sampleCount=-1,s=>s.items[0].scope='invented',
    s=>s.items.push(clone(s.items[0])),s=>s.observedAt=TIME+3600000,
    s=>s.sourceChampionId=1,s=>s.region='Global/secret',s=>s.tier='<html>',s=>s.position=5
  ]) {
    const bad=reference();change(bad);
    assert.throws(()=>validateReferenceBuildSnapshot(bad,{championId:'Ahri',patch:'16.21',now:TIME}));
  }
});

test('reference TTL and failure backoff preserve the previous reference independently', async () => {
  let clock=TIME;let calls=0;
  const repo=repository({now:()=>clock,client:{async load(){return snapshot(103,clock);}},
    referenceClient:{async load(){calls++;if(calls>1)return null;return reference();}}});
  await repo.ensure('Ahri');const previous=repo.get('Ahri').ordinaryAram;
  clock+=LIMITS.ttlMs;await repo.ensure('Ahri');
  assert.equal(repo.get('Ahri').status,'ready');assert.equal(repo.get('Ahri').mayhemStatus,'ready');
  assert.equal(repo.get('Ahri').referenceStatus,'stale');assert.strictEqual(repo.get('Ahri').ordinaryAram,previous);
  await repo.ensure('Ahri');assert.equal(calls,2);
  clock+=LIMITS.retryMs;await repo.ensure('Ahri');assert.equal(calls,3);
  await repo.close();
});

test('the default Mayhem provider stays lazy and refreshes its own memory cache after TTL', async t => {
  const original=globalThis.fetch;let calls=0;let clock=TIME;
  globalThis.fetch=async url=>{
    calls++;
    const raw=snapshot();
    const body=url.endsWith('/versions.json')
      ? {latest:'16.21',versions:[{version:'16.21',dataPath:'data/16.21-fixture',dataDate:'2026-10-24',buildTimeUnixMs:TIME-3600000}]}
      : url.endsWith('-single-augments.json') ? raw.single : raw.detail;
    return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  };
  t.after(()=>{globalThis.fetch=original;});
  const repo=repository({now:()=>clock});await repo.load();repo.get('Ahri');assert.equal(calls,0);
  assert.equal((await repo.ensure('Ahri')).mayhemStatus,'ready');assert.equal(calls,3);
  clock+=LIMITS.ttlMs;
  assert.equal((await repo.ensure('Ahri')).mayhemStatus,'ready');assert.equal(calls,6);
  await repo.close();
});

test('the default reference provider retains blocked cooldowns across retries and champions until 30 minutes', async t => {
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  for (const status of [401,403,429]) {
    let clock=TIME;const calls=[];
    globalThis.fetch=async url=>{calls.push({url:String(url),at:clock});return {ok:false,status};};
    const repo=repository({now:()=>clock,referenceClient:undefined,
      client:{async load(){throw Object.assign(new Error('Offline Mayhem fixture'),{code:'unavailable'});}}});
    try {
      await repo.load();repo.get('Ahri');await repo.ensure('unknown');
      assert.equal(calls.length,0,'construct/load/get/unknown remain lazy');
      await repo.ensure('Ahri');assert.equal(calls.length,1);
      clock+=60_001;
      await repo.ensure('Ahri');await repo.ensure('Jinx');
      assert.equal(calls.length,1,`${status}: repository retry and another hero must share the provider cooldown`);
      clock=TIME+30*60_000-1;
      await repo.ensure('Annie');assert.equal(calls.length,1,'29:59.999 is still blocked');
      clock++;
      await repo.ensure('Ashe');assert.equal(calls.length,2,'the provider cooldown expires at exactly 30 minutes');
      assert.equal(calls[1].at-TIME,30*60_000);
      assert.ok(calls.every(call=>call.url.startsWith('https://op.gg/lol/modes/aram/')),
        'blocked responses must not fall through to the ranked source');

      const isolated=repository({now:()=>clock,referenceClient:undefined,
        client:{async load(){return null;}}});
      try {
        await isolated.ensure('Ahri');assert.equal(calls.length,3,'another repository has its own source state');
        clock+=60_001;
        await repo.ensure('Jinx');assert.equal(calls.length,3,'the second repository cannot clear the first cooldown');
      } finally {await isolated.close();}
    } finally {await repo.close();}
  }
});

test('simultaneous champion refreshes share lazy reference-provider initialization', async t => {
  const original=globalThis.fetch;let clock=TIME;let calls=0;
  const gate=deferred();
  globalThis.fetch=async ()=>{calls++;await gate.promise;return {ok:false,status:429};};
  t.after(()=>{globalThis.fetch=original;});
  const repo=repository({now:()=>clock,referenceClient:undefined,client:{async load(){return null;}}});
  try {
    const pending=Promise.all([repo.ensure('Ahri'),repo.ensure('Jinx')]);
    await new Promise(resolve=>setImmediate(resolve));
    gate.resolve();await pending;
    const initialCalls=calls;
    assert.ok(initialCalls>0 && initialCalls<=2,'only requests already in flight can precede the first blocked response');
    clock+=60_001;
    await repo.ensure('Ahri');await repo.ensure('Jinx');await repo.ensure('Ashe');
    assert.equal(calls,initialCalls,'neither concurrent initializer may discard the shared blocked state');
  } finally {gate.resolve();await repo.close();}
});

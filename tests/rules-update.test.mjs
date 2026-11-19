import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadRules, applyRules, RulesUpdater} from '../server/rules.mjs';

const catalog=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url)));
const published=catalog.augments.filter(a=>a.availability==='current').map(a=>({
  gameDataId:a.gameDataId,sourceGameId:a.sourceGameId,sourcePath:a.sourcePath,name:a.name,enName:a.enName,rarity:a.rarity,
  description:a.description,unresolvedValues:a.unresolvedValues,iconPath:new URL(a.icon).pathname.split('/game/')[1]
}));
const removed=published.shift();
published.push({...removed,gameDataId:90000,sourceGameId:'Fixture',sourcePath:'Augments/Fixture',name:'测试条目'});
function buildPublication({clientPatch='16.22', updatedAt='2026-11-05T01:02:03Z', officialAnnouncement, augments=published}={}) {
  const bytes = Buffer.from(JSON.stringify({schemaVersion:1, clientPatch, augments, officialAnnouncement}));
  return {bytes, manifest:{schemaVersion:1, clientPatch, sha256:createHash('sha256').update(bytes).digest('hex'), updatedAt}};
}
const {bytes, manifest} = buildPublication();
const officialAnnouncement = {version:'16.22.1', url:'https://lol.qq.com/gicp/news/410/37101296.html'};

test('rules use source membership and keep historical stats and retired IDs separate',()=>{
  const next=applyRules(catalog,manifest,bytes);
  assert.equal(catalog.meta.augmentPatch,'26.21');
  assert.equal(next.meta.augmentPatch,'26.22');
  assert.equal(next.meta.statsPatch,catalog.meta.statsPatch);
  assert.equal(next.augments.find(a=>a.gameDataId===removed.gameDataId).recommendable,false);
  assert.equal(next.augments.find(a=>a.gameDataId===90000).descriptionPatch,'26.22');
  assert.throws(()=>applyRules(catalog,manifest,Buffer.from('{}')),/digest/);
});

test('rules replace dated patch notes with the verified official source for that patch', () => {
  const next = buildPublication({officialAnnouncement});
  const dataset = applyRules(catalog, next.manifest, next.bytes);
  assert.equal(dataset.meta.rulesRevision, next.manifest.sha256);
  assert.ok(dataset.meta.sources.some(row => row.url === officialAnnouncement.url && row.version === officialAnnouncement.version));
  assert.ok(dataset.meta.sources.some(row => row.url === 'https://developer.riotgames.com/docs/lol#data-dragon'));
  assert.ok(!dataset.meta.sources.some(row => /patch-26-21-notes/.test(row.url)));

  for (const changes of [{version:'16.21.1'}, {url:'http://lol.qq.com/gicp/news/410/37101296.html'},
    {url:'https://lol.qq.com.invalid/gicp/news/410/37101296.html'}, {url:'https://lol.qq.com/redirect?url=https://example.org'}]) {
    const invalid = buildPublication({officialAnnouncement:{...officialAnnouncement, ...changes}});
    assert.throws(() => applyRules(catalog, invalid.manifest, invalid.bytes), /official rules announcement/);
  }
});

test('a broken or older feed retains the last verified rules across launches',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'hexguide-rules-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const fetcher=async url=>url.endsWith('/index.json')?Response.json(manifest):new Response(bytes);
  assert.equal((await loadRules(catalog,dir,{fetcher})).meta.augmentPatch,'26.22');
  assert.equal((await loadRules(catalog,dir,{fetcher:async()=>{throw Error('offline');}})).meta.augmentPatch,'26.22');
  assert.equal((await loadRules(catalog,dir,{fetcher:async()=>Response.json({...manifest,clientPatch:'16.21'})})).meta.augmentPatch,'26.22');
});

test('a delayed first download publishes while the app is open and scheduled checks reuse the ETag', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexguide-rules-'));
  let poll;
  let cleared = false;
  let releaseDownload;
  let markPayloadStarted;
  const payloadStarted = new Promise(resolve => { markPayloadStarted = resolve; });
  const pendingBytes = new Promise(resolve => { releaseDownload = resolve; });
  const requests = [];
  const accepted = [];
  const updater = await new RulesUpdater({catalog, dataDirectory:directory,
    timers:{setInterval(callback, intervalMs) {
      assert.equal(intervalMs, 60_000);
      poll = callback;
      return 0;
    }, clearInterval(timer) {
      assert.equal(timer, 0);
      cleared = true;
    }},
    fetcher:async (url, {headers}) => {
      requests.push({url, headers});
      if (url.endsWith('/index.json')) {
        return headers?.['If-None-Match'] === '"revision-1"' ? new Response(null, {status:304})
          : Response.json(manifest, {headers:{ETag:'"revision-1"'}});
      }
      markPayloadStarted();
      return new Response(await pendingBytes);
    },
    onUpdate:async snapshot => {
      const cache = JSON.parse(await readFile(path.join(directory, 'rules-v1.json'), 'utf8'));
      accepted.push({snapshot, revision:cache.manifest.sha256});
    }
  }).load();
  t.after(async () => {
    releaseDownload(bytes);
    await updater.close();
    await rm(directory, {recursive:true, force:true});
  });

  assert.equal(updater.getSnapshot(), catalog);
  assert.equal(requests.length, 0);
  updater.start();
  const inFlight = updater.check();
  await payloadStarted;
  poll();
  assert.equal(updater.check(), inFlight);
  assert.equal(updater.getSnapshot(), catalog);
  assert.equal(requests.length, 2);
  releaseDownload(bytes);
  const updated = await inFlight;
  assert.equal(updated.meta.augmentPatch, '26.22');
  assert.deepEqual(accepted, [{snapshot:updated, revision:manifest.sha256}]);

  poll();
  assert.equal(await updater.check(), updated);
  assert.equal(requests.length, 3);
  assert.equal(requests.at(-1).headers['If-None-Match'], '"revision-1"');
  assert.equal(accepted.length, 1);
  await updater.close();
  assert.equal(cleared, true);
  poll();
  assert.equal(requests.length, 3);
});

test('a same-patch replacement is retried after verification fails and older revisions never replace it', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexguide-rules-'));
  const revision = buildPublication({officialAnnouncement, updatedAt:'2026-11-07T01:02:03Z'});
  const olderPatch = buildPublication({clientPatch:'16.21', updatedAt:'2026-11-08T01:02:03Z'});
  let response = {manifest, bytes};
  const payloads = [];
  const validators = [];
  const updates = [];
  const updater = await new RulesUpdater({catalog, dataDirectory:directory, onUpdate:next => updates.push(next),
    fetcher:async (url, {headers}) => {
      if (url.endsWith('/index.json')) {
        validators.push(headers?.['If-None-Match']);
        return Response.json(response.manifest, {headers:{ETag:`"${response.manifest.sha256}"`}});
      }
      payloads.push(url);
      return new Response(response.bytes);
    }
  }).load();
  t.after(async () => {
    await updater.close();
    await rm(directory, {recursive:true, force:true});
  });

  const first = await updater.check();
  response = {...revision, bytes:Buffer.from('{}')};
  assert.equal(await updater.check(), first);
  const cached = JSON.parse(await readFile(path.join(directory, 'rules-v1.json'), 'utf8'));
  assert.equal(cached.manifest.sha256, manifest.sha256);

  response = revision;
  const revised = await updater.check();
  assert.equal(validators.at(-1), `"${manifest.sha256}"`);
  assert.equal(revised.meta.augmentPatch, first.meta.augmentPatch);
  assert.equal(revised.meta.rulesRevision, revision.manifest.sha256);
  assert.notEqual(revised.meta.rulesRevision, first.meta.rulesRevision);

  response = {manifest, bytes};
  assert.equal(await updater.check(), revised);
  response = olderPatch;
  assert.equal(await updater.check(), revised);
  response = {...revision, manifest:{...revision.manifest, updatedAt:'2026-11-09T00:00:00Z'}};
  assert.equal(await updater.check(), revised);
  assert.equal(payloads.length, 3);
  assert.deepEqual(updates, [first, revised]);

  const restarted = await new RulesUpdater({catalog, dataDirectory:directory}).load();
  assert.equal(restarted.getSnapshot().meta.rulesRevision, revision.manifest.sha256);
});

test('newly discovered augment IDs remain stable and live retirements keep their verified history', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexguide-rules-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const discovered = published.find(row => row.gameDataId === 90000);
  const withoutDiscovered = published.filter(row => row !== discovered);
  const publishedNext = {clientPatch:'16.23', updatedAt:'2026-11-19T01:00:00Z',
    officialAnnouncement:{version:'16.23.1', url:'https://lol.qq.com/gicp/news/410/37102797.html'}};
  let response = buildPublication({officialAnnouncement});
  const options = {catalog, dataDirectory:directory,
    fetcher:async url => url.endsWith('/index.json') ? Response.json(response.manifest) : new Response(response.bytes)};
  const updater = await new RulesUpdater(options).load();
  const learned = await updater.check();
  assert.equal(learned.augments.find(row => row.gameDataId === 90000).sourceGameId, discovered.sourceGameId);
  await updater.close();

  const restarted = await new RulesUpdater(options).load();
  t.after(() => restarted.close());
  const cached = restarted.getSnapshot();
  assert.equal(cached.meta.rulesRevision, learned.meta.rulesRevision);
  response = buildPublication({...publishedNext, augments:[...withoutDiscovered,
    {...discovered, sourceGameId:'ReassignedFixture', sourcePath:'Augments/ReassignedFixture'}]});
  assert.equal(await restarted.check(), cached, 'a known numeric ID cannot be assigned to a different augment');

  response = buildPublication({...publishedNext, augments:[...withoutDiscovered, {...discovered, gameDataId:90001}]});
  assert.equal(await restarted.check(), cached, 'a known source ID cannot move to a different numeric ID');

  response = buildPublication({...publishedNext, augments:withoutDiscovered});
  const upgraded = await restarted.check();
  assert.equal(upgraded.meta.augmentPatch, '26.23');
  const retired = upgraded.augments.find(row => row.gameDataId === 90000);
  assert.equal(retired.id, 'game_90000');
  assert.equal(retired.availability, 'retired-in-source');
  assert.equal(retired.retiredPatch, '26.23');
  assert.equal(retired.recommendable, false);
  assert.equal(retired.descriptionPatch, '26.22');
  assert.equal(retired.sourceGameId, discovered.sourceGameId);
  assert.ok(upgraded.meta.sources.some(row => row.url === publishedNext.officialAnnouncement.url));
  assert.ok(!upgraded.meta.sources.some(row => row.url === officialAnnouncement.url));
});

test('closing cancels a pending check and leaves the last accepted data in place', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexguide-rules-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  let requestSignal;
  const updater = await new RulesUpdater({catalog, dataDirectory:directory,
    fetcher:(_url, {signal}) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
    }
  }).load();
  const pending = updater.check();
  await updater.close();
  assert.equal(requestSignal.aborted, true);
  assert.equal(await pending, catalog);
  assert.equal(updater.getSnapshot(), catalog);
});

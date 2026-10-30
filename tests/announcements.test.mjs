import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AnnouncementStore} from '../server/announcements.mjs';
import {validateArticle,validateIndex,ANNOUNCEMENT_FEED} from '../dist/announcements-contract.js';
import {createLocalServer} from '../server/http.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(id='a'.repeat(24)) {
  const article={schemaVersion:1,id,title:'装备数值更新',publishedAt:'2026-10-31T01:00:00.000Z',fromVersion:'16.20.1',toVersion:'16.21.1',summary:'一项已确认的数值变化',scopeNote:'公开静态数值',itemCount:1,augmentCount:0,changeCount:1,
    changes:[{key:'item:1001:damage',kind:'item',entityId:'1001',name:'测试装备',field:'damage',label:'攻击力',before:60,after:65,unit:'',scale:1}],sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/data.json',sha256:'c'.repeat(64)}]};
  const body=JSON.stringify(article);const summary={...Object.fromEntries(['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].map(k=>[k,article[k]])),sha256:digest(body)};
  return {article,body,summary};
}
const indexOf=entries=>({schemaVersion:1,revision:digest(JSON.stringify(entries)),publishedAt:'2026-10-31T01:00:00.000Z',entries});
test('public contract rejects duplicate IDs, forged counts, nonfinite numbers and unsafe source links',()=>{
  const f=fixture();assert.ok(validateArticle(f.article));
  assert.throws(()=>validateIndex(indexOf([f.summary,f.summary])));
  for(const mutate of [a=>a.changeCount=2,a=>a.changes[0].after=Infinity,a=>a.sources[0].url='javascript:alert(1)',a=>a.changes[0].scale=1000]){
    const a=structuredClone(f.article);mutate(a);assert.throws(()=>validateArticle(a));
  }
});
test('checks coalesce, opening is distinct from marking read, and cached history works after restart offline',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-store-')),f=fixture();let calls=0;
  const store=await new AnnouncementStore({dataDirectory:dir,fetchImpl:async url=>{calls++;assert.ok(String(url).startsWith(ANNOUNCEMENT_FEED));return new Response((String(url).endsWith('index.json')||(String(url).endsWith('index-v2.json')||String(url).endsWith('index-v3.json')))?JSON.stringify(indexOf([f.summary])):f.body);}}).load();
  await Promise.all([store.check(),store.check()]);assert.equal(calls,2);assert.equal(store.getList().unreadCount,1);
  await store.getArticle(f.article.id);assert.equal(store.getList().unreadCount,1);await store.markRead(f.article.id);await store.close();
  const offline=await new AnnouncementStore({dataDirectory:dir,fetchImpl:async()=>{throw Error('offline');}}).load();await offline.check();
  assert.equal(offline.getList().unreadCount,0);assert.equal(offline.getList().entries.length,1);assert.equal((await offline.getArticle(f.article.id)).changes[0].after,65);await offline.close();
});
test('hash mismatch never caches or marks a corrupted downloaded notice',async()=>{
  const f=fixture(),store=await new AnnouncementStore({fetchImpl:async url=>new Response((String(url).endsWith('index.json')||(String(url).endsWith('index-v2.json')||String(url).endsWith('index-v3.json')))?JSON.stringify(indexOf([f.summary])):f.body.replace('65','999'))}).load();
  await store.check();await assert.rejects(store.getArticle(f.article.id),/hash/);assert.equal(store.getList().unreadCount,1);await store.close();
});
test('older indexes retain history and changed immutable records are rejected',async()=>{
  const a=fixture(),b=fixture('b'.repeat(24));let entries=[b.summary,a.summary];
  const store=await new AnnouncementStore({fetchImpl:async()=>new Response(JSON.stringify(indexOf(entries)))}).load();
  await store.check();entries=[a.summary];await store.check();assert.equal(store.getList().entries.length,2);
  entries=[{...a.summary,sha256:'d'.repeat(64)}];await store.check();assert.equal(store.getList().error,'update-unavailable');assert.equal(store.getList().entries.length,2);await store.close();
});
test('concurrent read mutations persist both IDs',async()=>{
  const a=fixture(),b=fixture('b'.repeat(24));const dir=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-reads-'));
  const store=await new AnnouncementStore({dataDirectory:dir,fetchImpl:async()=>new Response(JSON.stringify(indexOf([a.summary,b.summary])))}).load();await store.check();
  await Promise.all([store.markRead(a.article.id),store.markRead(b.article.id)]);await store.close();
  assert.equal(JSON.parse(await readFile(path.join(dir,'announcements-v1/read.json'))).length,2);
});
test('closing aborts an in-flight detail independently after an overlapping check completes',async()=>{
  const f=fixture();let articleSignal;
  const store=await new AnnouncementStore({fetchImpl:async(url,{signal})=>{
    if((String(url).endsWith('index.json')||(String(url).endsWith('index-v2.json')||String(url).endsWith('index-v3.json'))))return new Response(JSON.stringify(indexOf([f.summary])));
    if(String(url).endsWith('presentation.json'))return new Response('{"schemaVersion":1,"articles":[]}');
    articleSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
  }}).load();await store.check();
  const article=store.getArticle(f.article.id);const failure=assert.rejects(article,/aborted/);
  await store.check();await store.close();await failure;assert.equal(articleSignal.aborted,true);
});
test('bundled history is available on the first offline start',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-bundle-')),f=fixture();
  await writeFile(path.join(dir,'index.json'),JSON.stringify(indexOf([f.summary])));await writeFile(path.join(dir,`${f.article.id}.json`),f.body);
  const store=await new AnnouncementStore({bundledDirectory:dir,fetchImpl:async()=>{throw Error('offline');}}).load();
  await store.check();assert.equal(store.getList().unreadCount,1);assert.equal((await store.getArticle(f.article.id)).id,f.article.id);await store.close();
});
test('offline upgrade merges older cached and newly bundled histories without losing read state',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-upgrade-')),bundle=path.join(root,'bundle'),data=path.join(root,'data'),old=fixture(),newer=fixture('b'.repeat(24));
  await mkdir(bundle);await mkdir(path.join(data,'announcements-v1'),{recursive:true});
  await writeFile(path.join(bundle,'index.json'),JSON.stringify(indexOf([newer.summary])));await writeFile(path.join(bundle,`${newer.article.id}.json`),newer.body);
  await writeFile(path.join(data,'announcements-v1/index.json'),JSON.stringify(indexOf([old.summary])));await writeFile(path.join(data,'announcements-v1/read.json'),JSON.stringify([old.article.id]));
  const store=await new AnnouncementStore({dataDirectory:data,bundledDirectory:bundle,fetchImpl:async()=>{throw Error('offline');}}).load();await store.check();
  assert.equal(store.getList().entries.length,2);assert.equal(store.getList().unreadCount,1);assert.equal((await store.getArticle(newer.article.id)).id,newer.article.id);await store.close();
});
test('a bundled article viewed offline remains cached and readable after a later bundle replaces it',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-offline-history-')),bundle=path.join(root,'bundle'),data=path.join(root,'data'),old=fixture(),newer=fixture('b'.repeat(24));
  await mkdir(bundle);await writeFile(path.join(bundle,'index.json'),JSON.stringify(indexOf([old.summary])));await writeFile(path.join(bundle,`${old.article.id}.json`),old.body);
  const offline=async()=>{throw Error('offline');};
  const first=await new AnnouncementStore({dataDirectory:data,bundledDirectory:bundle,fetchImpl:offline}).load();
  await first.getArticle(old.article.id);await first.markRead(old.article.id);await first.close();
  assert.equal(await readFile(path.join(data,'announcements-v1',`${old.article.id}.json`),'utf8'),old.body);
  const nextBundle=path.join(root,'new-bundle');await mkdir(nextBundle);await writeFile(path.join(nextBundle,'index.json'),JSON.stringify(indexOf([newer.summary])));
  const next=await new AnnouncementStore({dataDirectory:data,bundledDirectory:nextBundle,fetchImpl:offline}).load();
  await next.check();assert.equal(next.getList().entries.length,2);assert.equal(next.getList().unreadCount,1);assert.equal((await next.getArticle(old.article.id)).id,old.article.id);await next.close();
});
test('closing during a bundled read prevents a later cache write',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-bundle-close-')),bundle=path.join(root,'bundle'),data=path.join(root,'data'),f=fixture();
  await mkdir(bundle);await writeFile(path.join(bundle,'index.json'),JSON.stringify(indexOf([f.summary])));await writeFile(path.join(bundle,`${f.article.id}.json`),f.body);
  const store=await new AnnouncementStore({dataDirectory:data,bundledDirectory:bundle}).load();
  const pending=assert.rejects(store.getArticle(f.article.id),/closed/);
  await store.close();await pending;
  await assert.rejects(readFile(path.join(data,'announcements-v1',`${f.article.id}.json`)),{code:'ENOENT'});
});

test('local HTTP routes enforce session, origin and request body contracts',async()=>{
  const f=fixture(),store=await new AnnouncementStore({fetchImpl:async url=>new Response((String(url).endsWith('index.json')||(String(url).endsWith('index-v2.json')||String(url).endsWith('index-v3.json')))?JSON.stringify(indexOf([f.summary])):f.body)}).load();await store.check();
  const server=await createLocalServer({collector:{getSnapshot:()=>({})},announcements:store,staticDirectory:path.resolve('dist')});const base=`http://127.0.0.1:${server.port}`;
  try {
    assert.equal((await fetch(base+'/api/announcements')).status,401);
    assert.equal((await fetch(base+'/api/announcements',{headers:{'x-hexguide-session':server.token,origin:'https://evil.example'}})).status,403);
    const headers={'x-hexguide-session':server.token,'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/api/announcements/read',{method:'POST',headers,body:'{"id":"../secret"}'})).status,400);
    assert.equal((await fetch(base+'/api/announcements/check',{method:'POST',headers,body:'{"extra":1}'})).status,400);
    assert.equal((await fetch(base+'/api/announcements/'+f.article.id,{headers})).status,200);
    assert.equal((await fetch(base+'/api/announcements/read',{method:'POST',headers,body:JSON.stringify({id:f.article.id})})).status,200);
    assert.equal((await (await fetch(base+'/api/announcements',{headers})).json()).unreadCount,0);
  }finally{await server.close();}
});

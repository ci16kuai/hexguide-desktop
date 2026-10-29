import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createLocalServer} from '../server/http.mjs';

const snapshot = revision => ({schemaVersion:1,meta:{mode:'aram-mayhem',cohortId:revision},
  champions:[{championId:'Ahri',games:100,wins:revision === 'first' ? 50 : 60,augments:[]}]});

function request(port, target, {headers={},method='GET',body} = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port,path:target,method,headers},response => {
      const chunks=[];
      response.on('data',chunk => chunks.push(chunk));
      response.on('end',() => resolve({status:response.statusCode,headers:response.headers,
        body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);
    req.end(body);
  });
}

async function harness(t, withStore=true) {
  const work = process.env.HEXGUIDE_TEST_WORK || 'H:/Chatgpt/work/2026-10-29/hexguide-statistics/http-tests';
  await mkdir(work,{recursive:true});
  const directory = await mkdtemp(path.join(work,'server-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(work) + path.sep));
    await rm(directory,{recursive:true,force:true});
  });
  const bundled = snapshot('bundled');
  await writeFile(path.join(directory,'statistics.json'),JSON.stringify(bundled));
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>统计测试</title>');
  let current = snapshot('first');
  let reads=0,statusReads=0;
  const statistics = {getSnapshot(){reads++;return current;},getStatus(){statusReads++;return {revision:current.meta.cohortId,nextCheckAt:1793260800000};}};
  const collector={getSnapshot:()=>({connection:{status:'waiting'},phase:'None',items:[]})};
  const local=await createLocalServer({collector,staticDirectory:directory,token:'s'.repeat(64),...(withStore?{statistics}:{})});
  t.after(()=>local.close());
  return {local,bundled,bundledFile:path.join(directory,'statistics.json'),statistics,headers:{'X-Hexguide-Session':local.token},
    current:()=>structuredClone(current),replace:()=>{current=snapshot('second');},reads:()=>reads,statusReads:()=>statusReads};
}

test('statistics HTTP serves the current memory snapshot on every GET and HEAD without replacing bundled files',async t=>{
  const h=await harness(t);
  const first=await request(h.local.port,'/statistics.json');
  assert.equal(first.status,200);
  assert.deepEqual(JSON.parse(first.body),h.current());
  assert.equal(first.headers['cache-control'],'no-store');
  assert.equal(Number(first.headers['content-length']),Buffer.byteLength(first.body));
  h.replace();
  const second=await request(h.local.port,'/statistics.json?revision=second');
  assert.equal(second.status,200);
  assert.deepEqual(JSON.parse(second.body),h.current());
  assert.notEqual(second.body,first.body);
  const head=await request(h.local.port,'/statistics.json',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.body,'');
  assert.equal(head.headers['content-type'],'application/json; charset=utf-8');
  assert.equal(Number(head.headers['content-length']),Buffer.byteLength(second.body));
  assert.equal(h.reads(),3,'each accepted request reads the store current snapshot');
  assert.deepEqual(JSON.parse(await readFile(h.bundledFile,'utf8')),h.bundled,'runtime reads retain the shipped fallback');
});

test('statistics status requires the local session and shares existing Host and Origin restrictions',async t=>{
  const h=await harness(t);
  for(const method of ['GET','HEAD']) {
    assert.equal((await request(h.local.port,'/api/statistics/status',{method})).status,401);
    assert.equal((await request(h.local.port,'/api/statistics/status?token='+h.local.token,{method})).status,401);
  }
  assert.equal(h.statusReads(),0,'rejected requests never inspect the updater');
  const first=await request(h.local.port,'/api/statistics/status',{headers:h.headers});
  assert.equal(first.status,200);
  assert.equal(first.headers['cache-control'],'no-store');
  assert.deepEqual(JSON.parse(first.body),{revision:'first',nextCheckAt:1793260800000});
  h.replace();
  assert.equal(JSON.parse((await request(h.local.port,'/api/statistics/status',{headers:h.headers})).body).revision,'second');
  const head=await request(h.local.port,'/api/statistics/status',{headers:h.headers,method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.body,'');
  for(const target of ['/statistics.json','/api/statistics/status']) {
    for(const badHeaders of [{Origin:'https://attacker.example'},{Host:'attacker.example'}]) {
      assert.equal((await request(h.local.port,target,{headers:{...h.headers,...badHeaders}})).status,403);
    }
  }
});

test('statistics endpoints reject writes and body-bearing reads before consulting stores',async t=>{
  const h=await harness(t);
  for(const target of ['/statistics.json','/api/statistics/status']) {
    assert.equal((await request(h.local.port,target,{headers:h.headers,method:'POST',body:'{}'})).status,405);
    assert.equal((await request(h.local.port,target,{headers:{...h.headers,'Content-Length':'2'},body:'{}'})).status,405);
  }
  assert.equal(h.reads(),0);
  assert.equal(h.statusReads(),0);
});

test('omitting the statistics store retains bundled static files and ordinary local APIs',async t=>{
  const h=await harness(t,false);
  const result=await request(h.local.port,'/statistics.json');
  assert.equal(result.status,200);
  assert.deepEqual(JSON.parse(result.body),h.bundled);
  const head=await request(h.local.port,'/statistics.json',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.body,'');
  assert.equal(Number(head.headers['content-length']),Buffer.byteLength(result.body));
  assert.equal((await request(h.local.port,'/')).status,200);
  assert.equal((await request(h.local.port,'/api/health',{headers:h.headers})).status,200);
  assert.equal(h.reads(),0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {digest} from '../tools/version-maintenance/sources.mjs';
import {verifyOpenAi} from '../tools/version-maintenance/verify-openai.mjs';
import {runMaintenance} from '../tools/version-maintenance/maintenance.mjs';
import {validateFeed} from '../tools/version-maintenance/validate-feed.mjs';

test('cloud API verification uses a real validated notice without changing or publishing its numbers',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'hexguide-cloud-verify-'));
  const article={schemaVersion:1,id:'a'.repeat(24),title:'装备数值更新',publishedAt:'2026-10-31T01:00:00.000Z',fromVersion:'16.20.1',toVersion:'16.21.1',summary:'一项数值变化',scopeNote:'公开静态数值',itemCount:1,augmentCount:0,changeCount:1,
    changes:[{key:'item:1001:damage',kind:'item',entityId:'1001',name:'装备',field:'damage',label:'攻击力',before:60,after:65,unit:'',scale:1}],sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/data.json',sha256:'c'.repeat(64)}]};
  const body=JSON.stringify(article),summary={...Object.fromEntries(['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].map(k=>[k,article[k]])),sha256:digest(body)};
  const index=JSON.stringify({schemaVersion:1,revision:digest([summary]),publishedAt:article.publishedAt,entries:[summary]});
  await writeFile(path.join(directory,'index.json'),index);await writeFile(path.join(directory,`${article.id}.json`),body);
  let calls=0;
  const result=await verifyOpenAi({feedDirectory:directory,key:'unit-test-only',translator:async(changes,{key})=>{
    calls++;assert.equal(key,'unit-test-only');assert.deepEqual(changes,article.changes);changes[0].after=999;
    return {model:'test-model',usage:{total_tokens:10},labels:{[article.changes[0].key]:'攻击力'}};
  }});
  assert.equal(calls,1);assert.equal(result.status,'verified');assert.equal(result.fields,1);
  assert.equal(await readFile(path.join(directory,'index.json'),'utf8'),index);assert.equal(await readFile(path.join(directory,`${article.id}.json`),'utf8'),body);
  await writeFile(path.join(directory,`${article.id}.json`),body.replace('65','999'));
  await assert.rejects(verifyOpenAi({feedDirectory:directory,translator:async()=>{throw new Error('must not call');}}),/hash/);
});

test('a new hosted retry restores only drafts and uses the published baseline to finish an unpublished notice',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-cloud-retry-'));
  const catalog=(version,ad)=>({schemaVersion:1,version,clientVersion:version.split('.').slice(0,2).join('.'),sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/data.json',sha256:'c'.repeat(64)}],
    items:{'1001':{name:'装备',numbers:{'stats.FlatPhysicalDamageMod':ad},description:''}},augments:{}});
  const previous=catalog('16.20.1',60),current=catalog('16.21.1',65);
  const options={officialProvider:async()=>null,versionsProvider:async()=>['16.21.1','16.20.1'],catalogProvider:async version=>version===current.version?current:previous,envFile:path.join(root,'.env')};
  await writeFile(options.envFile,'OPENAI_API_KEY=sk-unit-test-only\n');
  const first={stateDirectory:path.join(root,'first-state'),feedDirectory:path.join(root,'unpublished-feed')};
  let calls=0;
  const generated=await runMaintenance({...options,...first,translator:async changes=>{calls++;return {model:'test-model',labels:Object.fromEntries(changes.map(change=>[change.key,'攻击力']))};}});
  // The old runner's feed/snapshot never reached GitHub. The new runner gets the
  // last published baseline and cached draft, never the advanced local snapshot.
  const next={stateDirectory:path.join(root,'next-state'),feedDirectory:path.join(root,'published-feed')};
  await mkdir(next.stateDirectory);await writeFile(path.join(next.stateDirectory,'snapshot.json'),JSON.stringify(previous));
  const draft=`draft-${generated.announcementId}.json`;await copyFile(path.join(first.stateDirectory,draft),path.join(next.stateDirectory,draft));
  const retried=await runMaintenance({...options,...next,translator:async()=>{throw Error('A completed draft must not be regenerated.');}});
  assert.equal(calls,1);assert.equal(retried.announcementId,generated.announcementId);
  assert.equal((await validateFeed(next.feedDirectory)).entries.length,1);
  assert.equal(JSON.parse(await readFile(path.join(next.stateDirectory,'snapshot.json'))).version,current.version);
});

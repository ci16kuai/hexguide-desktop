import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadRules, applyRules} from '../server/rules.mjs';

const catalog=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url)));
const published=catalog.augments.filter(a=>a.availability==='current').map(a=>({
  gameDataId:a.gameDataId,sourceGameId:a.sourceGameId,sourcePath:a.sourcePath,name:a.name,enName:a.enName,rarity:a.rarity,
  description:a.description,unresolvedValues:a.unresolvedValues,iconPath:new URL(a.icon).pathname.split('/game/')[1]
}));
const removed=published.shift();
published.push({...removed,gameDataId:90000,sourceGameId:'Fixture',sourcePath:'Augments/Fixture',name:'测试条目'});
const bytes=Buffer.from(JSON.stringify({schemaVersion:1,clientPatch:'16.22',augments:published}));
const manifest={schemaVersion:1,clientPatch:'16.22',sha256:createHash('sha256').update(bytes).digest('hex'),updatedAt:'2026-11-05T01:02:03Z'};

test('rules use source membership and keep historical stats and retired IDs separate',()=>{
  const next=applyRules(catalog,manifest,bytes);
  assert.equal(catalog.meta.augmentPatch,'26.21');
  assert.equal(next.meta.augmentPatch,'26.22');
  assert.equal(next.meta.statsPatch,catalog.meta.statsPatch);
  assert.equal(next.augments.find(a=>a.gameDataId===removed.gameDataId).recommendable,false);
  assert.equal(next.augments.find(a=>a.gameDataId===90000).descriptionPatch,'26.22');
  assert.throws(()=>applyRules(catalog,manifest,Buffer.from('{}')),/digest/);
});

test('a broken or older feed retains the last verified rules across launches',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'hexguide-rules-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const fetcher=async url=>url.endsWith('/index.json')?Response.json(manifest):new Response(bytes);
  assert.equal((await loadRules(catalog,dir,{fetcher})).meta.augmentPatch,'26.22');
  assert.equal((await loadRules(catalog,dir,{fetcher:async()=>{throw Error('offline');}})).meta.augmentPatch,'26.22');
  assert.equal((await loadRules(catalog,dir,{fetcher:async()=>Response.json({...manifest,clientPatch:'16.21'})})).meta.augmentPatch,'26.22');
});

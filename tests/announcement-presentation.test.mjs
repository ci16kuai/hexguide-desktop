import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {digest,diffCatalogs} from '../tools/version-maintenance/sources.mjs';
import {updatePresentation,parseOfficialNote} from '../tools/version-maintenance/presentation.mjs';
import {validatePresentation,validateArticle} from '../dist/announcements-contract.js';
import {AnnouncementStore} from '../server/announcements.mjs';
import {runMaintenance} from '../tools/version-maintenance/maintenance.mjs';
import {validateFeed} from '../tools/version-maintenance/validate-feed.mjs';
const official={date:'2026-10-21',title:'26.21版本更新公告',url:'https://lol.qq.com/news/detail.shtml?docid=9107763462516557080',sha256:'c'.repeat(64)};
const icon='https://ddragon.leagueoflegends.com/cdn/16.21.1/img/item/3008.png';
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-presentation-')),feed=path.join(root,'feed');await mkdir(feed);
  const article={schemaVersion:1,id:'a'.repeat(24),title:'数值更新',publishedAt:'2026-10-30T13:40:00.000Z',fromVersion:'16.20.1',toVersion:'16.21.1',summary:'一项数值变化',scopeNote:'静态数值',itemCount:1,augmentCount:0,changeCount:1,
    changes:[{key:'item:3008:gold.base',kind:'item',entityId:'3008',name:'暴食胫甲',field:'gold.base',label:'合成费用',before:700,after:800,unit:'金币',scale:1}],sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/data.json',sha256:'c'.repeat(64)}]};
  const body=JSON.stringify(article),summary={...Object.fromEntries(['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].map(k=>[k,article[k]])),sha256:digest(body)};
  const index=JSON.stringify({schemaVersion:1,revision:digest([summary]),publishedAt:article.publishedAt,entries:[summary]});
  await writeFile(path.join(feed,'index.json'),index);await writeFile(path.join(feed,`${article.id}.json`),body);
  return {root,feed,article,body,index,summary};
}
test('official date comes from matching website metadata, not maintenance time or unrelated scripts',()=>{
  const body=JSON.stringify({status:1,data:{result:{sTitle:'26.21版本更新公告',sCreated:'2026-10-21 20:47:03'}}});
  assert.equal(parseOfficialNote(`callback(${body})`,{version:'16.21.1',url:official.url,cn:true}).date,'2026-10-21');
  assert.throws(()=>parseOfficialNote(body,{version:'16.22.1',url:official.url,cn:true}),/mismatch/);
  const html='<script type="application/ld+json">'+JSON.stringify({'@graph':[{'@type':'Article',headline:'26.21版本更新公告',datePublished:'2026-10-20T18:00:00.000Z'}]})+'</script>';
  assert.equal(parseOfficialNote(html,{version:'16.21.1',url:'https://www.leagueoflegends.com/'}).date,'2026-10-20');
  assert.throws(()=>parseOfficialNote(html,{version:'16.22.1'}),/unavailable/);
});
test('date and icons enrich existing history without changing immutable bytes, IDs or read state; persist offline',async()=>{
  const f=await fixture(),data=path.join(f.root,'data');
  const options={feedDirectory:f.feed,catalogProvider:async()=>({items:{3008:{icon}}}),officialProvider:async()=>official};
  assert.deepEqual(await updatePresentation(options),[]);
  assert.equal(await readFile(path.join(f.feed,'index.json'),'utf8'),f.index);assert.equal(await readFile(path.join(f.feed,`${f.article.id}.json`),'utf8'),f.body);
  const fetchImpl=async url=>new Response(await readFile(path.join(f.feed,new URL(url).pathname.split('/').at(-1)),'utf8'));
  const first=await new AnnouncementStore({dataDirectory:data,fetchImpl}).load();await first.check();await first.markRead(f.article.id);
  assert.equal(first.getList().entries[0].official.date,'2026-10-21');assert.equal((await first.getArticle(f.article.id)).changes[0].icon,icon);await first.close();
  const offline=await new AnnouncementStore({dataDirectory:data,fetchImpl:async()=>{throw Error('offline');}}).load();
  await offline.check();assert.equal(offline.getList().unreadCount,0);assert.equal(offline.getList().entries[0].official.date,'2026-10-21');assert.equal((await offline.getArticle(f.article.id)).changes[0].after,800);await offline.close();
});
test('wrong article hash and untrusted image/date input cannot decorate a valid notice',async()=>{
  const f=await fixture();const valid={schemaVersion:1,articles:[{id:f.article.id,sha256:'d'.repeat(64),official,icons:{[f.article.changes[0].key]:icon}}]};
  for(const bad of ['https://evil.example/icon.png','data:image/png;base64,xxx','https://ddragon.leagueoflegends.com.evil.example/icon.png','https://ddragon.leagueoflegends.com/cdn/16.21.1/img/item/3008.png?secret=x'])assert.throws(()=>validatePresentation({...valid,articles:[{...valid.articles[0],icons:{x:bad}}]}));
  assert.throws(()=>validatePresentation({...valid,articles:[{...valid.articles[0],official:{...official,date:'2026-02-31'}}]}));
  await writeFile(path.join(f.feed,'presentation.json'),JSON.stringify(valid));
  const store=await new AnnouncementStore({bundledDirectory:f.feed}).load();assert.equal(store.getList().entries[0].official,undefined);assert.equal((await store.getArticle(f.article.id)).changes[0].icon,undefined);await store.close();
});
test('missing website date stays unconfirmed and can be filled on a later unchanged run',async()=>{
  const f=await fixture(),options={feedDirectory:f.feed,catalogProvider:async()=>({items:{3008:{icon}}})};
  assert.equal((await updatePresentation({...options,officialProvider:async()=>{throw Error('offline');}})).length,1);
  const missing=JSON.parse(await readFile(path.join(f.feed,'presentation.json')));assert.equal(missing.articles[0].official,undefined);
  await updatePresentation({...options,officialProvider:async()=>official});assert.equal(JSON.parse(await readFile(path.join(f.feed,'presentation.json'))).articles[0].official.date,'2026-10-21');
});
test('a temporarily unavailable historical icon catalog never blocks publication metadata',async()=>{
  const f=await fixture();const warnings=await updatePresentation({feedDirectory:f.feed,catalogProvider:async()=>{throw Error('old patch resource unavailable');},officialProvider:async()=>official});
  assert.equal(warnings.length,1);assert.equal((await validateFeed(f.feed)).entries.length,1);
  assert.equal(JSON.parse(await readFile(path.join(f.feed,'presentation.json'))).articles[0].official.date,'2026-10-21');
});
test('a first offline bundled view keeps official date and icons after a later app bundle removes that notice',async()=>{
  const f=await fixture(),data=path.join(f.root,'data'),empty=path.join(f.root,'empty');await mkdir(empty);
  await updatePresentation({feedDirectory:f.feed,catalogProvider:async()=>({items:{3008:{icon}}}),officialProvider:async()=>official});
  const offline=async()=>{throw Error('offline');};
  const first=await new AnnouncementStore({dataDirectory:data,bundledDirectory:f.feed,fetchImpl:offline}).load();await first.getArticle(f.article.id);await first.markRead(f.article.id);await first.close();
  const second=await new AnnouncementStore({dataDirectory:data,bundledDirectory:empty,fetchImpl:offline}).load();
  assert.equal(second.getList().unreadCount,0);assert.equal(second.getList().entries[0].official.date,'2026-10-21');assert.equal((await second.getArticle(f.article.id)).changes[0].icon,icon);await second.close();
});
const champions=cooldown=>({Darius:{name:'诺克萨斯之手',spells:{Q:{id:'DariusCleave',name:'大杀四方',icon:'https://ddragon.leagueoflegends.com/cdn/16.21.1/img/spell/DariusCleave.png',numbers:{cooldown},rank:5,tooltip:'已确认技能说明',resource:'法力'}}}});
test('skill changes bind the correct hero, slot and icon; replacement spells or rank remapping are not paired',()=>{
  const previous={schemaVersion:1,items:{},augments:{},champions:champions([9,8,7,6,5])},current={...previous,champions:champions([9,8,7,6,4])};
  const [row]=diffCatalogs(previous,current).changes;assert.equal(row.ability.slot,'Q');assert.equal(row.name,'诺克萨斯之手');assert.match(row.icon,/DariusCleave.png$/);assert.equal(row.unit,'秒');
  const article=validateArticle({schemaVersion:1,id:'a'.repeat(24),title:'技能更新',publishedAt:'2026-10-31T00:00:00.000Z',fromVersion:'16.20.1',toVersion:'16.21.1',summary:'一位英雄技能变化',scopeNote:'静态技能数值',championCount:1,itemCount:0,augmentCount:0,changeCount:1,changes:[{...row,label:'冷却时间'}],sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/cdn/16.21.1/data/zh_CN/championFull.json',sha256:'b'.repeat(64)}]});
  assert.equal(article.changes[0].ability.name,'大杀四方');assert.throws(()=>validateArticle({...article,championCount:0}));
  current.champions.Darius.spells.Q.id='ReworkedQ';assert.equal(diffCatalogs(previous,current).changes.length,0);
  current.champions=champions([9,8,7,6]);const skipped=diffCatalogs(previous,current);assert.equal(skipped.changes.length,0);assert.equal(skipped.warnings.length,1);
  current.champions=champions([9,8,7,6,4]);current.champions.Darius.spells.Q.rank=6;assert.equal(diffCatalogs(previous,current).changes.length,0);
});
test('existing same-patch checkpoints establish a skill baseline without fabricated historical changes',async()=>{
  const f=await fixture(),stateDirectory=path.join(f.root,'state');await mkdir(stateDirectory);
  const base={schemaVersion:1,version:'16.21.1',clientVersion:'16.21',items:{},augments:{},sources:f.article.sources};
  await writeFile(path.join(stateDirectory,'snapshot.json'),JSON.stringify(base));
  const receipt=await runMaintenance({stateDirectory,feedDirectory:f.feed,versionsProvider:async()=>['16.21.1','16.20.1'],catalogProvider:async()=>({...base,champions:champions([9,8,7,6,4])}),officialProvider:async()=>official,translator:async()=>{throw Error('No new skill history should be invented');}});
  assert.equal(receipt.changeCount,0);assert.ok(JSON.parse(await readFile(path.join(stateDirectory,'snapshot.json'))).champions.Darius);
  assert.equal(await readFile(path.join(f.feed,`${f.article.id}.json`),'utf8'),f.body);
});
test('equipment notices stay readable for legacy apps while new apps also receive separate skill notices',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-compatible-')),feedDirectory=path.join(root,'feed'),stateDirectory=path.join(root,'state'),envFile=path.join(root,'.env');await writeFile(envFile,'OPENAI_API_KEY=sk-unit-test-only\n');
  const catalog=(version,damage,cd)=>({schemaVersion:1,version,clientVersion:version.split('.').slice(0,2).join('.'),sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/data.json',sha256:'c'.repeat(64)}],items:{3008:{name:'暴食胫甲',icon,numbers:{damage},description:''}},augments:{},champions:champions(cd)});
  const old=catalog('16.20.1',60,[9,8,7,6,5]),current=catalog('16.21.1',65,[9,8,7,6,4]);
  const options={stateDirectory,feedDirectory,envFile,versionsProvider:async()=>['16.21.1','16.20.1'],catalogProvider:async v=>v===current.version?current:old,officialProvider:async()=>official,translator:async changes=>({model:'test',labels:Object.fromEntries(changes.map(row=>[row.key,row.kind==='champion'?'冷却时间':'攻击力']))})};
  const receipt=await runMaintenance(options);assert.equal(receipt.changeCount,2);assert.equal(receipt.announcementIds.length,2);
  const full=await validateFeed(feedDirectory),legacy=JSON.parse(await readFile(path.join(feedDirectory,'index.json')));
  assert.equal(full.entries.length,2);assert.equal(legacy.entries.length,1);assert.equal(legacy.entries[0].championCount,undefined);
  const legacyArticle=JSON.parse(await readFile(path.join(feedDirectory,`${legacy.entries[0].id}.json`)));assert.ok(legacyArticle.changes.every(row=>['item','augment'].includes(row.kind)));
  const store=await new AnnouncementStore({bundledDirectory:feedDirectory}).load();assert.equal(store.getList().entries.length,2);
  const skill=await store.getArticle(full.entries.find(row=>row.championCount).id);assert.equal(skill.changes[0].ability.slot,'Q');await store.close();
  assert.equal((await runMaintenance(options)).changeCount,0);assert.equal((await validateFeed(feedDirectory)).entries.length,2);
});

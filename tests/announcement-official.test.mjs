import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseOfficialChanges,officialCatalog} from '../tools/version-maintenance/official-sources.mjs';
import {runOfficialMaintenance,validateOfficialAudit} from '../tools/version-maintenance/official-maintenance.mjs';
import {digest,fetchText} from '../tools/version-maintenance/sources.mjs';
import {validateArticle,validIconUrl} from '../dist/announcements-contract.js';
import {validateFeed} from '../tools/version-maintenance/validate-feed.mjs';
import {AnnouncementStore} from '../server/announcements.mjs';
import {verifyOpenAi} from '../tools/version-maintenance/verify-openai.mjs';
const html=await readFile(new URL('./fixtures/official-patch-26.21.html',import.meta.url),'utf8');
const catalog=officialCatalog(JSON.parse(await readFile(new URL('./fixtures/official-patch-icons.json',import.meta.url),'utf8')));
const version='16.21.1',url='https://lol.qq.com/gicp/news/410/37099805.html';
const parse=body=>parseOfficialChanges(body,{url,version,catalog});
const hotfixHtml=await readFile(new URL('./fixtures/official-hotfix-2026-10-23.html',import.meta.url),'utf8');
const hotfixUrl='https://lol.qq.com/news/detail.shtml?docid=14514250113535829185';
const accept=changes=>({acceptedKeys:changes.map(row=>row.key),rejectedKeys:[],summary:'官网范围与条目覆盖完整。'});
test('the official GBK HTML is decoded before section matching, while JSON remains UTF-8',async()=>{
  const body=Buffer.concat([Buffer.from('<meta charset="gbk"><h3>'),Buffer.from([0xd3,0xa2,0xd0,0xdb]),Buffer.from('</h3>')]);
  assert.ok((await fetchText(url,{fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/html'}})})).includes('英雄'));
  assert.equal(await fetchText(url,{fetchImpl:async()=>new Response('中文JSON',{headers:{'content-type':'application/json; charset=utf-8'}})}),'中文JSON');
});
test('official source covers the missing Hubris and Bastionbreaker branches, formulas and infinite duration',()=>{
  const result=parse(html),hubris=result.changes.filter(row=>row.name==='狂妄'&&row.mode==='general'),bastion=result.changes.filter(row=>row.name==='破垒者'&&row.mode==='general');
  assert.equal(hubris.length,2);assert.equal(hubris[0].beforeText,'12');assert.equal(hubris[0].afterText,'15(近战) / 10(远程)');
  assert.equal(bastion.length,4);assert.ok(bastion.some(row=>row.beforeText==='90秒'&&row.afterText==='无限'));assert.ok(bastion.some(row=>row.afterText?.includes('40+1.5x穿甲')));
  assert.equal(result.date,'2026-10-21');assert.equal(result.changes.length,198);assert.deepEqual(result.warnings,[]);
});
test('classic mode is excluded as a complete section while general, ARAM and Arena remain explicitly separated',()=>{
  const result=parse(html);assert.ok(result.excludedClassicBlocks>50);assert.ok(result.changes.every(row=>['general','aram','arena'].includes(row.mode)&&!row.text.includes('经典模式')));
  assert.ok(result.changes.some(row=>row.mode==='arena'));assert.ok(result.changes.some(row=>row.mode==='aram'&&row.changeType==='removed'));
  const poisoned=html.replace('<h3><strong>经典模式</strong></h3>','<h3><strong>经典模式</strong></h3><h4>狂妄</h4><p>经典专属测试值：999 ⇒ 1000</p>');
  assert.ok(!parse(poisoned).changes.some(row=>row.text.includes('经典专属测试值')));
});
test('all official hero facts include base stats, passives, named skill icons and non-numerical fixes',()=>{
  const result=parse(html),heroes=result.changes.filter(row=>row.kind==='champion');assert.ok(heroes.every(row=>validIconUrl(row.championIcon)));
  assert.ok(heroes.filter(row=>row.ability).every(row=>validIconUrl(row.icon)));
  assert.ok(heroes.some(row=>row.entityId==='Azir'&&!row.ability&&row.label==='成长法力值'));
  assert.ok(heroes.some(row=>row.entityId==='Caitlyn'&&row.ability?.slot==='P'));
  assert.ok(heroes.some(row=>row.entityId==='LeeSin'&&row.ability?.slot==='E'&&row.text.includes('BUG修复')));
  assert.equal(heroes.find(row=>row.entityId==='Darius'&&row.label==='冷却时间').afterText,'9 / 8 / 7 / 6 / 4秒');
  assert.ok(heroes.some(row=>row.changeType==='fix'));
});
test('short champion headings and augment names containing colons never inherit the preceding entity',()=>{
  const result=parse(html),renata=result.changes.filter(row=>row.entityId==='Renata');assert.equal(renata.length,2);assert.deepEqual(renata.map(row=>row.ability.slot).sort(),['R','W']);assert.ok(renata.every(row=>row.icon.endsWith(`Renata${row.ability.slot}.png`)));
  const storm=result.changes.filter(row=>row.entityId==='Upgrade_Stormsurge');assert.equal(storm.length,1);assert.equal(storm[0].name,'升级：风暴狂涌');assert.ok(storm[0].text.includes('次级【风啸】'));
  const unknown=html.replace('<strong>烈娜塔</strong>','<strong>无法识别的新英雄</strong>');assert.notEqual(unknown,html);assert.throws(()=>parse(unknown),/Unmatched official champion heading/);
});
test('hotfixes preserve hero passive/Q facts and ARAM W fixes while excluding the entire Classic section',()=>{
  const result=parseOfficialChanges(hotfixHtml,{url:hotfixUrl,version,catalog});assert.equal(result.date,'2026-10-23');assert.equal(result.changes.length,7);assert.ok(result.excludedClassicBlocks>=6);
  assert.ok(result.changes.some(row=>row.entityId==='Varus'&&row.ability?.slot==='P'&&row.afterText?.includes('1.4每10%攻速')));
  assert.ok(result.changes.some(row=>row.entityId==='LeeSin'&&row.ability?.slot==='W'&&row.mode==='aram'));
  assert.equal(result.changes.filter(row=>row.text.includes('双重触发')).length,1);assert.equal(result.changes.find(row=>row.text.includes('双重触发')).entityId,'Upgrade_Stormsurge');
  assert.ok(!result.changes.some(row=>row.entityId==='Mordekaiser'));
});
test('AI audit cannot drop an entry, duplicate keys, reject valid scope or invent keys',()=>{
  const rows=parse(html).changes.slice(0,3);assert.equal(validateOfficialAudit(rows,accept(rows)).acceptedKeys.length,3);
  for(const bad of [{acceptedKeys:rows.slice(1).map(row=>row.key),rejectedKeys:[],summary:''},{acceptedKeys:[rows[0].key,rows[0].key,rows[2].key],rejectedKeys:[],summary:''},{...accept(rows),rejectedKeys:[rows[0].key]},{...accept(rows),acceptedKeys:['invented',rows[1].key,rows[2].key]}])assert.throws(()=>validateOfficialAudit(rows,bad),/coverage/);
});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-official-announcement-')),feedDirectory=path.join(root,'feed'),stateDirectory=path.join(root,'state');await mkdir(feedDirectory);
  const previous={schemaVersion:1,id:'a'.repeat(24),title:'旧资源差异记录',publishedAt:'2026-10-30T13:00:00.000Z',fromVersion:'16.20.1',toVersion:version,summary:'一项数值',scopeNote:'旧版静态数据',itemCount:1,augmentCount:0,changeCount:1,changes:[{key:'item:3008:gold.total',kind:'item',entityId:'3008',name:'暴食胫甲',field:'gold.total',label:'总费用',before:1000,after:1100,unit:'金币',scale:1}],sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/data.json',sha256:'c'.repeat(64)}]};
  const body=JSON.stringify(previous),row={...Object.fromEntries(['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].map(key=>[key,previous[key]])),sha256:digest(body)};
  const indexBody=JSON.stringify({schemaVersion:1,revision:digest([row]),publishedAt:previous.publishedAt,entries:[row]});await writeFile(path.join(feedDirectory,'index.json'),indexBody);await writeFile(path.join(feedDirectory,'index-v2.json'),indexBody);await writeFile(path.join(feedDirectory,`${previous.id}.json`),body);
  let calls=0;const options={stateDirectory,feedDirectory,versionsProvider:async()=>[version],documentProvider:async()=>({url,html}),iconCatalogProvider:async()=>catalog,auditor:async rows=>{calls++;return accept(rows);}};
  return {root,options,previous,body,indexBody,calls:()=>calls};
}
test('cloud publication backfills a complete official article once and preserves old immutable bytes and read history',async()=>{
  const f=await fixture(),receipt=await runOfficialMaintenance(f.options);assert.equal(receipt.changeCount,198);assert.equal(f.calls(),1);
  assert.equal(await readFile(path.join(f.options.feedDirectory,'index.json'),'utf8'),f.indexBody);assert.equal(await readFile(path.join(f.options.feedDirectory,`${f.previous.id}.json`),'utf8'),f.body);
  const full=await validateFeed(f.options.feedDirectory);assert.equal(full.entries.length,2);const article=validateArticle(JSON.parse(await readFile(path.join(f.options.feedDirectory,receipt.announcementId+'.json'))));
  assert.equal(article.schemaVersion,2);assert.ok(article.supersedes.includes(f.previous.id));assert.ok(article.changes.some(row=>row.name==='狂妄'));
  const dataDirectory=path.join(f.root,'data');await mkdir(path.join(dataDirectory,'announcements-v1'),{recursive:true});await writeFile(path.join(dataDirectory,'announcements-v1/read.json'),JSON.stringify([f.previous.id]));
  const store=await new AnnouncementStore({dataDirectory,bundledDirectory:f.options.feedDirectory,fetchImpl:async()=>{throw Error('offline');}}).load();
  assert.equal(store.getList().unreadCount,1);assert.equal(store.getList().entries.find(row=>row.id===f.previous.id).supersededBy,receipt.announcementId);
  assert.ok((await store.getArticle(receipt.announcementId)).changes.some(row=>row.name==='破垒者'));await store.markRead(receipt.announcementId);await store.close();
  assert.equal((await runOfficialMaintenance(f.options)).changeCount,0);assert.equal(f.calls(),1);
});
test('audit or source parsing failures do not advance the checkpoint; invalid modes and missing skill images are rejected',async()=>{
  const f=await fixture();await assert.rejects(runOfficialMaintenance({...f.options,auditor:async()=>({acceptedKeys:[],rejectedKeys:[],summary:''})}),/coverage/);
  await assert.rejects(readFile(path.join(f.options.stateDirectory,'official-state.json')),{code:'ENOENT'});
  await assert.rejects(runOfficialMaintenance({...f.options,documentProvider:async()=>({url,html:'<div id="article">broken</div>'})}));
  await runOfficialMaintenance(f.options);const full=await validateFeed(f.options.feedDirectory),article=JSON.parse(await readFile(path.join(f.options.feedDirectory,full.entries[0].id+'.json')));
  const bad=structuredClone(article);bad.changes[0].mode='classic';assert.throws(()=>validateArticle(bad));
  const skill=article.changes.findIndex(row=>row.ability);const missing=structuredClone(article);delete missing.changes[skill].icon;assert.throws(()=>validateArticle(missing));
});
test('independent hotfixes stay alongside the main patch and API verification uses the official audit path',async()=>{
  const f=await fixture(),result=await runOfficialMaintenance({...f.options,documentProvider:async()=>[{url,html,kind:'patch'},{url:hotfixUrl,html:hotfixHtml,kind:'hotfix'}]});assert.equal(result.announcementIds.length,2);
  const index=await validateFeed(f.options.feedDirectory),main=index.entries.find(row=>row.sourceUrl===url),hotfix=index.entries.find(row=>row.sourceUrl===hotfixUrl);assert.ok(!hotfix.supersedes.includes(main.id));
  let audited=0;await verifyOpenAi({feedDirectory:f.options.feedDirectory,translator:async()=>{throw Error('Wrong verification protocol');},auditor:async rows=>{audited++;assert.ok(rows[0].text);assert.equal(rows[0].kind,'champion');return {model:'test',usage:{total_tokens:10}};}});assert.equal(audited,1);
});
test('a real official rollback A to B to A creates a new effective revision, while unchanged checks stay idempotent',async()=>{
  const f=await fixture(),a=await runOfficialMaintenance(f.options),changed=html.replace('15(近战) / 10(远程)','16(近战) / 10(远程)');assert.notEqual(changed,html);
  const b=await runOfficialMaintenance({...f.options,documentProvider:async()=>({url,html:changed})}),back=await runOfficialMaintenance(f.options);
  assert.notEqual(back.announcementId,a.announcementId);assert.notEqual(back.announcementId,b.announcementId);assert.equal((await runOfficialMaintenance(f.options)).changeCount,0);
  const store=await new AnnouncementStore({bundledDirectory:f.options.feedDirectory}).load(),active=store.getList().entries.filter(row=>!row.supersededBy);assert.equal(active.length,1);assert.equal(active[0].id,back.announcementId);await store.close();
});
test('a published source becoming Classic-only fails closed without erasing the effective revision',async()=>{
  const f=await fixture();await runOfficialMaintenance(f.options);const before=await readFile(path.join(f.options.stateDirectory,'official-state.json'),'utf8');
  const classic='<h1 class="art-tit">26.21版本更新公告</h1><span class="art-time" data="2026-10-21"></span><div id="article"><h3>经典模式</h3><p>旧模式调整</p></div>';
  await assert.rejects(runOfficialMaintenance({...f.options,documentProvider:async()=>({url,html:classic})}),/Previously published official facts disappeared/);assert.equal(await readFile(path.join(f.options.stateDirectory,'official-state.json'),'utf8'),before);
});
test('icon and portrait corrections update presentation without rewriting immutable facts, IDs or article hashes',async()=>{
  const f=await fixture(),first=await runOfficialMaintenance(f.options),file=path.join(f.options.feedDirectory,first.announcementId+'.json'),before=await readFile(file,'utf8');
  const corrected=html.replace('92271693261941.jpg','CorrectedPassive.png');assert.notEqual(corrected,html);const updatedCatalog=structuredClone(catalog);updatedCatalog.champions.find(row=>row.id==='Caitlyn').icon='https://ddragon.leagueoflegends.com/cdn/16.21.1/img/champion/CaitlynCorrected.png';
  const next=await runOfficialMaintenance({...f.options,now:'2026-11-01T00:00:00.000Z',documentProvider:async()=>({url,html:corrected}),iconCatalogProvider:async()=>updatedCatalog});assert.equal(next.changeCount,0);assert.equal(f.calls(),1);assert.equal(await readFile(file,'utf8'),before);
  const store=await new AnnouncementStore({bundledDirectory:f.options.feedDirectory}).load(),article=await store.getArticle(first.announcementId),passive=article.changes.find(row=>row.entityId==='Caitlyn'&&row.ability?.slot==='P');assert.match(passive.icon,/CorrectedPassive.png$/);assert.match(passive.championIcon,/CaitlynCorrected.png$/);await store.close();
});

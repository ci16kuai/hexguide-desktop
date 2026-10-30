import {readFile,mkdir,open,unlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './maintenance.mjs';
import {digest,fetchText,listVersions,clientVersion} from './sources.mjs';
import {parseOfficialChanges,officialCatalog,fetchOfficialDocuments} from './official-sources.mjs';
import {validateArticle,validateIndex,validatePresentation} from '../../dist/announcements-contract.js';

const optionalJson=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
export async function fetchOfficialCatalog(version,options={}){
  const root=`https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/`;
  const [champions,items,augments]=await Promise.all([root+'championFull.json',root+'item.json',`https://raw.communitydragon.org/${clientVersion(version)}/plugins/rcp-be-lol-game-data/global/zh_cn/v1/cherry-augments.json`].map(async url=>JSON.parse(await fetchText(url,options))));
  return officialCatalog({version,champions,items,augments});
}
export function officialAuditSchema(changes){return {type:'object',additionalProperties:false,properties:{acceptedKeys:{type:'array',items:{type:'string',enum:changes.map(row=>row.key)}},rejectedKeys:{type:'array',items:{type:'string',enum:changes.map(row=>row.key)}},summary:{type:'string'}},required:['acceptedKeys','rejectedKeys','summary']};}
export function validateOfficialAudit(changes,output){
  const result=typeof output==='string'?JSON.parse(output):output,wanted=new Set(changes.map(row=>row.key));
  if(!Array.isArray(result?.acceptedKeys)||!Array.isArray(result.rejectedKeys)||result.rejectedKeys.length||result.acceptedKeys.length!==wanted.size||new Set(result.acceptedKeys).size!==wanted.size||result.acceptedKeys.some(key=>!wanted.has(key))||typeof result.summary!=='string'||result.summary.length>700)throw Error('Official announcement audit coverage mismatch or excluded-mode content.');
  return result;
}
const factualRows=rows=>rows.map(({icon,championIcon,...row})=>row);
export async function runOfficialMaintenance({stateDirectory,feedDirectory,now=new Date().toISOString(),versionsProvider=listVersions,
  documentProvider=fetchOfficialDocuments,iconCatalogProvider=fetchOfficialCatalog,auditor}={}){
  if(typeof auditor!=='function')throw Error('An official announcement auditor is required.');
  await mkdir(stateDirectory,{recursive:true});await mkdir(feedDirectory,{recursive:true});
  const lockPath=path.join(stateDirectory,'maintenance.lock');let lock;
  try{lock=await open(lockPath,'wx');}catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()-(await stat(lockPath)).mtimeMs<3600000)throw Error('Another maintenance run is active.');await unlink(lockPath);lock=await open(lockPath,'wx');}
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:now,source:'official-cn'}));
  try{
    const versions=await versionsProvider(),version=versions[0];
    const state=await optionalJson(path.join(stateDirectory,'official-state.json'))??{schemaVersion:1,sources:{}};
    if(state.schemaVersion!==1||!state.sources||Array.isArray(state.sources))throw Error('Invalid official source checkpoint.');
    const [provided,catalog]=await Promise.all([documentProvider(version,{knownSources:state.sources}),iconCatalogProvider(version)]);
    const documents=Array.isArray(provided)?provided:[provided];if(!documents.length||documents.length>8||new Set(documents.map(row=>row.url)).size!==documents.length)throw Error('Invalid official document set.');
    const parsedDocuments=documents.map(document=>({...parseOfficialChanges(document.html,{url:document.url,version,catalog}),kind:document.kind??'patch'}));
    const existing=await optionalJson(path.join(feedDirectory,'index-v3.json'))??await optionalJson(path.join(feedDirectory,'index-v2.json'))??await optionalJson(path.join(feedDirectory,'index.json'));
    const index=validateIndex(existing??{schemaVersion:1,revision:digest([]),publishedAt:now,entries:[]});
    const presentation=validatePresentation(await optionalJson(path.join(feedDirectory,'presentation.json'))??{schemaVersion:1,articles:[]});
    const receipt={checkedAt:now,fromVersion:version,toVersion:version,changeCount:0,warnings:[],sourceType:'official-cn',sources:[],excludedClassicBlocks:0,sectionCounts:{},announcementIds:[]};
    for(const parsed of parsedDocuments){
      receipt.excludedClassicBlocks+=parsed.excludedClassicBlocks;receipt.warnings.push(...parsed.warnings);
      for(const [section,count] of Object.entries(parsed.sectionCounts))receipt.sectionCounts[section]=(receipt.sectionCounts[section]??0)+count;
      if(!parsed.changes.length){if(state.sources[parsed.url]?.articleId)throw Error('Previously published official facts disappeared; refusing to silently treat this as unchanged.');state.sources[parsed.url]={version,kind:parsed.kind,checkedAt:now,excludedOnly:true};continue;}
      const prior=state.sources[parsed.url],factsHash=digest(factualRows(parsed.changes));
      const id=prior?.factsHash===factsHash&&prior.articleId?prior.articleId:digest({contract:'official-v2',url:parsed.url,factsHash,previous:prior?.articleId??null}).slice(0,24);
      if(!index.entries.some(row=>row.id===id)){
        const draftPath=path.join(stateDirectory,`draft-official-${id}.json`);let article=await optionalJson(draftPath);
        if(!article){
          validateOfficialAudit(parsed.changes,await auditor(parsed.changes));
          const counts={itemCount:new Set(parsed.changes.filter(row=>row.kind==='item').map(row=>row.entityId)).size,augmentCount:new Set(parsed.changes.filter(row=>row.kind==='augment').map(row=>row.entityId)).size,championCount:new Set(parsed.changes.filter(row=>row.kind==='champion').map(row=>row.entityId)).size};
          const supersedes=index.entries.filter(row=>(row.format!==2&&clientVersion(row.toVersion)===clientVersion(version))||row.sourceUrl===parsed.url).map(row=>row.id).slice(0,100);
          article=validateArticle({schemaVersion:2,id,title:`${parsed.kind==='hotfix'?parsed.title:`${Number(version.split('.')[0])+10}.${Number(version.split('.')[1])} 官网更新公告`}（不含经典模式）`,publishedAt:now,fromVersion:prior?.version??version,toVersion:version,
            summary:`本公告共 ${parsed.changes.length} 项改动，涉及 ${counts.championCount} 位英雄、${counts.itemCount} 件装备、${counts.augmentCount} 个海克斯。`,
            scopeNote:'以国服官网正文为准，收录英雄、装备和海克斯的数值、机制与 BUG 修复；完整排除经典模式。通用、海克斯大乱斗、斗魂竞技场改动分别标注，不跨模式合并数值。近战／远程、复杂公式和无限时长按官网文字保留，不分析强弱和推荐影响。',
            ...counts,changeCount:parsed.changes.length,changes:parsed.changes,supersedes,official:{date:parsed.date,title:parsed.title,url:parsed.url,sha256:parsed.sha256},sources:[{name:'英雄联盟国服官网原文',url:parsed.url,sha256:parsed.sha256}]});
          await atomicJson(draftPath,article);
        }
        article=validateArticle(article);
        if(article.id!==id||digest(factualRows(article.changes))!==digest(factualRows(parsed.changes)))throw Error('Cached official draft does not match the current source.');
        const articlePath=path.join(feedDirectory,`${id}.json`);await atomicJson(articlePath,article);const body=await readFile(articlePath,'utf8');
        index.entries.unshift({...Object.fromEntries(['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','championCount','changeCount'].map(key=>[key,article[key]])),sha256:digest(body),format:2,supersedes:article.supersedes,sourceUrl:parsed.url});
        index.revision=digest(index.entries);index.publishedAt=now;receipt.changeCount+=article.changes.length;receipt.announcementId=id;receipt.announcementIds.push(id);
      }
      const summary=index.entries.find(row=>row.id===id),body=await readFile(path.join(feedDirectory,`${id}.json`),'utf8');if(digest(body)!==summary.sha256)throw Error('Official article hash mismatch.');
      validateArticle(JSON.parse(body));
      const icons=Object.fromEntries(parsed.changes.filter(row=>row.icon).map(row=>[row.key,row.icon])),portraits=Object.fromEntries(parsed.changes.filter(row=>row.championIcon).map(row=>[row.entityId,row.championIcon])),official={date:parsed.date,title:parsed.title,url:parsed.url,sha256:parsed.sha256};
      const position=presentation.articles.findIndex(row=>row.id===id),previous=position>=0?presentation.articles[position]:null;
      const updatedAt=previous&&digest([previous.icons,previous.portraits??{},previous.official])===digest([icons,portraits,official])?previous.updatedAt??now:now;
      const overlay={id,sha256:summary.sha256,icons,portraits,official,updatedAt};if(position>=0)presentation.articles[position]=overlay;else presentation.articles.push(overlay);
      state.sources[parsed.url]={version,kind:parsed.kind,articleId:id,factsHash,checkedAt:now};receipt.sources.push({url:parsed.url,date:parsed.date,articleId:id,changeCount:parsed.changes.length});
    }
    receipt.reused=!receipt.announcementIds.length;
    await atomicJson(path.join(feedDirectory,'index-v3.json'),validateIndex(index));
    // Older client indexes and articles retain their original bytes and hashes.
    if(!existing){const empty={schemaVersion:1,revision:digest([]),publishedAt:now,entries:[]};await atomicJson(path.join(feedDirectory,'index.json'),empty);await atomicJson(path.join(feedDirectory,'index-v2.json'),empty);}
    await atomicJson(path.join(feedDirectory,'presentation.json'),validatePresentation(presentation));
    await atomicJson(path.join(stateDirectory,'official-state.json'),state);await atomicJson(path.join(stateDirectory,'last-run.json'),receipt);
    return receipt;
  }finally{await lock.close();await unlink(lockPath);}
}

import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fetchText,digest} from './sources.mjs';
import {validateArticle,validateIndex,validatePresentation,validIconUrl} from '../../dist/announcements-contract.js';

// A verified CN source can override the global announcement for a patch.
// Other patches use Riot's own patch page and its explicit datePublished field.
const cnNotes={'16.21':'9107763462516557080'};
export function parseOfficialNote(body,{version,url,cn=false}={}) {
  const patch=version.split('.').slice(0,2).map(Number);const label=`${patch[0]+10}.${patch[1]}`;
  if(cn){
    const json=JSON.parse(body.replace(/^\s*\w+\(/,'').replace(/\);?\s*$/,'')),info=json?.data?.result;
    if(String(json.status)!=='1'||info?.sTitle!==`${label}版本更新公告`||!/^\d{4}-\d{2}-\d{2} /.test(info.sCreated))throw Error('Official CN patch metadata mismatch.');
    return {date:info.sCreated.slice(0,10),title:info.sTitle,url,sha256:digest(body)};
  }
  for(const match of body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    let parsed;try{parsed=JSON.parse(match[1]);}catch{continue;}
    const nodes=Array.isArray(parsed)?parsed:parsed['@graph']??[parsed];
    const article=nodes.find(row=>['Article','NewsArticle','TechArticle','WebPage'].includes(row['@type'])&&new RegExp(`(?:^|[^0-9])${label.replace('.','\\.')}(?:[^0-9]|$)`).test(String(row.headline??row.name??'')));
    if(article&&/^\d{4}-\d{2}-\d{2}T/.test(article.datePublished))return {date:article.datePublished.slice(0,10),title:String(article.headline??article.name).slice(0,120),url,sha256:digest(body)};
  }
  throw Error('Official patch publication date unavailable.');
}
export async function fetchOfficialNote(version,options={}) {
  const resource=version.split('.').slice(0,2).join('.'),doc=cnNotes[resource];
  if(doc){
    const url=`https://lol.qq.com/news/detail.shtml?docid=${doc}`;
    const body=await fetchText(`https://apps.game.qq.com/cmc/zmMcnContentInfo?r0=jsonp&source=web_pc&type=0&docid=${doc}`,{...options,maxBytes:4*1024*1024});
    return parseOfficialNote(body,{version,url,cn:true});
  }
  const [major,minor]=resource.split('.').map(Number);
  const url=`https://www.leagueoflegends.com/zh-tw/news/game-updates/league-of-legends-patch-${major+10}-${minor}-notes/`;
  return parseOfficialNote(await fetchText(url,{...options,maxBytes:4*1024*1024}),{version,url});
}
export async function updatePresentation({feedDirectory,catalogProvider,officialProvider=fetchOfficialNote}={}) {
  let indexBody;try{indexBody=await readFile(path.join(feedDirectory,'index-v2.json'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;indexBody=await readFile(path.join(feedDirectory,'index.json'),'utf8');}
  const index=validateIndex(JSON.parse(indexBody));
  let previous={schemaVersion:1,articles:[]};
  try{previous=validatePresentation(JSON.parse(await readFile(path.join(feedDirectory,'presentation.json'),'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}
  const articles=new Map(previous.articles.map(row=>[row.id,row])),catalogs=new Map(),notes=new Map(),warnings=[];
  for(const summary of index.entries){
    const existing=articles.get(summary.id);
    if(existing&&existing.sha256!==summary.sha256)throw Error('Presentation article binding changed.');
    const body=await readFile(path.join(feedDirectory,`${summary.id}.json`),'utf8');
    if(digest(body)!==summary.sha256)throw Error('Presentation article hash mismatch.');
    const article=validateArticle(JSON.parse(body)),icons={...existing?.icons};let official=existing?.official;
    if(!official){
      if(!notes.has(article.toVersion))notes.set(article.toVersion,officialProvider(article.toVersion).catch(()=>null));
      official=await notes.get(article.toVersion);
      if(!official)warnings.push({id:article.id,reason:'官网公告日期暂未取得，未使用检查日期代替。'});
    }
    const missing=article.changes.filter(row=>!icons[row.key]&&!row.icon);
    if(missing.length){
      if(!catalogs.has(article.toVersion))catalogs.set(article.toVersion,Promise.resolve().then(()=>catalogProvider(article.toVersion)).catch(()=>null));
      const catalog=await catalogs.get(article.toVersion);
      if(!catalog)warnings.push({id:article.id,reason:'历史版本图标资源暂不可用，保留公告并在后续检查重试。'});
      for(const row of missing){const icon=catalog?.[row.kind==='item'?'items':'augments']?.[row.entityId]?.icon;if(validIconUrl(icon))icons[row.key]=icon;}
    }
    for(const row of article.changes)if(row.icon)icons[row.key]=row.icon;
    const next={id:article.id,sha256:summary.sha256,icons,...(official?{official}:{})};
    const {updatedAt,...prior}=existing??{};
    articles.set(article.id,{...next,updatedAt:JSON.stringify(prior)===JSON.stringify(next)&&updatedAt?updatedAt:new Date().toISOString()});
  }
  const result=validatePresentation({schemaVersion:1,articles:[...articles.values()]});
  await mkdir(feedDirectory,{recursive:true});const target=path.join(feedDirectory,'presentation.json'),temporary=`${target}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(result,null,2)+'\n');await rename(temporary,target);
  return warnings;
}

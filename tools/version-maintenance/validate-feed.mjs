import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './sources.mjs';
import {validateIndex,validateArticle,validatePresentation} from '../../dist/announcements-contract.js';
export async function validateFeed(directory) {
  const legacy=validateIndex(JSON.parse(await readFile(path.join(directory,'index.json'),'utf8')));
  let index=legacy;
  try{index=validateIndex(JSON.parse(await readFile(path.join(directory,'index-v2.json'),'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(legacy.entries.some(row=>row.championCount||!index.entries.some(full=>JSON.stringify(full)===JSON.stringify(row)))
    ||index.entries.filter(row=>!row.championCount).length!==legacy.entries.length)throw Error('Legacy announcement index mismatch.');
  try{
    const complete=validateIndex(JSON.parse(await readFile(path.join(directory,'index-v3.json'),'utf8')));
    if(index.entries.some(row=>!complete.entries.some(full=>JSON.stringify(full)===JSON.stringify(row))))throw Error('Official index lost previous immutable history.');
    index=complete;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  for(const row of index.entries) {
    const body=await readFile(path.join(directory,`${row.id}.json`),'utf8');
    if(digest(body)!==row.sha256)throw new Error('Announcement file hash mismatch.');
    const article=validateArticle(JSON.parse(body));
    if(['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].some(key=>article[key]!==row[key]))throw new Error('Announcement summary mismatch.');
    if((article.championCount??0)!==(row.championCount??0))throw Error('Champion summary mismatch.');
  }
  try{
    const presentation=validatePresentation(JSON.parse(await readFile(path.join(directory,'presentation.json'),'utf8')));
    for(const row of presentation.articles)if(!index.entries.some(summary=>summary.id===row.id&&summary.sha256===row.sha256))throw Error('Presentation not bound to a published article.');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return index;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const index=await validateFeed(path.resolve(process.argv[2]??''));console.log(JSON.stringify({valid:true,entries:index.entries.length}));}
  catch{console.error('Announcement feed validation failed.');process.exitCode=1;}
}

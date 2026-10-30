import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './sources.mjs';
import {validateIndex,validateArticle} from '../../dist/announcements-contract.js';
export async function validateFeed(directory) {
  const index=validateIndex(JSON.parse(await readFile(path.join(directory,'index.json'),'utf8')));
  for(const row of index.entries) {
    const body=await readFile(path.join(directory,`${row.id}.json`),'utf8');
    if(digest(body)!==row.sha256)throw new Error('Announcement file hash mismatch.');
    const article=validateArticle(JSON.parse(body));
    if(['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].some(key=>article[key]!==row[key]))throw new Error('Announcement summary mismatch.');
  }
  return index;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const index=await validateFeed(path.resolve(process.argv[2]??''));console.log(JSON.stringify({valid:true,entries:index.entries.length}));}
  catch{console.error('Announcement feed validation failed.');process.exitCode=1;}
}

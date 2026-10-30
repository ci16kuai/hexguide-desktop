import {readFile,mkdir,rename,writeFile,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {ANNOUNCEMENT_FEED,ANNOUNCEMENT_ID,validateArticle,validateIndex,validatePresentation} from '../dist/announcements-contract.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const empty=()=>({schemaVersion:1,revision:hash('[]'),publishedAt:'1970-01-01T00:00:00.000Z',entries:[]});
const sameSummary=(article,row)=>['id','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].every(k=>article[k]===row[k])&&(article.championCount??0)===(row.championCount??0);
function mergeHistory(previous,next) {
  const entries=new Map(previous.entries.map(row=>[row.id,row]));
  for(const row of next.entries) {
    const existing=entries.get(row.id);
    if(existing && JSON.stringify(existing)!==JSON.stringify(row))throw new Error('Published announcement changed.');
    entries.set(row.id,row);
  }
  const combined=[...entries.values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||b.id.localeCompare(a.id));
  return validateIndex({schemaVersion:1,revision:hash(JSON.stringify(combined)),publishedAt:new Date(Math.max(Date.parse(previous.publishedAt),Date.parse(next.publishedAt))).toISOString(),entries:combined});
}
async function readBounded(file,maximum){if((await stat(file)).size>maximum)throw new Error('Announcement cache too large.');return readFile(file,'utf8');}
async function limitedText(response,maxBytes) {
  if(!response.ok || Number(response.headers.get('content-length'))>maxBytes)throw new Error('Announcement download unavailable.');
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new Error('Announcement download too large.');chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
export class AnnouncementStore {
  #directory;#bundled;#fetch;#index=empty();#read=new Set();#presentation=new Map();#timer;#pending;#closed=false;#writes=Promise.resolve();#mutations=Promise.resolve();#lastChecked=null;#error=null;#details=new Map();#downloads=new Set();
  constructor({dataDirectory,bundledDirectory,fetchImpl=fetch}={}) {
    this.#directory=dataDirectory?path.join(dataDirectory,'announcements-v1'):null;this.#bundled=bundledDirectory;this.#fetch=fetchImpl;
  }
  async #saveText(name,body) {
    if(!this.#directory)return;
    const operation=this.#writes.catch(()=>{}).then(async()=>{
      const file=path.join(this.#directory,name),temporary=`${file}.${randomUUID()}.tmp`;
      await writeFile(temporary,body,'utf8');await rename(temporary,file);
    });
    this.#writes=operation;return operation;
  }
  async #save(name,data) { return this.#saveText(name,JSON.stringify(data)); }
  async load() {
    if(this.#bundled){for(const filename of ['index-v2.json','index.json']){try{this.#index=validateIndex(JSON.parse(await readBounded(path.join(this.#bundled,filename),1024*1024)));break;}catch{}}}
    if(this.#bundled)try{this.#mergePresentation(JSON.parse(await readBounded(path.join(this.#bundled,'presentation.json'),2*1024*1024)));}catch{}
    if(!this.#directory)return this;
    await mkdir(this.#directory,{recursive:true});
    try { this.#index=mergeHistory(this.#index,validateIndex(JSON.parse(await readBounded(path.join(this.#directory,'index.json'),1024*1024)))); }catch{/* Preserve startup when the optional cache is missing or invalid. */}
    try { const rows=JSON.parse(await readBounded(path.join(this.#directory,'read.json'),128*1024));if(Array.isArray(rows)&&rows.length<=4000&&rows.every(x=>ANNOUNCEMENT_ID.test(x)))this.#read=new Set(rows); }catch{}
    try{this.#mergePresentation(JSON.parse(await readBounded(path.join(this.#directory,'presentation.json'),2*1024*1024)));}catch{}
    await this.#save('index.json',this.#index);
    await this.#save('presentation.json',{schemaVersion:1,articles:[...this.#presentation.values()]});
    return this;
  }
  getList() {
    return {entries:this.#index.entries.map(row=>({...row,...(this.#metadata(row)?.official?{official:this.#metadata(row).official}:{}),read:this.#read.has(row.id)})),unreadCount:this.#index.entries.filter(row=>!this.#read.has(row.id)).length,
      lastCheckedAt:this.#lastChecked,error:this.#error,checking:Boolean(this.#pending)};
  }
  #mergePresentation(input){for(const row of validatePresentation(input).articles){if(!this.#index.entries.some(summary=>summary.id===row.id&&summary.sha256===row.sha256))continue;const prior=this.#presentation.get(row.id);if(!prior||Date.parse(row.updatedAt??'1970-01-01')>=Date.parse(prior.updatedAt??'1970-01-01'))this.#presentation.set(row.id,row);}}
  #metadata(summary){const row=this.#presentation.get(summary.id);return row?.sha256===summary.sha256?row:null;}
  #decorate(article,summary){
    const metadata=this.#metadata(summary);
    return {...article,...(metadata?.official?{official:metadata.official}:{}),changes:article.changes.map(row=>({...row,...(metadata?.icons[row.key]?{icon:metadata.icons[row.key]}:{})}))};
  }
  async #download(filename,maximum) {
    if(this.#closed)throw new Error('Announcement store closed.');
    const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);deadline.unref?.();this.#downloads.add(controller);
    try {
      const response=await this.#fetch(new URL(filename,ANNOUNCEMENT_FEED),{redirect:'error',signal:controller.signal,cache:'no-store'});
      return await limitedText(response,maximum);
    }finally{clearTimeout(deadline);this.#downloads.delete(controller);}
  }
  check() {
    if(this.#closed)return Promise.resolve(this.getList());
    if(this.#pending)return this.#pending;
    this.#pending=(async()=>{
      try {
        let index;try{index=validateIndex(JSON.parse(await this.#download('index-v2.json',1024*1024)));}catch{index=validateIndex(JSON.parse(await this.#download('index.json',1024*1024)));}
        const next=mergeHistory(this.#index,index);
        if(this.#closed)return this.getList();
        await this.#save('index.json',next);this.#index=next;this.#error=null;
        try{
          const presentation=validatePresentation(JSON.parse(await this.#download('presentation.json',2*1024*1024)));
          if(!this.#closed){this.#mergePresentation(presentation);await this.#save('presentation.json',{schemaVersion:1,articles:[...this.#presentation.values()]});}
        }catch{/* Optional presentation metadata must not hide immutable history. */}
      }catch{if(!this.#closed)this.#error='update-unavailable';}
      finally{this.#lastChecked=new Date().toISOString();this.#pending=null;}
      return this.getList();
    })();
    return this.#pending;
  }
  async getArticle(id) {
    if(this.#closed || !ANNOUNCEMENT_ID.test(id))throw new Error('Announcement unavailable.');
    const summary=this.#index.entries.find(row=>row.id===id);
    if(!summary)throw new Error('Unknown announcement.');
    const accept=body=>{if(hash(body)!==summary.sha256)throw new Error('Announcement hash mismatch.');const article=validateArticle(JSON.parse(body));if(!sameSummary(article,summary))throw new Error('Announcement summary mismatch.');return this.#decorate(article,summary);};
    if(this.#directory) {
      try{return accept(await readBounded(path.join(this.#directory,`${id}.json`),2*1024*1024));}catch{/* A bad/missing local file can be replaced only by a validated download. */}
    }
    let bundledBody,bundledArticle;
    if(this.#bundled)try{bundledBody=await readBounded(path.join(this.#bundled,`${id}.json`),2*1024*1024);bundledArticle=accept(bundledBody);}catch{}
    if(bundledArticle){
      if(this.#closed)throw new Error('Announcement store closed.');
      await this.#saveText(`${id}.json`,bundledBody);return bundledArticle;
    }
    if(this.#details.has(id))return this.#details.get(id);
    const pending=(async()=>{
      const body=await this.#download(`${id}.json`,2*1024*1024),article=accept(body);
      if(this.#closed)throw new Error('Announcement store closed.');
      // Cache exact bytes for both downloads and bundled notices; hashes cover the representation.
      await this.#saveText(`${id}.json`,body);
      return article;
    })().finally(()=>this.#details.delete(id));
    this.#details.set(id,pending);return pending;
  }
  async markRead(id) {
    if(this.#closed || !ANNOUNCEMENT_ID.test(id) || !this.#index.entries.some(row=>row.id===id))throw new Error('Unknown announcement.');
    const operation=this.#mutations.catch(()=>{}).then(async()=>{
      const next=new Set(this.#read);next.add(id);
      await this.#save('read.json',[...next]);this.#read=next;return this.getList();
    });
    this.#mutations=operation;return operation;
  }
  start() {
    if(this.#closed || this.#timer)return;
    void this.check();this.#timer=setInterval(()=>void this.check(),60*60*1000);this.#timer.unref?.();
  }
  async close() {
    this.#closed=true;clearInterval(this.#timer);for(const controller of this.#downloads)controller.abort();
    await Promise.allSettled([this.#pending,this.#writes,this.#mutations,...this.#details.values()].filter(Boolean));
  }
}

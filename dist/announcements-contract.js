export const ANNOUNCEMENT_FEED = 'https://raw.githubusercontent.com/ci16kuai/hexguide-desktop/codex/announcements-feed/announcements/';
export const ANNOUNCEMENT_ID = /^[a-f0-9]{24}$/;
const sha = /^[a-f0-9]{64}$/;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b-\u001f]/u.test(v);
const date = v => text(v, 40) && Number.isFinite(Date.parse(v));
const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 4000;
const value = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e12;
export const numericValue = v => value(v) || Array.isArray(v) && v.length > 0 && v.length <= 31 && v.every(value);
const invalid = () => { throw new TypeError('Invalid announcement data.'); };
export function validIconUrl(value) {
  if(typeof value!=='string'||value.length>600)return false;
  let url;try{url=new URL(value);}catch{return false;}
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash
    && (/^https:\/\/ddragon\.leagueoflegends\.com\/cdn\/\d+\.\d+\.\d+\/img\/(item|spell|passive|champion)\/[A-Za-z0-9_.-]+\.png$/.test(value)
      || /^https:\/\/raw\.communitydragon\.org\/\d+\.\d+\/game\/assets\/[a-z0-9_./-]+\.png$/.test(value));
}
export function validatePresentation(input) {
  if(input?.schemaVersion!==1||!Array.isArray(input.articles)||input.articles.length>4000)invalid();
  const articles=input.articles.map(row=>{
    if(!row||!ANNOUNCEMENT_ID.test(row.id)||!sha.test(row.sha256)||!row.icons||Array.isArray(row.icons)||typeof row.icons!=='object'||Object.keys(row.icons).length>4000)invalid();
    const icons=Object.fromEntries(Object.entries(row.icons).map(([key,url])=>{if(!text(key,600)||!validIconUrl(url))invalid();return [key,url];}));
    let official;
    if(row.official!==undefined){
      const o=row.official;let url;try{url=new URL(o.url);}catch{invalid();}
      if(!/^\d{4}-\d{2}-\d{2}$/.test(o.date)||!date(o.date)||new Date(o.date).toISOString().slice(0,10)!==o.date||!text(o.title,120)||!sha.test(o.sha256)
        ||url.protocol!=='https:'||url.username||url.password||url.port||!['lol.qq.com','www.leagueoflegends.com'].includes(url.hostname))invalid();
      official={date:o.date,title:o.title,url:url.href,sha256:o.sha256};
    }
    if(row.updatedAt!==undefined&&!date(row.updatedAt))invalid();
    return {id:row.id,sha256:row.sha256,icons,...(official?{official}:{}),...(row.updatedAt?{updatedAt:row.updatedAt}:{})};
  });
  if(new Set(articles.map(row=>row.id)).size!==articles.length)invalid();
  return {schemaVersion:1,articles};
}
export function validateSummary(row) {
  if (!row || !ANNOUNCEMENT_ID.test(row.id) || !sha.test(row.sha256) || !text(row.title, 120) || !date(row.publishedAt)
    || !text(row.fromVersion, 32) || !text(row.toVersion, 32) || !count(row.itemCount) || !count(row.augmentCount)
    || !count(row.changeCount) || row.changeCount < 1) invalid();
  if(row.championCount!==undefined&&!count(row.championCount))invalid();
  return {...Object.fromEntries(['id','sha256','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].map(k => [k,row[k]])),...(row.championCount!==undefined?{championCount:row.championCount}:{})};
}
export function validateIndex(input) {
  if (input?.schemaVersion !== 1 || !sha.test(input.revision) || !date(input.publishedAt)
    || !Array.isArray(input.entries) || input.entries.length > 4000) invalid();
  const entries = input.entries.map(validateSummary);
  if (new Set(entries.map(x => x.id)).size !== entries.length) invalid();
  return {schemaVersion:1, revision:input.revision, publishedAt:input.publishedAt, entries};
}
export function validateArticle(input) {
  if (input?.schemaVersion !== 1 || !ANNOUNCEMENT_ID.test(input.id) || !text(input.title,120) || !date(input.publishedAt)
    || !text(input.fromVersion,32) || !text(input.toVersion,32) || !text(input.summary,400) || !text(input.scopeNote,600)
    || !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 4000
    || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 20) invalid();
  const changes = input.changes.map(row => {
    if (!row || !text(row.key,600) || !['item','augment','champion'].includes(row.kind) || !text(row.entityId,120)
      || !text(row.name,120) || !text(row.field,400) || !text(row.label,120) || !numericValue(row.before) || !numericValue(row.after)
      || !['','%','金币','秒'].includes(row.unit) || ![1,100].includes(row.scale)
      || JSON.stringify(row.before) === JSON.stringify(row.after)) invalid();
    if(row.icon!==undefined&&!validIconUrl(row.icon))invalid();
    if(row.kind==='champion'&&(!row.ability||!['Q','W','E','R'].includes(row.ability.slot)||!text(row.ability.name,120)||!validIconUrl(row.icon)))invalid();
    return {...Object.fromEntries(['key','kind','entityId','name','field','label','before','after','unit','scale'].map(k => [k,row[k]])),
      ...(row.icon?{icon:row.icon}:{}),...(row.kind==='champion'?{ability:{slot:row.ability.slot,name:row.ability.name}}:{})};
  });
  if (new Set(changes.map(x => x.key)).size !== changes.length) invalid();
  const sources = input.sources.map(row => {
    let url; try { url = new URL(row.url); } catch { invalid(); }
    if (url.protocol !== 'https:' || !['ddragon.leagueoflegends.com','raw.communitydragon.org','www.leagueoflegends.com'].includes(url.hostname)
      || url.username || url.password || !sha.test(row.sha256) || !text(row.name,120)) invalid();
    return {name:row.name,url:url.href,sha256:row.sha256};
  });
  const itemCount = new Set(changes.filter(x => x.kind === 'item').map(x => x.entityId)).size;
  const augmentCount = new Set(changes.filter(x => x.kind === 'augment').map(x => x.entityId)).size;
  const championCount = new Set(changes.filter(x => x.kind === 'champion').map(x => x.entityId)).size;
  if (input.itemCount !== itemCount || input.augmentCount !== augmentCount || input.changeCount !== changes.length) invalid();
  if((input.championCount??0)!==championCount)invalid();
  return {schemaVersion:1,id:input.id,title:input.title,publishedAt:input.publishedAt,fromVersion:input.fromVersion,toVersion:input.toVersion,
    summary:input.summary,scopeNote:input.scopeNote,itemCount,augmentCount,...(input.championCount!==undefined?{championCount}:{}),changeCount:changes.length,changes,sources};
}

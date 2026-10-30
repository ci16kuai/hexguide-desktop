export const ANNOUNCEMENT_FEED = 'https://raw.githubusercontent.com/ci16kuai/hexguide-desktop/codex/announcements-feed/announcements/';
export const ANNOUNCEMENT_ID = /^[a-f0-9]{24}$/;
const sha = /^[a-f0-9]{64}$/;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b-\u001f]/u.test(v);
const date = v => text(v, 40) && Number.isFinite(Date.parse(v));
const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 4000;
const value = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e12;
export const numericValue = v => value(v) || Array.isArray(v) && v.length > 0 && v.length <= 31 && v.every(value);
const invalid = () => { throw new TypeError('Invalid announcement data.'); };
export function validateSummary(row) {
  if (!row || !ANNOUNCEMENT_ID.test(row.id) || !sha.test(row.sha256) || !text(row.title, 120) || !date(row.publishedAt)
    || !text(row.fromVersion, 32) || !text(row.toVersion, 32) || !count(row.itemCount) || !count(row.augmentCount)
    || !count(row.changeCount) || row.changeCount < 1) invalid();
  return Object.fromEntries(['id','sha256','title','publishedAt','fromVersion','toVersion','itemCount','augmentCount','changeCount'].map(k => [k,row[k]]));
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
    if (!row || !text(row.key,600) || !['item','augment'].includes(row.kind) || !text(row.entityId,120)
      || !text(row.name,120) || !text(row.field,400) || !text(row.label,120) || !numericValue(row.before) || !numericValue(row.after)
      || !['','%','金币'].includes(row.unit) || ![1,100].includes(row.scale)
      || JSON.stringify(row.before) === JSON.stringify(row.after)) invalid();
    return Object.fromEntries(['key','kind','entityId','name','field','label','before','after','unit','scale'].map(k => [k,row[k]]));
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
  if (input.itemCount !== itemCount || input.augmentCount !== augmentCount || input.changeCount !== changes.length) invalid();
  return {schemaVersion:1,id:input.id,title:input.title,publishedAt:input.publishedAt,fromVersion:input.fromVersion,toVersion:input.toVersion,
    summary:input.summary,scopeNote:input.scopeNote,itemCount,augmentCount,changeCount:changes.length,changes,sources};
}

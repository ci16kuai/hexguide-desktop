/**
 * Read-only OP.GG public champion/item aggregate adapter. No page JavaScript is
 * executed: only JSON React Flight payloads are decoded. No account, match,
 * client credentials, cookies, or player identifiers enter requests.
 *
 * Attribution: OP.GG, https://op.gg/ . Public reuse guidance (checked 2026-10-25):
 * https://help.op.gg/hc/en-us/articles/31091405109401-Can-I-use-OP-GG-data
 * Keep OP.GG attribution/sourceUrl with projections; make requests sparingly.
 * This is an HTML adapter, not an official stable data API. Structural changes
 * fail closed. The repository owns caching/current-hero prefetch/backoff.
 */
const ORIGIN = 'https://op.gg';
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const BLOCK_BACKOFF_MS = 30 * 60 * 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const array = value => Array.isArray(value) ? value : [];
const compact = value => String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

function requestIdentity({championId, championSlug, patch} = {}) {
  const id = typeof championId === 'number' && positiveId(championId) ? String(championId)
    : typeof championId === 'string' && /^[A-Za-z][A-Za-z0-9]{1,39}$|^[1-9]\d{0,5}$/.test(championId) ? championId : null;
  if (!id || typeof patch !== 'string' || !/^\d{1,3}\.\d{1,3}[a-z]?$/.test(patch)) return null;
  const numeric = /^[1-9]\d*$/.test(id);
  const slug = championSlug ?? (numeric ? null : id.toLowerCase());
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9]{1,39}$/.test(slug)) return null;
  // Current OP.GG champion keys match Riot IDs lowercased, including monkeyking.
  // Do not guess an English display name or silently query another champion.
  if (!numeric && compact(id) !== slug) return null;
  return {championId:id, slug, patch, numeric};
}

function urlFor(identity, mode) {
  const route = mode === 'aram' ? `/lol/modes/aram/${identity.slug}/items`
    : `/lol/champions/${identity.slug}/items`;
  return `${ORIGIN}${route}?patch=${identity.patch}${mode === 'aram' ? '' : '&type=ranked'}`;
}

/** Bounded iterative traversal; Flight references remain strings, never eval. */
function objects(value) {
  const result = [], pending = [{value, depth:0}];
  let visits = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++visits > 80000 || current.depth > 80) throw Error('Structure limit.');
    if (!current.value || typeof current.value !== 'object') continue;
    result.push(current.value);
    for (const child of Object.values(current.value)) if (child && typeof child === 'object') {
      pending.push({value:child, depth:current.depth + 1});
    }
  }
  return result;
}

function flightRoots(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_BYTES) return [];
  const chunks = [];
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const push = match[1].trim().match(/^self\.__next_f\.push\(([\s\S]*)\);?$/);
    if (!push) continue;
    let parsed;
    try { parsed = JSON.parse(push[1]); } catch { continue; }
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === 1 && typeof parsed[1] === 'string') chunks.push(parsed[1]);
    if (chunks.length > 512) return [];
  }
  const roots = [];
  for (const line of chunks.join('').split('\n')) {
    const model = line.match(/^[0-9a-f]+:([\s\S]+)$/i);
    if (!model || !/^[\[{]/.test(model[1])) continue;
    try { roots.push(JSON.parse(model[1])); } catch { /* Imports/text records are not data models. */ }
    if (roots.length > 512) return [];
  }
  return roots;
}

function elementText(node, depth = 0) {
  if (depth > 30) return '';
  if (typeof node === 'string') return node.startsWith('$') ? '' : node;
  if (!Array.isArray(node)) return '';
  if (node[0] === '$' && record(node[3])) return elementText(node[3].children, depth + 1);
  return node.map(child => elementText(child, depth + 1)).join('');
}

function identityProof(all, identity, mode) {
  const rawMode = mode === 'aram' ? 'aram' : 'ranked';
  const tracking = all.filter(node => record(node) && node.detail === 'items'
    && node.main === (mode === 'aram' ? 'modes' : 'champions') && node.sub === rawMode && record(node.params));
  if (tracking.length !== 1 || tracking[0].params.game_patch_version !== identity.patch) return null;
  if (!all.some(node => record(node) && node.championName === identity.slug
    && (mode !== 'aram' || node.type === 'aram'))) return null;
  if (mode === 'aram') {
    const filters = all.filter(node => record(node) && record(node.pathParams)
      && node.pathParams.mode === 'aram' && array(node.pathParams.slug)[0] === identity.slug
      && array(node.pathParams.slug)[1] === 'items' && record(node.query));
    if (filters.length !== 1 || filters[0].query.patch !== identity.patch) return null;
    // The directory is used only for the stable numeric champion identity.
    // Its query can be a Flight reference; current mode/patch proof comes from
    // the independent, fully materialized filter and tracking records above.
    const directories = all.filter(node => record(node) && Array.isArray(node.champions) && node.type === 'aram');
    const matches = directories.flatMap(node => node.champions).filter(hero => record(hero) && hero.key === identity.slug && positiveId(hero.id));
    if (!matches.length || new Set(matches.map(hero => hero.id)).size !== 1) return null;
    if (identity.numeric && String(matches[0].id) !== identity.championId) return null;
    return {sourceChampionId:matches[0].id, region:filters[0].query.region || 'global',
      tier:filters[0].query.tier || 'all', position:null};
  }
  if (tracking[0].params.type !== 'ranked') return null;
  // The ranked page uses the champion's default position. Keep that scope; it
  // is not all-position ARAM and must never be relabelled as such.
  const paths = all.filter(node => record(node) && typeof node.pathname === 'string'
    && new RegExp(`^/champions/${identity.slug}/build/[a-z]+$`).test(node.pathname)
    && record(node.query) && node.query.type === 'ranked');
  if (!paths.length || paths.some(node => node.query.patch !== identity.patch)) return null;
  const roles = [...new Set(paths.map(node => node.pathname.split('/').at(-1)))];
  if (roles.length !== 1) return null;
  const proLinks = all.filter(node => record(node) && node.key === 'pro-build'
    && typeof node.href === 'string' && /^https:\/\/esports\.op\.gg\/champions\/[1-9]\d*$/.test(node.href));
  const ids = [...new Set(proLinks.map(node => Number(node.href.split('/').at(-1))))];
  if (ids.length !== 1 || !positiveId(ids[0]) || identity.numeric && String(ids[0]) !== identity.championId) return null;
  return {sourceChampionId:ids[0], region:tracking[0].params.game_region || 'global',
    tier:tracking[0].params.game_tier || null, position:roles[0]};
}

function count(value) {
  if (typeof value !== 'string' || !/^(?:[1-9]\d{0,11}|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) return null;
  const result = Number(value.replaceAll(',', ''));
  return positiveId(result) ? result : null;
}

function itemRow(row, scope) {
  if (!record(row) || !Array.isArray(row.ids) || row.ids.length !== 1 || !positiveId(row.ids[0])
    || !record(row.metaItem) || row.metaItem.id !== row.ids[0] || !rate(row.win_rate)) return null;
  const sampleCount = count(row.play);
  if (sampleCount === null || row.pick_rate != null && !rate(row.pick_rate)) return null;
  return {id:row.ids[0], winRate:row.win_rate / 100, sampleCount,
    ...(row.pick_rate != null ? {pickRate:row.pick_rate / 100} : {}), scope};
}

function parsePage(html, identity, mode, observedAt) {
  const roots = flightRoots(html);
  if (!roots.length) return null;
  const all = objects(roots), proof = identityProof(all, identity, mode);
  if (!proof) return null;
  const sections = all.filter(node => Array.isArray(node) && node[0] === '$' && node[1] === 'section' && record(node[3]));
  const tables = new Map();
  for (const section of sections) {
    const title = elementText(array(section[3].children)[0]).trim();
    if (title !== 'Items' && title !== 'Boots') continue;
    const data = objects(section).filter(node => record(node) && Array.isArray(node.data) && typeof node.mode === 'string');
    if (data.length !== 1 || data[0].mode !== (mode === 'aram' ? 'aram' : 'ranked')
      || tables.has(title) || !data[0].data.length || data[0].data.length > 100) return null;
    const rows = data[0].data.map(row => itemRow(row, title === 'Items' ? 'single-item' : 'boots'));
    if (rows.some(row => row === null)) return null;
    tables.set(title, rows);
  }
  // A core-build table or a starter bundle cannot supply individual item rates.
  if (!tables.has('Items')) return null;
  const items = [...tables.get('Items'), ...(tables.get('Boots') || [])];
  if (new Set(items.map(row => row.id)).size !== items.length) return null;
  return {mode, championId:identity.championId, patch:identity.patch, comparable:true,
    source:'OP.GG', sourceUrl:urlFor(identity, mode), observedAt,
    ...proof, items,
    attribution:'OP.GG public champion item aggregates; item rates and bundle rates are separate.',
  };
}

async function responseText(response) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) return null;
  const type = response.headers?.get?.('content-type');
  if (type && !/^text\/html\b/i.test(type)) return null;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); return null; }
        chunks.push(part.value);
      }
      return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
    } finally { reader.releaseLock(); }
  }
  const html = await response.text();
  return typeof html === 'string' && Buffer.byteLength(html, 'utf8') <= MAX_BYTES ? html : null;
}

/** At most one ARAM request and, only if unavailable, one ranked SR request. */
export function createReferenceBuildSource({fetcher = globalThis.fetch, now = Date.now} = {}) {
  if (typeof fetcher !== 'function' || typeof now !== 'function') throw TypeError('Invalid reference source configuration.');
  let blockedUntil = 0;
  const timestamp = () => {
    const value = now(), milliseconds = value instanceof Date ? value.getTime() : value;
    return typeof milliseconds === 'number' && Number.isFinite(milliseconds) ? milliseconds : null;
  };
  async function load(request) {
    const identity = requestIdentity(request), started = timestamp();
    if (!identity || started === null || started < blockedUntil) return null;
    for (const mode of ['aram', 'summoners-rift']) {
      const url = urlFor(identity, mode), controller = new AbortController();
      let timer;
      try {
        const work = (async () => {
          const response = await fetcher(url, {method:'GET', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer',
            headers:{Accept:'text/html', 'User-Agent':'HexGuide/1.10 (public aggregate reader)'}, signal:controller.signal});
          if ([401, 403, 429].includes(response?.status)) return {blocked:true};
          if (!response?.ok || response.url && response.url !== url) return {html:null};
          return {html:await responseText(response)};
        })();
        const result = await Promise.race([work, new Promise(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve({html:null}); }, TIMEOUT_MS);
        })]);
        if (result.blocked) {
          blockedUntil = (timestamp() ?? started) + BLOCK_BACKOFF_MS;
          return null;
        }
        if (result.html) {
          const observed = timestamp();
          if (observed === null) return null;
          const parsed = parsePage(result.html, identity, mode, new Date(observed).toISOString());
          if (parsed) return parsed;
        }
      } catch { /* Unknown/changed pages are unavailable, never synthesized. */ }
      finally { clearTimeout(timer); controller.abort(); }
    }
    return null;
  }
  return Object.freeze({load});
}

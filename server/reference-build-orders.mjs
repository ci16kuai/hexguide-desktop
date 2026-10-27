/**
 * OP.GG's public Core Items Table displays three core items separated by right
 * chevrons. This is a core-completion sequence, not a complete purchase log:
 * component and boot timing is not supplied. Bundle rates remain bundle rates.
 */
export const REFERENCE_ORDER_CONTRACT_VERSION = 1;
export const MIN_REFERENCE_ORDER_SAMPLES = 200;
export const REFERENCE_ORDER_KIND = 'core-item-sequence';
const MAX_ROWS = 100;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const RIGHT_CHEVRON = 'M13.2 12 9 7.5 10.4 6l5.6 6-5.6 6L9 16.5z';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const id = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && positive(Number(value));
const invalid = () => { const error = new TypeError('Invalid reference build order.'); error.code = 'invalid-data'; throw error; };

/** Whitelist only bounded ordered rows; never distribute a bundle rate to items. */
export function validateReferenceBuildOrders(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) invalid();
  const seen = new Set();
  return rows.map(row => {
    if (!record(row) || row.orderKind !== REFERENCE_ORDER_KIND || !Array.isArray(row.items) || row.items.length !== 3
      || !row.items.every(id) || new Set(row.items).size !== 3 || !positive(row.sampleCount) || !probability(row.winRate)
      || row.pickRate != null && !probability(row.pickRate)) invalid();
    const key = row.items.join(',');
    if (seen.has(key)) invalid();
    seen.add(key);
    return {items:[...row.items], sampleCount:row.sampleCount, winRate:row.winRate, orderKind:REFERENCE_ORDER_KIND,
      ...(row.pickRate != null ? {pickRate:row.pickRate} : {})};
  });
}

export function hasUsableReferenceBuildOrder(snapshot) {
  return Array.isArray(snapshot?.buildOrders) && snapshot.buildOrders.some(row => row.sampleCount >= MIN_REFERENCE_ORDER_SAMPLES);
}

function count(value) {
  if (typeof value !== 'string' || !/^(?:[1-9]\d{0,11}|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) return null;
  const number = Number(value.replaceAll(',', ''));
  return positive(number) ? number : null;
}
function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2]?.replaceAll('&amp;', '&') ?? null;
}
function visibleRows(html, patch) {
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  // OP.GG reuses the same hidden caption for boots and single-item tables.
  // The visible section heading, not that generic caption, defines the scope.
  const sections = [...visible.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section\s*>/gi)].map(match => match[1])
    .filter(section => section.split(/<table\b/i)[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() === 'Core builds');
  if (sections.length !== 1) return null;
  const tables = [...sections[0].matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)]
    .map(match => match[1]).filter(table => /<caption\b[^>]*>\s*Core Items Table\s*<\/caption\s*>/i.test(table));
  if (tables.length !== 1) return null;
  const bodies = [...tables[0].matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/gi)];
  if (bodies.length !== 1) return null;
  const rows = [...bodies[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  if (!rows.length || rows.length > MAX_ROWS) return null;
  return rows.map(match => {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)];
    if (cells.length !== 3) return null;
    const tokens = [...cells[0][1].matchAll(/<img\b[^>]*>|<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi)];
    if (tokens.length !== 5 && tokens.length !== 7) return null;
    const items = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index][0];
      if (index % 2) {
        const paths = [...token.matchAll(/<path\b[^>]*>/gi)];
        if (!/^<svg\b/i.test(token) || paths.length !== 1 || attr(paths[0][0], 'd') !== RIGHT_CHEVRON) return null;
      } else {
        if (!/^<img\b/i.test(token)) return null;
        let url; try { url = new URL(attr(token, 'src')); } catch { return null; }
        const image = url.pathname.match(/^\/meta\/images\/lol\/(\d{1,3}\.\d{1,3})\.\d+\/item\/([1-9]\d{0,9})\.png$/);
        if (url.protocol !== 'https:' || url.hostname !== 'opgg-static.akamaized.net' || url.username || url.password || url.port
          || !image || image[1] !== patch.replace(/[a-z]$/, '')) return null;
        items.push(image[2]);
      }
    }
    const text = cell => cell.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const pick = text(cells[1][1]), win = text(cells[2][1]);
    const samples = pick.match(/([1-9][\d,]*)\s+Games\b/), pickRate = pick.match(/(\d+(?:\.\d+)?)%/), winRate = win.match(/^(\d+(?:\.\d+)?)%$/);
    if (!samples || !pickRate || !winRate) return null;
    return {items, sampleCount:count(samples[1]), pickRate:Number(pickRate[1]), winRate:Number(winRate[1])};
  });
}

/** Require independent, visible arrow proof for each JSON row in the same page. */
export function parseReferenceBuildOrders({html, rows, patch} = {}) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES || !Array.isArray(rows)
    || !rows.length || rows.length > MAX_ROWS || typeof patch !== 'string' || !/^\d{1,3}\.\d{1,3}[a-z]?$/.test(patch)) return [];
  const visible = visibleRows(html, patch);
  if (!visible || visible.length !== rows.length || visible.some(row => row === null)) return [];
  try {
    return validateReferenceBuildOrders(rows.map((row, index) => {
      if (!record(row) || !Array.isArray(row.ids) || ![3,4].includes(row.ids.length) || !row.ids.every(positive)
        || new Set(row.ids).size !== row.ids.length || !Array.isArray(row.metaBuildItems) || row.metaBuildItems.length !== row.ids.length
        || row.metaBuildItems.some((item, position) => !record(item) || item.id !== row.ids[position])
        || typeof row.win_rate !== 'number' || !probability(row.win_rate / 100)
        || row.pick_rate != null && (typeof row.pick_rate !== 'number' || !probability(row.pick_rate / 100))) invalid();
      const sampleCount = count(row.play), observed = visible[index], items = row.ids.map(String);
      if (sampleCount === null || items.join(',') !== observed.items.join(',') || sampleCount !== observed.sampleCount
        || Math.abs(row.win_rate - observed.winRate) > .005001
        || row.pick_rate != null && Math.abs(row.pick_rate - observed.pickRate) > .005001) invalid();
      // Some heroes show a component before three core items. Verify that whole
      // four-entry row, then omit it; never truncate it into a claimed triple.
      if (items.length !== 3) return null;
      return {items, sampleCount, winRate:row.win_rate / 100, orderKind:REFERENCE_ORDER_KIND,
        ...(row.pick_rate != null ? {pickRate:row.pick_rate / 100} : {})};
    }).filter(Boolean));
  } catch { return []; }
}

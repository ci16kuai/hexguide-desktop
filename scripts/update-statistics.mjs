#!/usr/bin/env node
/** Import one fixed, attributable AramHex snapshot. Never combines live and PBE cohorts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { SOURCE, transformStatistics, fetchSourceFile, validateSourceDocuments } from '../server/statistics-source.mjs';
export { SOURCE, transformStatistics, validateCounts } from '../server/statistics-source.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function verifiedSource(filename, { cache, refresh, offline }) {
  const cacheFile = path.join(cache, SOURCE.commit, filename);
  let bytes;
  if (!refresh || offline) {
    try { bytes = await fs.readFile(cacheFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!bytes) {
    assert(!offline, `No cached source file: ${filename}`);
    ({ bytes } = await fetchSourceFile(SOURCE.commit, filename, { patch: SOURCE.patch }));
  }
  assert(bytes.length <= (filename === 'latest.json' ? 64 * 1024 : 4 * 1024 * 1024), `Source file too large: ${filename}`);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert(actualHash === SOURCE.hashes[filename], `SHA-256 mismatch: ${filename}; previous statistics file preserved`);
  const json = JSON.parse(bytes.toString('utf8'));
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, bytes);
  return json;
}

export async function updateStatistics({ output = path.join(project, 'dist/statistics.json'), cache = 'H:/Chatgpt/work/2026-10-29/hexguide-statistics-update/statistics-source-cache', refresh = false, offline = false } = {}) {
  const config = { cache, refresh, offline };
  const [latest, meta, heroes, heroAugments, sourceAugments, championCatalog, gameData] = await Promise.all([
    verifiedSource('latest.json', config), verifiedSource('meta.json', config),
    verifiedSource('heroes.json', config), verifiedSource('hero_augments.json', config), verifiedSource('augments.json', config),
    fs.readFile(path.join(project, 'server/resources/champions-16.21.1.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(project, 'dist/data.json'), 'utf8').then(JSON.parse),
  ]);
  validateSourceDocuments({ latest, meta, source: SOURCE });
  const result = transformStatistics({ meta, heroes, heroAugments, sourceAugments, championCatalog, gameData });
  const destination = path.resolve(output);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(result) + '\n', { flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    assert(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${name}`);
    return args[index + 1];
  };
  try {
    const result = await updateStatistics({ output: option('--out', undefined), cache: option('--cache', undefined), refresh: args.includes('--refresh'), offline: args.includes('--offline') });
    console.log(JSON.stringify({ patch: result.meta.patch, snapshot: result.meta.statsUpdatedAt, validGames: result.meta.validGames, ...result.meta.coverage }));
  } catch (error) {
    console.error(`Statistics import failed: ${error.message}`);
    process.exitCode = 1;
  }
}

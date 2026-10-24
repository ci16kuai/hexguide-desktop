import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build an isolated developer sample. No game, account, or production app state
// is read. An existing destination is never replaced or recursively removed.
const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, '../..');
const destinationArg = process.argv[2];
if (!destinationArg) throw new Error('Provide a new absolute output directory.');
if (!path.isAbsolute(destinationArg)) throw new Error('Output directory must be absolute.');
const destination = path.resolve(destinationArg);
let exists = false;
try { await access(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (exists) throw new Error('Output directory already exists; choose a new directory.');

const dataBytes = await readFile(path.join(root, 'dist/data.json'));
const data = JSON.parse(dataBytes.toString('utf8'));
const fields = ['id', 'name', 'gameDataId', 'availability', 'sourceGameId', 'sourcePath', 'definitionKey'];
const augments = data.augments
  .filter(row => row.availability === 'current' && Number.isSafeInteger(row.gameDataId)
    && row.gameDataId > 0 && typeof row.name === 'string' && row.name.trim().length > 0
    && row.isInternalTemplate !== true)
  .map(row => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])));
if (augments.length === 0) throw new Error('Current named augment catalog is empty.');

// The existing ICO contains PNG entries. Extract the largest native PNG without
// rasterizing, modifying the source icon, or downloading another image.
const icon = await readFile(path.join(root, 'native/assets/hexguide.ico'));
if (icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1) throw new Error('Invalid app icon.');
let largest = null;
for (let index = 0; index < icon.readUInt16LE(4); index += 1) {
  const at = 6 + index * 16;
  const width = icon[at] || 256;
  const length = icon.readUInt32LE(at + 8);
  const offset = icon.readUInt32LE(at + 12);
  const png = icon.subarray(offset, offset + length);
  if (png.length === length && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && (!largest || width > largest.width)) largest = { width, png };
}
if (!largest) throw new Error('PNG icon entry missing.');

await mkdir(path.join(destination, 'icons'), { recursive: true });
for (const name of ['manifest.json', 'observer.html', 'observer.mjs', 'decoder.mjs']) {
  await copyFile(path.join(source, name), path.join(destination, name));
}
await copyFile(path.join(root, 'native/assets/hexguide.ico'), path.join(destination, 'icons/hexguide.ico'));
await writeFile(path.join(destination, 'icons/hexguide.png'), largest.png, { flag: 'wx' });
await writeFile(path.join(destination, 'catalog.json'), JSON.stringify({ augments }, null, 2) + '\n', { flag: 'wx' });
await copyFile(path.join(source, 'README.md'), path.join(destination, 'README.md'));
console.log(JSON.stringify({ destination, namedCurrentAugments: augments.length, installed: false, liveGameVerified: false }));

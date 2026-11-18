import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {validateStoredStatistics} from '../server/statistics-updater.mjs';
import {comparePatches} from '../dist/version.js';
import {applyRules} from '../server/rules.mjs';

const [stage, input, rulesFile, manifestFile] = process.argv.slice(2);
const load = async file => JSON.parse(await readFile(path.join(stage,file),'utf8'));
const [before, baseCatalog, championCatalog, body] = await Promise.all([
  load('dist/statistics.json'), load('dist/data.json'), load('server/resources/champions-16.21.1.json'), readFile(input)
]);
let gameData=baseCatalog;
if (rulesFile && manifestFile) {
  const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
  gameData=applyRules(baseCatalog,manifest,await readFile(rulesFile));
  gameData.meta.clientDataVersion=manifest.clientPatch;
}
const next = validateStoredStatistics(JSON.parse(body), {gameData,championCatalog});
if (comparePatches(next.meta.patch,before.meta.patch)<0 || Date.parse(next.meta.statsUpdatedAt)<Date.parse(before.meta.statsUpdatedAt)) {
  throw Error('An older snapshot cannot replace the bundled statistics.');
}
await writeFile(path.join(stage,'dist/statistics.json'), body);
if (gameData!==baseCatalog) await writeFile(path.join(stage,'dist/data.json'),JSON.stringify(gameData)+'\n');

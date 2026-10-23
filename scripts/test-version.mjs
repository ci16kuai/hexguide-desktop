import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {getVersionInfo, formatDataTime} from '../dist/version.js';

const separated = getVersionInfo({gameVersion:'4.0',patch:'26.21',statsPatch:'26.20',statsDate:'2026-10-20',dataDragonVersion:'16.21.1',updatedAt:'2026-10-23T06:00:00Z'});
assert.equal(separated.label,'4.0 · 26.21');
assert.equal(separated.championVersion,'16.21.1');
assert.equal(separated.statsPatch,'26.20');
assert.equal(separated.statsDate,'2026-10-20');
assert.equal(separated.statsLag,true);
assert.equal(separated.updatedLabel,'2026-10-23 17:00（UTC+11）');
assert.equal(formatDataTime('invalid'),'时间待核实');
assert.equal(formatDataTime(null),'时间待核实');
assert.equal(formatDataTime('2026-06-10T06:00:00Z'),'2026-06-10 16:00（UTC+10）');
const actual = JSON.parse(await fs.readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const version = getVersionInfo(actual.meta);
assert.ok(version.updatedAt && version.updatedLabel !== '时间待核实');
assert.equal(version.updatedAt, actual.meta.updatedAt || actual.meta.fetchedAt);
if (actual.meta.gameVersion === '4.0') {
  assert.equal(version.rulesPatch,'26.21');
  assert.ok(version.championVersion.startsWith('16.21.'));
  assert.ok(version.statsPatch);
}
console.log('PASS: separate rules, champion and statistics versions; saved update time; explicit timezone and daylight saving.');

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {matchOcrProposals} from '../server/ocr.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../native/scan-augments.ps1', import.meta.url));

test('native Chinese OCR reads all three generated headings and maps title crops back to one frame', {skip:process.platform !== 'win32', timeout:30000}, async t => {
  const fixture = fileURLToPath(new URL('./fixtures/native-ocr-frame.ps1', import.meta.url));
  const {stdout} = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Source', source], {windowsHide:true, timeout:28000, maxBuffer:1024 * 1024, encoding:'utf8'});
  const raw = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (raw.unavailable) { t.skip(raw.reason); return; }
  assert.equal(raw.frameId, 'synthetic-fixture-not-live-game');
  assert.equal(raw.identityAnchors.version,1);
  assert.equal(raw.identityAnchors.algorithm,'luma-sobel-16x8-v1');
  assert.equal(raw.identityAnchors.frameId,raw.frameId);
  assert.equal(raw.identityAnchors.capturedAt,raw.selectionCapture.capturedAt);
  const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
  for (const pass of ['card-titles-color', 'card-titles-contrast']) {
    const lines = raw.lines.filter(line => line.pass === pass);
    assert.equal(new Set(lines.map(line => line.column)).size, 3, `${pass} must observe every column`);
    for (const line of lines) {
      assert.equal(line.frameId, raw.frameId);
      assert.equal(line.region, 'card-title');
      assert.ok(line.x >= line.crop.x && line.x + line.width <= line.crop.x + line.crop.width + 1);
      assert.ok(line.y >= 570 && line.y < 640, 'coordinates must be original 1440p pixels, not 3x crop pixels');
    }
    const matched=matchOcrProposals({...raw,lines},data.augments);
    assert.deepEqual(matched.proposals.map(item => item.name), ['升级：耀光', '贪欲束缚', '急急小子'], `${pass} must be independently compatible with the proposal matcher`);
    const anchors=lines.map(line=>raw.identityAnchors.anchors[line.identityAnchorIndex]);
    assert.ok(anchors.every(Boolean),'each actual OCR line must reference its same-frame descriptor');
    for(const anchor of anchors){
      assert.equal(anchor.feature.length,128);
      assert.ok(anchor.feature.every(value=>Number.isInteger(value)&&value>=0&&value<=64));
      assert.equal(anchor.feature.reduce((sum,value)=>sum+value,0),anchor.quality.edgePixels);
      assert.equal(anchor.feature.filter(value=>value>0).length,anchor.quality.activeCells);
    }
    // This dense Chinese fixture exposed the old 4096-edge ceiling. The shared
    // quality gate now distinguishes spatially varied strokes from flat edge
    // noise; keep the same text and font as a regression, without weakening any
    // identity similarity or game-selection evidence threshold.
    assert.ok(anchors.every(anchor=>anchor.quality.usable));
    assert.equal(matched.selectionMetadataStatus,'accepted');
    assert.equal(matched.selectionCapture.identityAnchors.cards.length,3);
  }
  for (const geometry of raw.geometries) for (const region of geometry.regions) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= geometry.width && region.y + region.height <= geometry.height);
  }
});

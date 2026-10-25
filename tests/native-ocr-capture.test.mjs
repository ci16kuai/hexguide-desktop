import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {matchOcrProposals} from '../server/ocr.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../native/scan-augments.ps1', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/native-ocr-frame.ps1', import.meta.url));

function generatedStageScan(acceptStage, augments, {blank=false, omitAcknowledgement=false} = {}) {
  return new Promise((resolve,reject) => {
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixture,'-Source',source,'-StageWorker',...(blank?['-BlankFrame']:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',result=null,unavailable=null,parseError=null;
    const stages=[];
    const timer=setTimeout(()=>{ child.kill(); reject(new Error('Generated OCR stage fixture timed out.')); },14000);
    child.stderr.resume();
    child.on('error',error=>{ clearTimeout(timer); reject(error); });
    child.stdin.on('error',()=>{});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let index;
      while((index=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,index).replace(/^\uFEFF/,''); buffer=buffer.slice(index+1);
        try {
          const envelope=JSON.parse(line);
          if(envelope.unavailable) { unavailable=envelope; continue; }
          assert.equal(envelope.version,1); assert.equal(envelope.id,1);
          if(envelope.type==='stage') {
            stages.push(envelope);
            const matched=matchOcrProposals(envelope.payload,augments);
            const accepted=envelope.stage===acceptStage && matched.proposals.length===3 && matched.selectionMetadataStatus==='accepted';
            if(!omitAcknowledgement) child.stdin.write(JSON.stringify({version:1,type:accepted?'accept':'continue',id:1})+'\n');
          } else { assert.equal(envelope.type,'result'); result=envelope.payload; }
        } catch(error) { parseError=error; child.kill(); }
      }
    });
    child.on('close',code=>{
      clearTimeout(timer);
      if(parseError) reject(parseError);
      else resolve({code,result,stages,unavailable});
    });
    child.stdin.write(JSON.stringify({version:1,type:'scan',id:1})+'\n');
  });
}

test('native Chinese OCR reads all three generated headings and maps title crops back to one frame', {skip:process.platform !== 'win32', timeout:30000}, async t => {
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

for(const [acceptStage,expectedPasses,expectedStages] of [
  ['color',3,['color']],['contrast',6,['color','contrast']],[null,7,['color','contrast']],
]) test(`generated native staging ${acceptStage ? `accepts ${acceptStage}` : 'continues to full fallback'} with ${expectedPasses} passes`,{skip:process.platform!=='win32',timeout:20000},async t=>{
  const data=JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
  const {code,result,stages,unavailable}=await generatedStageScan(acceptStage,data.augments);
  if(unavailable) { t.skip(unavailable.reason); return; }
  assert.equal(code,0); assert.equal(result.status,'recognized');
  assert.deepEqual(stages.map(stage=>stage.stage),expectedStages);
  assert.equal(result.diagnostics.passesCompleted,expectedPasses);
  assert.equal(result.diagnostics.passesFailed,0);
  assert.equal(result.diagnostics.passCodes.includes('full-window'),expectedPasses===7);
  assert.equal(result.frameId,'synthetic-fixture-not-live-game');
  for(const envelope of stages) {
    const matched=matchOcrProposals(envelope.payload,data.augments);
    assert.deepEqual(matched.proposals.map(item=>item.name),['升级：耀光','贪欲束缚','急急小子']);
    assert.equal(matched.selectionMetadataStatus,'accepted');
    assert.equal(matched.selectionCapture.identityAnchors.cards.length,3);
  }
});

test('blank generated frame cannot satisfy a triple and executes all fallback passes',{skip:process.platform!=='win32',timeout:20000},async t=>{
  const {code,result,stages,unavailable}=await generatedStageScan('color',[],{blank:true});
  if(unavailable) { t.skip(unavailable.reason); return; }
  assert.equal(code,0); assert.equal(result.status,'recognized');
  assert.equal(result.lines.length,0);
  assert.deepEqual(stages.map(stage=>stage.stage),['color','contrast']);
  assert.equal(result.diagnostics.passesCompleted,7);
});

test('missing generated-stage acknowledgement fails within native budget and stops later passes',{skip:process.platform!=='win32',timeout:20000},async t=>{
  const {code,result,stages,unavailable}=await generatedStageScan(null,[],{omitAcknowledgement:true});
  if(unavailable) { t.skip(unavailable.reason); return; }
  assert.equal(code,1); assert.equal(result.status,'unavailable');
  assert.deepEqual(stages.map(stage=>stage.stage),['color']);
  assert.equal(result.diagnostics.passesCompleted,3);
  assert.ok(result.diagnostics.totalMs<=10500,'native 10s budget includes a small timer/serialization allowance');
  assert.equal(result.selectionCapture,undefined);
  assert.equal(result.identityAnchors,undefined);
});

test('pending native calls poison reuse and incomplete groups never publish an early stage',{skip:process.platform!=='win32',timeout:10000},async()=>{
  const safetyFixture=fileURLToPath(new URL('./fixtures/native-ocr-safety.ps1',import.meta.url));
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',safetyFixture,'-Source',source],{windowsHide:true,timeout:8000,maxBuffer:65536,encoding:'utf8'});
  const result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
  assert.deepEqual(result.pending,{caught:true,poisoned:true,cancelled:true,taskStillPending:true,passesInvoked:1});
  assert.deepEqual(result.recoverable,{passesInvoked:6,passesCompleted:5,passesFailed:1,stages:['contrast'],lines:5,poisoned:false,fullWindow:false});
});

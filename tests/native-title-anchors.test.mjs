import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
test('native same-frame title helpers reject blank and out-of-crop anchors and enforce fixed bounds',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const fixture=fileURLToPath(new URL('./fixtures/native-title-anchors.ps1',import.meta.url));
  const source=fileURLToPath(new URL('../native/scan-augments.ps1',import.meta.url));
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixture,'-Source',source],{windowsHide:true,timeout:12000,maxBuffer:256*1024,encoding:'utf8'});
  const output=JSON.parse(stdout.replace(/^\uFEFF/,''));
  const metadata=output.identityAnchors;
  assert.equal(output.first,0,'zero is a valid anchor index');
  assert.equal(output.blank,1);
  assert.equal(output.outsideRejected,true);
  assert.equal(output.fullWindowRejected,true);
  assert.equal(output.perPassLimit,6);
  assert.equal(metadata.anchors.length,36);
  assert.equal(metadata.frameId,'synthetic-anchor-boundary-not-live');
  assert.equal(metadata.capturedAt,1000);
  assert.equal(metadata.algorithm,'luma-sobel-16x8-v1');
  assert.equal(metadata.anchors[0].quality.usable,true,'sparse artificial strokes exercise the usable path');
  assert.equal(metadata.anchors[1].quality.usable,false,'a blank region never supplies identity evidence');
  assert.equal(metadata.anchors[1].quality.edgePixels,0);
  assert.deepEqual(metadata.anchors[0].box,{x:148,y:138,width:79,height:31});
  assert.ok(output.metadataBytes<=32768);
  for(const [index,anchor] of metadata.anchors.entries()){
    assert.equal(anchor.index,index);
    assert.equal(anchor.feature.length,128);
    assert.ok(anchor.feature.every(value=>Number.isInteger(value)&&value>=0&&value<=64));
    assert.equal(anchor.feature.reduce((sum,value)=>sum+value,0),anchor.quality.edgePixels);
  }
});

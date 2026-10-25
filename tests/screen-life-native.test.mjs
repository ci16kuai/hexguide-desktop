import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../', import.meta.url));
const script=path.join(root,'native','scan-life.ps1');
const powershell=path.join(process.env.WINDIR || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const windows=process.platform==='win32';
function invoke(args=[]) {
  const child=spawnSync(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,...args],{cwd:root,encoding:'utf8',timeout:20_000,windowsHide:true,maxBuffer:16_384});
  assert.equal(child.error,undefined,child.error?.message);
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stderr,'');
  const output=child.stdout.trim();
  assert.ok(Buffer.byteLength(output)<1024,'Numeric observation must stay bounded.');
  assert.equal(output.split(/\r?\n/).length,1,'Only one fixed-schema result may leave the child.');
  return JSON.parse(output);
}
const calibration=()=>({version:1,verified:true,clientWidth:1920,clientHeight:1080,dpi:96,
  timer:{x:500,y:970,width:48,height:40},
  scene:[{x:600,y:300,width:100,height:100,aliveSaturation:.4},{x:900,y:300,width:100,height:100,aliveSaturation:.4},{x:1200,y:300,width:100,height:100,aliveSaturation:.4}]});

test('screen life state machine and sampling use offline generated fixtures only',{skip:!windows},()=>{
  const result=invoke(['-SelfTest']);
  assert.equal(result.mode,'offline-no-ui');
  assert.equal(result.liveGameVerified,false);
  assert.ok(result.checks>=44);
});
test('uncalibrated fallback is unavailable before any screen or OCR call',{skip:!windows},()=>{
  const result=invoke();
  assert.equal(result.code,'experimental-calibration-required');
  assert.equal(result.timerStatus,'unknown');
  assert.equal(result.capturedAtMs,0);
  assert.equal(result.windowHandle,0);
  assert.equal(result.timerOcrAttempted,false);
  assert.equal(result.timerOcrComplete,false);
  assert.equal(result.countdownSeconds,null);
  assert.deepEqual(Object.keys(result).sort(),['version','source','status','code','timerStatus','countdownSeconds','capturedAtMs','windowHandle','clientBounds','dpi','sceneGray','sceneColorRestored','timerOcrAttempted','timerOcrComplete','elapsedMs'].sort());
});
test('valid numeric profile without ReadTimer still does not query a live game',{skip:!windows},()=>{
  const result=invoke(['-CalibrationJson',JSON.stringify(calibration()),'-WindowHandle','42']);
  assert.equal(result.code,'timer-not-requested');
  assert.equal(result.capturedAtMs,0);
});
test('unreviewed profile cannot activate a screen probe',{skip:!windows},()=>{
  const profile=calibration(); profile.verified=false;
  const result=invoke(['-CalibrationJson',JSON.stringify(profile),'-WindowHandle','42','-ReadTimer']);
  assert.equal(result.code,'experimental-calibration-required');
  assert.equal(result.capturedAtMs,0);
});
test('malformed HUD positions and typed metadata fail closed without capture',{skip:!windows},()=>{
  const profiles=[];
  let p=calibration(); p.timer.y=50; profiles.push(p);
  p=calibration(); p.scene[0].aliveSaturation=true; profiles.push(p);
  p=calibration(); p.scene[0].width=8000; profiles.push(p);
  p=calibration(); p.clientWidth='1920'; profiles.push(p);
  p=calibration(); p.scene.length=2; profiles.push(p);
  p=calibration(); p.scene[1].x=p.scene[0].x; profiles.push(p);
  p=calibration(); p.scene[0].x=500; p.scene[0].y=970; profiles.push(p);
  for (const profile of profiles) {
    const result=invoke(['-CalibrationJson',JSON.stringify(profile),'-WindowHandle','42','-ReadTimer']);
    assert.equal(result.code,'calibration-invalid');
    assert.equal(result.capturedAtMs,0);
  }
});
test('script keeps timer and scene derived from one in-memory frame and strict digit consensus',()=>{
  const source=readFileSync(script,'utf8');
  assert.equal((source.match(/CopyFromScreen\(/g)||[]).length,1);
  assert.match(source,/\$crop=\$bitmap\.Clone/);
  assert.match(source,/\$timerBitmap=\$bitmap\.Clone/);
  assert.match(source,/\$original -ge 1 -and \$original -eq \$contrast/);
  assert.match(source,/\^\[0-9\]\{1,3\}\$/);
  assert.doesNotMatch(source,/SetForegroundWindow|SendKeys|mouse_event|keybd_event|\.Save\([^\n]*(?:File|Path)/);
});

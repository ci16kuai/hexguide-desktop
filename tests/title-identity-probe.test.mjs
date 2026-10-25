import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runTitleIdentityProbe, buildTitleProbeInput, summarizeTitleProbe, checkProbeExecutable, runBoundedProbeChild} from '../scripts/probe-title-identity.mjs';

const execute = promisify(execFile);
const opts = ['--allow-game-capture','--executable','H:/fixture-only/HexGuide.exe'];
const capture = () => ({capturedAt:1000,width:1920,height:1080,originX:0,originY:0,windowHandle:'42',
  regions:[0,1,2].map(column=>({column,x:100+column*500,y:300,width:400,height:550,signature:Array(192).fill(80)})),
  identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'synthetic-frame',pass:'card-titles-color',
    cards:[0,1,2].map(column=>({column,anchors:[{box:{x:150+column*500,y:420,width:120,height:30},feature:Array.from({length:128},(_,i)=>i%2?8:0)}]}))}});
const scan = () => ({status:'recognized',selectionMetadataStatus:'accepted',proposals:['fixture-left','fixture-middle','fixture-right'].map(id=>({id,name:'MUST-NOT-PRINT'})),selectionCapture:capture()});
const nativeSummary = () => ({mode:'read-only-game-title-probe',actualSelectionConfirmed:false,status:'completed',
  captures:8,allTitlesMatched:7,legacyRgbWouldReject:3,readyFrames:5,titleMaskCounts:[3,3,2],elapsedMs:8000,
  privateText:'MUST-NOT-PRINT',ids:['MUST-NOT-PRINT'],pixels:[1,2,3],geometry:{x:123}});
function harness(overrides={}) {
  const calls=[];
  const dependencies={
    now:()=>2000,token:()=> 'a'.repeat(32),
    validateExecutable:async()=>{calls.push('version');return true;},
    readCatalog:async()=>{calls.push('catalog');return {augments:[]};},
    scannerFactory:options=>{calls.push(['scanner-options',options]);return async()=>{calls.push('scan');return scan();};},
    runChild:async(executable,args,input)=>{calls.push(['child',args,input]);return {ok:true,data:args[0]==='--selection-self-test'?{mode:'offline-no-ui',titleProbeVersion:1}:nativeSummary()};},
    ...overrides,
  };
  return {calls,dependencies};
}

test('the probe closes its OCR worker on success, incomplete metadata and capture failure',async()=>{
  for (const captureScan of [async()=>scan(),async()=>({status:'waiting'}),async()=>{throw Error('Private');}]) {
    let closes=0;
    const scanner=Object.assign(captureScan,{close:async()=>{closes++;}});
    const h=harness({scannerFactory:()=>scanner});
    await runTitleIdentityProbe({argv:opts,dependencies:h.dependencies});
    assert.equal(closes,1);
  }
});

test('default and executable-only operation never inspect an executable, capture or spawn',async()=>{
  for(const argv of [[],['--executable','H:/fixture-only/HexGuide.exe']]) {
    const h=harness(); const result=await runTitleIdentityProbe({argv,dependencies:h.dependencies});
    assert.deepEqual(result,{status:'disabled',code:'explicit-game-capture-required'}); assert.deepEqual(h.calls,[]);
  }
});

test('the real CLI default remains disabled without any capture flag',async()=>{
  const script=fileURLToPath(new URL('../scripts/probe-title-identity.mjs',import.meta.url));
  const {stdout,stderr}=await execute(process.execPath,[script],{windowsHide:true,timeout:5000,maxBuffer:16384});
  assert.deepEqual(JSON.parse(stdout),{status:'disabled',code:'explicit-game-capture-required'}); assert.equal(stderr,'');
});

test('unsupported PE versions and same-version drafts without capability are blocked before scanner creation',async()=>{
  let h=harness({validateExecutable:async()=>false});
  assert.equal((await runTitleIdentityProbe({argv:opts,dependencies:h.dependencies})).code,'executable-version-unsupported');
  assert.deepEqual(h.calls,[]);
  h=harness({runChild:async()=>({ok:true,data:{mode:'offline-no-ui'}})});
  assert.equal((await runTitleIdentityProbe({argv:opts,dependencies:h.dependencies})).code,'title-probe-capability-missing');
  assert.deepEqual(h.calls,['version']);
});

test('missing, malformed or stale title metadata never spawns the observing flag',async()=>{
  for(const mutate of [s=>{delete s.selectionCapture;},s=>{delete s.selectionCapture.identityAnchors;},
    s=>{s.selectionMetadataStatus='missing';},s=>{s.proposals.pop();},s=>{s.proposals[1].id=s.proposals[0].id;},
    s=>{s.selectionCapture.identityAnchors.cards[0].anchors[0].feature.fill(0);},s=>{s.selectionCapture.capturedAt=4000;}]) {
    const s=scan(); mutate(s); const h=harness({scannerFactory:()=>async()=>s});
    assert.equal((await runTitleIdentityProbe({argv:opts,dependencies:h.dependencies})).code,'title-metadata-incomplete');
    const children=h.calls.filter(call=>Array.isArray(call)&&call[0]==='child');
    assert.equal(children.length,1); assert.deepEqual(children[0][1],['--selection-self-test']);
  }
});

test('the opt-in probe passes bounded metadata in RAM and emits only fixed codes and numeric counters',async()=>{
  const h=harness(); const result=await runTitleIdentityProbe({argv:opts,applicationDirectory:'H:/fixture-repo',dependencies:h.dependencies});
  assert.equal(result.status,'completed'); assert.equal(result.captures,8);
  assert.equal(result.stopReason,'completed'); assert.equal(result.code,'title-probe-complete');
  const options=h.calls.find(call=>Array.isArray(call)&&call[0]==='scanner-options')[1];
  assert.equal(options.applicationDirectory,'H:/fixture-repo'); assert.equal('dataDirectory' in options,false);
  const child=h.calls.find(call=>Array.isArray(call)&&call[0]==='child'&&call[1][0]==='--selection-title-observe');
  assert.ok(Buffer.byteLength(child[2])<=16384);
  const payload=JSON.parse(child[2]);
  assert.deepEqual(payload.ids,['fixture-left','fixture-middle','fixture-right']);
  assert.equal(payload.status,'armed'); assert.equal(payload.gameId,null); assert.equal(payload.offerToken,'a'.repeat(32));
  assert.equal('capturedAt' in payload.capture,false); assert.ok(payload.capture.identityAnchors);
  assert.equal(JSON.stringify(result).includes('MUST-NOT-PRINT'),false); assert.equal('ids' in result,false); assert.equal('geometry' in result,false);
});

test('native early stops preserve exact allowlisted reasons instead of reporting completion',async()=>{
  const reasons=['dpi-unavailable','game-unverified','game-not-foreground','game-not-visible','client-unavailable',
    'client-changed','region-too-large','occlusion-enumeration-incomplete','occlusion-bounds-unavailable',
    'occlusion-state-unavailable','card-occluded','capture-exception','invalid-input'];
  for(const status of reasons) {
    const h=harness({runChild:async(_executable,args)=>({ok:true,data:args[0]==='--selection-self-test'
      ? {mode:'offline-no-ui',titleProbeVersion:1} : {...nativeSummary(),status,captures:52,allTitlesMatched:52,legacyRgbWouldReject:39,readyFrames:51,elapsedMs:5304}})});
    const result=await runTitleIdentityProbe({argv:opts,dependencies:h.dependencies});
    assert.equal(result.status,'stopped');assert.equal(result.code,'title-probe-stopped');assert.equal(result.stopReason,status);
    assert.equal(result.captures,52);assert.equal(result.elapsedMs,5304);
  }
  const raw={...nativeSummary(),status:'invalid-input',captures:0,allTitlesMatched:0,legacyRgbWouldReject:0,readyFrames:0};
  delete raw.elapsedMs;
  assert.equal(summarizeTitleProbe(raw).elapsedMs,0);
});

test('unknown, missing or arbitrary native status text maps to probe-stopped without leaking data',async()=>{
  for(const status of [undefined,'MUST-NOT-PRINT player=private path=C:/private', 'occlusion-MUST-NOT-PRINT', {text:'MUST-NOT-PRINT'}]) {
    const raw={...nativeSummary(),status};
    assert.equal(summarizeTitleProbe(raw).stopReason,'probe-stopped');
    const h=harness({runChild:async(_executable,args)=>({ok:true,data:args[0]==='--selection-self-test'
      ? {mode:'offline-no-ui',titleProbeVersion:1} : raw})});
    const result=await runTitleIdentityProbe({argv:opts,dependencies:h.dependencies});
    assert.equal(result.status,'stopped');assert.equal(result.code,'title-probe-stopped');assert.equal(result.stopReason,'probe-stopped');
    assert.equal(JSON.stringify(result).includes('MUST-NOT-PRINT'),false);
  }
});

test('PE version check uses an escaped literal path in a hidden, bounded PowerShell child',async()=>{
  let called;
  assert.equal(await checkProbeExecutable("H:/test's folder/HexGuide.exe",{platform:'win32',executeVersion:async(...args)=>{called=args;return {stdout:'1.10.3.0'};}}),true);
  assert.equal(called[0],'powershell.exe'); assert.ok(called[1][3].includes("test''s folder"));
  assert.equal(called[2].windowsHide,true); assert.equal(called[2].timeout,5000); assert.equal(called[2].maxBuffer,1024);
  for(const stdout of ['1.10.2.99','0.0.0.0','secret path','1.10.3.0\nprivate'])
    assert.equal(await checkProbeExecutable('H:/fixture/HexGuide.exe',{platform:'win32',executeVersion:async()=>({stdout})}),false);
});

test('oversized input, native output and hanging fixture child are bounded without another process being touched',async()=>{
  let spawned=false;
  assert.equal((await runBoundedProbeChild('not-launched',[], 'x'.repeat(16385),{spawnChild:()=>{spawned=true;}})).code,'probe-input-too-large');
  assert.equal(spawned,false);
  const overflow=await runBoundedProbeChild(process.execPath,['-e','process.stdout.write("x".repeat(16385));setTimeout(()=>{},10000)']);
  assert.equal(overflow.code,'probe-output-too-large');
  const timeout=await runBoundedProbeChild(process.execPath,['-e','setTimeout(()=>{},10000)'],'',{timeoutMs:100});
  assert.equal(timeout.code,'probe-timeout');
});

test('summary validation rejects counter overflows, nonnumeric fields, excess arrays and actual-selection claims',()=>{
  assert.ok(summarizeTitleProbe(nativeSummary()));
  for(const mutate of [r=>{r.captures=101;},r=>{r.elapsedMs='private';},r=>{r.titleMaskCounts=Array(9).fill(1);},
    r=>{r.actualSelectionConfirmed=true;},r=>{r.mode='other-mode';}]) {
    const raw=nativeSummary();mutate(raw);assert.equal(summarizeTitleProbe(raw),null);
  }
  assert.equal(buildTitleProbeInput(scan(),{now:()=>40000}),null);
});

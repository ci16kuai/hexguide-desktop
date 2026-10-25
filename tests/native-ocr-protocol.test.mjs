import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../native/scan-augments.ps1',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/native-ocr-protocol.ps1',import.meta.url));
const canonical='{"version":1,"type":"scan","id":7}';

function nativeRecord(input,mode='request') {
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixture,'-Source',source,'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';
    const timer=setTimeout(()=>{ child.kill(); reject(new Error('Offline native protocol fixture timed out.')); },8000);
    child.stderr.resume();
    child.stdin.on('error',()=>{});
    child.on('error',error=>{ clearTimeout(timer); reject(error); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{ output+=chunk; });
    child.on('close',code=>{
      clearTimeout(timer);
      try { resolve({code,records:output.trim().replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>JSON.parse(line))}); }
      catch(error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

for(const [name,input] of [
  ['canonical request',canonical+'\n'],
  ['reordered fields',' { "id":7, "type":"scan", "version":1 }\r\n'],
  ['escaped canonical keys','{"\\u0076ersion":1,"type":"scan","id":7}\n'],
  ['exactly 1024 bytes',canonical+' '.repeat(1024-Buffer.byteLength(canonical))+'\n'],
]) test(`native control parser accepts ${name}`,{skip:process.platform!=='win32',timeout:10000},async()=>{
  const {code,records}=await nativeRecord(input);
  assert.equal(code,0);
  assert.deepEqual(records,[{accepted:true,version:1,type:'scan',id:7}]);
});

test('native control parser preserves the maximum safe integer id',{skip:process.platform!=='win32',timeout:10000},async()=>{
  const {code,records}=await nativeRecord('{"version":1,"type":"scan","id":9007199254740991}\n');
  assert.equal(code,0);
  assert.deepEqual(records,[{accepted:true,version:1,type:'scan',id:9007199254740991}]);
});

for(const [name,input] of [
  ['duplicate version','{"version":2,"version":1,"type":"scan","id":7}\n'],
  ['duplicate id','{"version":1,"type":"scan","id":8,"id":7}\n'],
  ['duplicate type','{"version":1,"type":"accept","type":"scan","id":7}\n'],
  ['escaped duplicate key','{"version":2,"\\u0076ersion":1,"type":"scan","id":7}\n'],
  ['wrong version','{"version":2,"type":"scan","id":7}\n'],
  ['string version','{"version":"1","type":"scan","id":7}\n'],
  ['fractional version','{"version":1.0,"type":"scan","id":7}\n'],
  ['non-string type','{"version":1,"type":7,"id":7}\n'],
  ['boolean id','{"version":1,"type":"scan","id":true}\n'],
  ['wrong key case','{"Version":1,"type":"scan","id":7}\n'],
  ['unsafe id','{"version":1,"type":"scan","id":9007199254740992}\n'],
  ['fractional id','{"version":1,"type":"scan","id":7.5}\n'],
  ['string id','{"version":1,"type":"scan","id":"7"}\n'],
  ['zero id','{"version":1,"type":"scan","id":0}\n'],
  ['extra property','{"version":1,"type":"scan","id":7,"path":"ignored"}\n'],
  ['malformed JSON','{"version":1,"type":"scan","id":7,}\n'],
  ['malformed number','{"version":1,"type":"scan","id":07}\n'],
  ['1025 bytes',canonical+' '.repeat(1025-Buffer.byteLength(canonical))+'\n'],
  ['partial line EOF',canonical],
  ['invalid UTF-8',Buffer.from([0xff,0x0a])],
]) test(`native control parser rejects ${name} before accepting a record`,{skip:process.platform!=='win32',timeout:10000},async()=>{
  const {code,records}=await nativeRecord(input);
  assert.equal(code,1);
  assert.deepEqual(records,[{accepted:false,poisoned:false}]);
});

for(const type of ['accept','continue']) test(`native stage accepts canonical ${type} acknowledgement`,{skip:process.platform!=='win32',timeout:10000},async()=>{
  const {code,records}=await nativeRecord(JSON.stringify({id:7,type,version:1})+'\n','ack');
  assert.equal(code,0); assert.equal(records.length,2);
  assert.equal(records[0].type,'stage'); assert.equal(records[0].stage,'color');
  assert.deepEqual(records[1],{accepted:true,decision:type==='accept',poisoned:false});
});

for(const [name,input] of [
  ['wrong acknowledgement id','{"version":1,"type":"accept","id":8}\n'],
  ['wrong acknowledgement type','{"version":1,"type":"scan","id":7}\n'],
  ['duplicate acknowledgement version','{"version":2,"version":1,"type":"accept","id":7}\n'],
  ['duplicate acknowledgement id','{"version":1,"type":"accept","id":8,"id":7}\n'],
  ['acknowledgement EOF',''],
]) test(`native stage poisons reuse on ${name}`,{skip:process.platform!=='win32',timeout:10000},async()=>{
  const {code,records}=await nativeRecord(input,'ack');
  assert.equal(code,1); assert.equal(records.length,2);
  assert.equal(records[0].type,'stage');
  assert.deepEqual(records[1],{accepted:false,poisoned:true});
});

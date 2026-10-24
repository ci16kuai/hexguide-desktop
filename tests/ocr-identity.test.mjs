import test from 'node:test';
import assert from 'node:assert/strict';
import {matchOcrProposals} from '../server/ocr.mjs';

// Contract fixtures only: these numeric descriptors are not game observations.
const catalog = ['钢化你心','灵魂虹吸','渴血','虹吸'].map((name,index)=>({id:`fixture-${index}`,name,availability:'current',recommendable:true}));
const algorithm = 'luma-sobel-16x8-v1';
const names = catalog.slice(0,3).map(row=>row.name);
const feature = () => Array.from({length:128},(_,index)=>index%2?8:0);
const boxFor = line => {
  const x = Math.max(line.crop.x,Math.floor(line.x)-2), y = Math.max(line.crop.y,Math.floor(line.y)-2);
  return {x,y,width:Math.min(line.crop.x+line.crop.width,Math.ceil(line.x+line.width)+2)-x,
    height:Math.min(line.crop.y+line.crop.height,Math.ceil(line.y+line.height)+2)-y};
};
function fixture({wrapped=false}={}) {
  const raw = {status:'recognized',frameId:'identity-contract-fixture',diagnostics:{width:1920,height:1080},lines:[],
    selectionCapture:{capturedAt:1000,width:1920,height:1080,originX:0,originY:0,windowHandle:'42',
      regions:[0,1,2].map(column=>({column,x:400+column*400,y:216,width:300,height:540,signature:Array(192).fill(80)}))},
    identityAnchors:{version:1,algorithm,frameId:'identity-contract-fixture',capturedAt:1000,anchors:[]}};
  for (let column=0;column<3;column++) for (const [row,text] of (wrapped&&column===1?['灵魂','虹吸']:[names[column]]).entries()) {
    const line = {text,frameId:raw.frameId,pass:'card-titles-color',region:'card-title',column,
      x:450+400*column,y:420+29*row,width:120,height:26,
      crop:{x:[326,729,1094][column],y:356,width:[500,461,500][column],height:173}};
    line.identityAnchorIndex=raw.identityAnchors.anchors.length;
    raw.identityAnchors.anchors.push({index:line.identityAnchorIndex,pass:line.pass,column,box:boxFor(line),
      feature:feature(),quality:{usable:true,contrast:80,edgePixels:512,activeCells:64}});
    raw.lines.push(line);
  }
  return raw;
}
const match = raw => matchOcrProposals(raw,catalog);
const recognizedOnly = raw => {
  const result=match(raw);
  assert.deepEqual(result.proposals.map(row=>row.name),names);
  assert.equal(result.status,'recognized');
  assert.equal('selectionCapture' in result,false);
  return result;
};

test('same-frame complete cropped titles bind three compact identity cards',()=>{
  const raw=fixture(), result=match(raw), identity=result.selectionCapture.identityAnchors;
  assert.equal(result.selectionMetadataStatus,'accepted');
  assert.deepEqual(identity,{version:1,algorithm,frameId:raw.frameId,pass:'card-titles-color',cards:[0,1,2].map(column=>({column,anchors:[{
    box:raw.identityAnchors.anchors[column].box,feature:feature()}]}))});
  assert.ok(Buffer.byteLength(JSON.stringify(identity))<=8192);
  assert.equal('quality' in identity.cards[0].anchors[0],false);
  assert.equal('text' in identity,false);
  raw.identityAnchors.anchors[0].feature[0]=5;
  assert.equal(identity.cards[0].anchors[0].feature[0],0,'the validated result must own its arrays');
});

test('complete two-line titles preserve both original line anchors',()=>{
  const result=match(fixture({wrapped:true}));
  assert.deepEqual(result.proposals.map(row=>row.name),names);
  assert.equal(result.selectionCapture.identityAnchors.cards[1].anchors.length,2);
  assert.deepEqual(result.selectionCapture.identityAnchors.cards[1].anchors.map(anchor=>anchor.box.y),[418,447]);
});

test('missing, malformed, blank or stale identity descriptors keep candidates but never automatic capture',()=>{
  for (const mutate of [
    raw=>{delete raw.identityAnchors;},
    raw=>{raw.identityAnchors.version=2;},
    raw=>{raw.identityAnchors.algorithm='unknown';},
    raw=>{raw.identityAnchors.capturedAt=999;},
    raw=>{raw.identityAnchors.frameId='other-frame';},
    raw=>{for(const line of raw.lines)line.frameId='other-frame';},
    raw=>{raw.identityAnchors.anchors[0].feature.pop();},
    raw=>{raw.identityAnchors.anchors[0].feature[0]=65;},
    raw=>{raw.identityAnchors.anchors[0].quality.edgePixels=513;},
    raw=>{const a=raw.identityAnchors.anchors[0];a.feature.fill(0);a.quality={usable:false,contrast:0,edgePixels:0,activeCells:0};},
    raw=>{const a=raw.identityAnchors.anchors[0];a.feature.fill(40);a.quality={usable:false,contrast:80,edgePixels:5120,activeCells:128};},
    raw=>{delete raw.lines[0].identityAnchorIndex;},
    raw=>{raw.identityAnchors.anchors[0].pass='card-titles-contrast';},
    raw=>{raw.identityAnchors.anchors[0].box.x++;},
    raw=>{raw.identityAnchors.anchors[0].privateText='must-not-retain';},
  ]) {const raw=fixture();mutate(raw);recognizedOnly(raw);}
});

test('dense nonuniform title edges are eligible while flat edge noise is rejected',()=>{
  const raw=fixture();
  for(const anchor of raw.identityAnchors.anchors){
    anchor.feature=Array.from({length:128},(_,index)=>index%2?60:20);
    anchor.quality={usable:true,contrast:80,edgePixels:5120,activeCells:128};
  }
  assert.equal(match(raw).selectionMetadataStatus,'accepted');
  for(const anchor of raw.identityAnchors.anchors){
    anchor.feature.fill(40);
    anchor.quality.usable=false;
  }
  recognizedOnly(raw);
});

test('the entire padded title anchor must fit its physical card ROI',()=>{
  const raw=fixture();raw.selectionCapture.regions[0].x=448;raw.selectionCapture.regions[0].width=123;
  const result=recognizedOnly(raw);
  assert.equal(result.selectionMetadataStatus,'shape-invalid');
});

test('a full-window reconstruction without cropped source anchors has no automatic identity',()=>{
  const raw=fixture();raw.lines=raw.lines.map(({region,crop,column,identityAnchorIndex,...line})=>({...line,pass:'full-window'}));
  recognizedOnly(raw);
});

test('a full-window alternative does not erase a valid independently cropped pass',()=>{
  const raw=fixture();raw.lines.push(...raw.lines.map(({region,crop,column,identityAnchorIndex,...line})=>({...line,pass:'full-window'})));
  assert.equal(match(raw).selectionMetadataStatus,'accepted');
});

test('matching one visual row of a larger OCR source line is insufficient identity coverage',()=>{
  const raw=fixture(), line=raw.lines[0];
  line.text+=' 说明';line.height=55;
  line.words=[{text:names[0],x:450,y:420,width:120,height:26},{text:'说明',x:450,y:449,width:120,height:26}];
  raw.identityAnchors.anchors[0].box=boxFor(line);
  recognizedOnly(raw);
});

test('raw identity limits reject extra anchors and repeated source-line references',()=>{
  for(const extra of [true,false]) {
    const raw=fixture();
    if(extra) for(let i=0;i<6;i++)raw.identityAnchors.anchors.push({...structuredClone(raw.identityAnchors.anchors[0]),index:raw.identityAnchors.anchors.length});
    else raw.lines.push(structuredClone(raw.lines[0]));
    recognizedOnly(raw);
  }
});

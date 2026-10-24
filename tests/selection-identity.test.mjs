import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionObserver,sanitizeSelectionCapture} from '../server/selection.mjs';

const feature = Array.from({length:128},(_,index)=>index%2?16:0);
function capture() {
  const regions=[0,1,2].map(column=>({column,x:200+column*400,y:200,width:300,height:550,signature:Array(192).fill(55)}));
  return {capturedAt:1000,width:1920,height:1080,originX:0,originY:0,windowHandle:'42',regions,
    identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'fixture-same-frame',pass:'card-titles-color',
      cards:regions.map(region=>({column:region.column,anchors:[{box:{x:region.x+30,y:350,width:180,height:24},feature:[...feature]}]}))}};
}

test('title identity survives the OCR-to-observer boundary and same-offer refresh',()=>{
  const input=capture(), safe=sanitizeSelectionCapture(input);
  assert.deepEqual(safe.identityAnchors,input.identityAnchors);
  safe.identityAnchors.cards[0].anchors[0].feature[0]=1;
  assert.equal(input.identityAnchors.cards[0].anchors[0].feature[0],0);
  const context={gameId:'fixture',gameEpoch:2,revision:3};
  const observer=new SelectionObserver({now:()=>2000});
  observer.arm({...context,offerToken:'a'.repeat(32),ids:['left','middle','right'],capture:input});
  assert.deepEqual(observer.get(context).capture.identityAnchors,input.identityAnchors);
  const next=capture(); next.capturedAt=1300; next.identityAnchors.frameId='new-independent-frame';
  observer.arm({...context,offerToken:'a'.repeat(32),ids:['left','middle','right'],capture:next});
  assert.equal(observer.get(context).capture.identityAnchors.frameId,'new-independent-frame');
  assert.equal(observer.getResultLease(context).capture.identityAnchors.frameId,'new-independent-frame');
});

test('malformed, uninformative or misplaced title anchors cannot become an automatic observation',()=>{
  const changes=[
    value=>value.identityAnchors.cards.pop(),
    value=>value.identityAnchors.algorithm='unknown',
    value=>value.identityAnchors.pass='full-window',
    value=>value.identityAnchors.cards[0].column=1,
    value=>value.identityAnchors.cards[0].anchors[0].box.x=0,
    value=>value.identityAnchors.cards[0].anchors[0].box.width=7,
    value=>value.identityAnchors.cards[0].anchors[0].feature.fill(32),
    value=>value.identityAnchors.cards[0].anchors[0].feature[2]=65,
    value=>delete value.identityAnchors.cards[0].anchors[0].feature[2],
    value=>value.identityAnchors.cards[0].anchors.push(...value.identityAnchors.cards[0].anchors,...value.identityAnchors.cards[0].anchors),
    value=>value.identityAnchors.cards[0].anchors[0].text='untrusted text',
  ];
  for(const change of changes) {const input=capture(); change(input); assert.equal(sanitizeSelectionCapture(input),null);}
  const raw=capture(); delete raw.identityAnchors;
  assert.ok(sanitizeSelectionCapture(raw),'pre-OCR geometry-only sanitation remains available');
});

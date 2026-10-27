import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {BackgroundSidebar} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
const itemsCatalog = JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));

const ids=['recursion','shrink_engine','jeweled_gauntlet'];
const capture=capturedAt=>({capturedAt,width:1920,height:1080,originX:0,originY:0,windowHandle:'42',
  regions:[0,1,2].map(column=>({column,x:400+column*400,y:200,width:300,height:550,signature:Array(192).fill(80)})),
  identityAnchors:{version:1,algorithm:'luma-sobel-16x8-v1',frameId:'delivery-fixture',pass:'card-titles-color',
    cards:[0,1,2].map(column=>({column,anchors:[{box:{x:430+column*400,y:350,width:180,height:24},
      feature:Array.from({length:128},(_,index)=>index%2?16:0)}]}))}});

function fixture({allowPlan=false}={}) {
  let now = Date.parse('2026-10-26T01:00:00Z');
  let live = {connection:{status:'connected'},phase:'InProgress',stage:'live',gameId:'delivery-fixture',
    championId:'Ahri',mode:{known:true,isMayhem:true},gameTime:20,life:{status:'detected',isDead:false},
    observedAt:new Date(now).toISOString(),items:[],stats:{}};
  let rankingReads=0;
  const sidebar = new BackgroundSidebar({collector:{getSnapshot:()=>structuredClone(live)},data,itemsCatalog,now:()=>now,
    recommendationRepository:{get(){rankingReads++;if(!allowPlan)throw new Error('Recognition must not build recommendations');return null;},ensure:async()=>{},close:async()=>{}},
    scanner:async()=>({status:'waiting',code:'title-name-unmatched',proposals:[]})});
  return {sidebar,reads:()=>rankingReads,time:()=>now,
    advance(ms,patch={}) {now+=ms;live={...live,...patch,observedAt:new Date(now).toISOString()};},
    patch(value) {live={...live,...value};}};
}

test('frequent recognition delivery carries complete guards without rebuilding a plan',async t=>{
  const h=fixture();t.after(()=>h.sidebar.stop());
  const initial=h.sidebar.getRecognitionModel();
  assert.equal(initial.screenObservationScope.eligible,true);
  assert.equal(Date.parse(initial.updatedAt),initial.recognitionAt,'the screen-life controller must receive the original fresh API timestamp');
  assert.equal(initial.life.status,'detected');
  assert.equal(initial.connection.status,'connected');
  assert.deepEqual(Object.keys(initial.screenObservationScope).sort(),
    ['version','eligible','gameId','gameEpoch','revision','lifecycle','captureRevision','notBefore'].sort());
  for(let i=0;i<20;i++) {
    h.advance(150);
    const value=h.sidebar.getRecognitionModel();
    assert.equal(value.screenObservationScope.lifecycle,initial.screenObservationScope.lifecycle);
    assert.equal(value.screenObservationScope.notBefore,initial.screenObservationScope.notBefore);
    for(const key of ['plan','teams','items','champion','owned','offers']) assert.equal(key in value,false);
  }
  assert.equal(h.reads(),0);
});

test('post-click empty OCR preserves the same early-observation scope and released-click continuation',async t=>{
  const h=fixture();t.after(()=>h.sidebar.stop());
  h.sidebar.getRecognitionModel();h.advance(1);
  h.sidebar.scanner=async()=>({status:'recognized',proposals:ids.map(id=>({id})),selectionCapture:capture(h.time())});
  await h.sidebar.scan();
  const before=h.sidebar.getRecognitionModel();
  assert.equal(before.selection.status,'armed');
  h.advance(150);
  h.sidebar.scanner=async()=>({status:'recognized',code:'ocr-no-text',proposals:[]});
  await h.sidebar.scan();
  const after=h.sidebar.getRecognitionModel();
  assert.equal(after.selection.status,'waiting');assert.equal(after.selectionResult.status,'leased');
  assert.deepEqual(after.screenObservationScope,before.screenObservationScope,
    'soft card dismissal must not clear the buffered real click before its independent proof completes');
  h.sidebar.selectionObserver.invalidate();
  assert.ok(h.sidebar.getRecognitionModel().screenObservationScope.notBefore>before.screenObservationScope.notBefore,
    'a true invalidation must revoke every early frame');
});

test('click and panel sources racing for one offer commit exactly one choice',async t=>{
  const h=fixture({allowPlan:true});t.after(()=>h.sidebar.stop());
  h.sidebar.getRecognitionModel();h.advance(1);
  h.sidebar.scanner=async()=>({status:'recognized',proposals:ids.map(id=>({id})),selectionCapture:capture(h.time())});
  await h.sidebar.scan();
  const model=h.sidebar.getRecognitionModel(), offer=model.selection, panel=model.panelSelection;
  h.advance(700);
  const clicked={provider:'screen',offerToken:offer.offerToken,gameId:offer.gameId,gameEpoch:offer.gameEpoch,
    revision:offer.revision,ids:offer.ids,selectedIndex:0,capturedAt:offer.capturedAt,
    clickedAt:offer.capturedAt+100,observedAt:offer.capturedAt+500,
    evidence:{click:true,uniqueFeedback:true,cardsDismissed:true,stableFrames:3,feedbackFrames:1}};
  const icon={version:2,provider:'panel-icon',offerToken:panel.offerToken,gameId:panel.gameId,gameEpoch:panel.gameEpoch,
    revision:panel.revision,ids:panel.ids,glyphs:glyphProof(panel.offers,panel.owned),
    frames:[0,1,2].map(index=>({captureId:`race-${index}`,capturedAt:h.time()-500+index*250,panelVisible:true,
      gameSurfaceVerified:true,selectionUiVisible:false,geometryKey:'delivery-1920x1080',
      slots:Array.from({length:6},(_,slotIndex)=>({slotIndex,state:slotIndex?'empty':'candidate',candidateIndices:slotIndex?[]:[0]}))}))};
  const results=await Promise.allSettled([h.sidebar.observeSelectionEvidence(clicked),h.sidebar.observePanelEvidence(icon)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.deepEqual(h.sidebar.getSession().owned,[ids[0]]);
  assert.equal(h.sidebar.getSession().revision,offer.revision+1);
});

test('recognition scope immediately revokes early frames at death, respawn and capture eligibility loss',async t=>{
  const h=fixture();t.after(()=>h.sidebar.stop());
  const first=h.sidebar.getRecognitionModel().screenObservationScope;
  h.advance(150,{life:{status:'detected',isDead:true}});
  const dead=h.sidebar.getRecognitionModel().screenObservationScope;
  assert.equal(dead.eligible,false);assert.ok(dead.lifecycle>first.lifecycle);
  h.advance(150,{life:{status:'detected',isDead:false}});
  const alive=h.sidebar.getRecognitionModel().screenObservationScope;
  assert.equal(alive.eligible,true);assert.ok(alive.lifecycle>dead.lifecycle);
  h.advance(150,{connection:{status:'disconnected'}});
  const disconnected=h.sidebar.getRecognitionModel().screenObservationScope;
  assert.equal(disconnected.eligible,false);assert.ok(disconnected.captureRevision>alive.captureRevision);
  h.advance(150,{connection:{status:'connected'}});
  const recovered=h.sidebar.getRecognitionModel().screenObservationScope;
  assert.equal(recovered.eligible,true);
  assert.ok(recovered.notBefore>alive.notBefore);
  assert.equal(recovered.captureRevision,disconnected.captureRevision);
});

test('stale snapshots and pause cannot keep early screen capture eligible',async t=>{
  const h=fixture();t.after(()=>h.sidebar.stop());
  const initial=h.sidebar.getRecognitionModel();
  h.advance(11000,{observedAt:initial.recognitionAt});
  h.patch({observedAt:new Date(initial.recognitionAt).toISOString()});
  assert.equal(h.sidebar.getRecognitionModel().screenObservationScope.eligible,false);
  h.advance(1);
  h.sidebar.ocr.enabled=false;
  assert.equal(h.sidebar.getRecognitionModel().screenObservationScope.eligible,false);
});

test('lightweight recognition endpoint preserves authentication and rejects write requests',async t=>{
  const h=fixture();t.after(()=>h.sidebar.stop());
  const local=await createLocalServer({collector:{getSnapshot:()=>({})},sidebar:h.sidebar,
    staticDirectory:fileURLToPath(new URL('../dist',import.meta.url)),token:'recognition-fixture-token'});
  t.after(()=>local.close());
  const request=(method='GET',headers={},path='/api/recognition')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:local.port,path,method,headers},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',part=>raw+=part);
      res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));
    });req.on('error',reject);req.end();
  });
  assert.equal((await request()).status,401);
  assert.equal((await request('GET',{'x-hexguide-session':'wrong'})).status,401);
  const headers={'x-hexguide-session':'recognition-fixture-token'};
  assert.equal((await request('GET',{...headers,Origin:'https://foreign.example'})).status,403);
  assert.equal((await request('POST',headers)).status,405);
  const value=await request('GET',headers);
  assert.equal(value.status,200);assert.equal(value.body.screenObservationScope.eligible,true);
  assert.equal(h.reads(),0);
  assert.equal((await request('GET',headers,'/api/sidebar')).status,503,
    'a failed full recommendation view must not crash the recognition server');
  assert.equal((await request('GET',headers)).status,200);
  assert.equal(h.reads(),1,'recognition must remain independent after full-view rendering fails');
});

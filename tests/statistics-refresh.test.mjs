import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const functions=app.slice(app.indexOf('function applyRankingStatistics('),app.indexOf('function toast('));
const snapshot=revision=>({schemaVersion:1,meta:{mode:'aram-mayhem',cohortId:revision},champions:[]});
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

function harness({token='local-token'}={}){
  let revision='one',current=snapshot(revision),fail=false,statusOk=true,snapshotGate;
  const requests=[],applied=[],timers=new Map(),listeners=new Map(),windowListeners=new Map();
  let id=0,renders=0;
  const context=vm.createContext({
    statisticsSnapshot:null,statisticsRevision:null,statisticsRefreshPending:false,statisticsRefreshTimer:null,statisticsRefreshClosed:false,
    statisticsIndexes:new Map([['Ahri',{cached:true}]]),
    statisticsView:{replaceSnapshot:value=>applied.push(value)},renderKeepingFocus:()=>{renders++;},
    sessionStorage:{getItem:()=>token},
    document:{visibilityState:'visible',addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)},
    window:{addEventListener:(type,fn)=>windowListeners.set(type,fn)},
    setTimeout:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimeout:value=>timers.delete(value),
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(fail)throw Error('offline');
      if(url==='/api/statistics/status')return {ok:statusOk,json:async()=>({revision})};
      assert.equal(url,'./statistics.json');
      const value=current;
      if(snapshotGate)await snapshotGate;
      return {ok:true,json:async()=>value};
    }
  });
  vm.runInContext(functions,context);
  return {context,requests,applied,timers,listeners,windowListeners,
    current:()=>context.statisticsSnapshot,revision:()=>context.statisticsRevision,renders:()=>renders,
    replace(value){revision=value;current=snapshot(value);},invalid(){revision='invalid';current={schemaVersion:99};},
    fail(value){fail=value;},statusOk(value){statusOk=value;},gate(value){snapshotGate=value;},
    load:()=>context.loadRankingStatistics(),refresh:()=>context.refreshRankingStatistics(),start:()=>context.startStatisticsRefresh(),
    async visible(state='visible'){context.document.visibilityState=state;listeners.get('visibilitychange')?.();await settle();},
    close(){windowListeners.get('pagehide')?.();}
  };
}

test('initial statistics fetch records its revision and unchanged status never downloads the complete snapshot again',async()=>{
  const h=harness();
  await h.load();
  assert.equal(h.current().meta.cohortId,'one');
  assert.equal(h.revision(),'one');
  assert.equal(h.context.statisticsIndexes.size,0);
  assert.equal(h.applied.length,1);
  await h.refresh();await h.refresh();
  assert.equal(h.requests.filter(row=>row.url==='./statistics.json').length,1);
  for(const request of h.requests.filter(row=>row.url.startsWith('/api/'))){
    assert.equal(request.options.headers['X-Hexguide-Session'],'local-token');
    assert.equal(request.options.cache,'no-store');
  }
  h.replace('two');await h.refresh();
  assert.equal(h.current().meta.cohortId,'two');
  assert.equal(h.revision(),'two');
  assert.equal(h.applied.length,2);
  assert.equal(h.requests.filter(row=>row.url==='./statistics.json').length,2);
});

test('static browsing performs its initial fetch without authenticated status polls or timers',async()=>{
  const h=harness({token:null});
  await h.load();h.start();await h.refresh();await settle();
  assert.deepEqual(h.requests.map(row=>row.url),['./statistics.json']);
  assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});

test('ten-minute ticks and becoming visible check revisions; hidden events and pagehide do not restart polling',async()=>{
  const h=harness();await h.load();h.start();await settle();
  assert.equal(h.timers.size,1);
  const timer=[...h.timers.values()][0];assert.equal(timer.delay,10*60*1000);
  h.replace('two');await timer.fn();assert.equal(h.current().meta.cohortId,'two');
  const count=h.requests.length;
  await h.visible('hidden');assert.equal(h.requests.length,count);
  h.replace('three');await h.visible();assert.equal(h.current().meta.cohortId,'three');
  h.close();const stoppedCount=h.requests.length;
  assert.equal(h.listeners.has('visibilitychange'),false);
  await h.refresh();assert.equal(h.requests.length,stoppedCount);
});

test('failed and malformed updates retain good ranking and view data and remain eligible for retry',async()=>{
  const h=harness();await h.load();
  const accepted=h.current();
  h.replace('two');h.fail(true);await h.refresh();
  assert.strictEqual(h.current(),accepted);assert.equal(h.revision(),'one');
  h.fail(false);h.statusOk(false);await h.refresh();
  assert.strictEqual(h.current(),accepted);
  h.statusOk(true);h.invalid();await h.refresh();
  assert.strictEqual(h.current(),accepted);assert.equal(h.applied.length,1);assert.equal(h.revision(),'one');
  h.replace('three');await h.refresh();
  assert.equal(h.current().meta.cohortId,'three');assert.equal(h.applied.length,2);
});

test('overlapping visibility checks share one snapshot request and closing discards an in-flight update',async()=>{
  const h=harness();await h.load();h.start();await settle();
  let release;h.gate(new Promise(resolve=>{release=resolve;}));h.replace('two');
  const first=h.refresh();await settle();await h.refresh();
  assert.equal(h.requests.filter(row=>row.url==='./statistics.json').length,2);
  h.close();release();await first;
  assert.equal(h.current().meta.cohortId,'one');assert.equal(h.revision(),'one');
  assert.equal(h.applied.length,1);
});

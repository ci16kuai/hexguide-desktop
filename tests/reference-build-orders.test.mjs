import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReferenceBuildOrders, validateReferenceBuildOrders, hasUsableReferenceBuildOrder} from '../server/reference-build-orders.mjs';
import {validateReferenceBuildSnapshot} from '../server/recommendation-repository.mjs';
import {coreRow, coreTable, rightChevron} from './fixtures/reference-build-orders.mjs';

const NOW = Date.parse('2026-10-27T09:00:00Z');
const parse = (html = coreTable(), rows = [coreRow()], patch = '16.21') => parseReferenceBuildOrders({html, rows, patch});
const ordered = () => parse();
function snapshot(mode = 'aram', buildOrders = ordered()) {
  return {mode, championId:'Ahri', sourceChampionId:103, patch:'16.21', comparable:true, source:'OP.GG',
    sourceUrl:`https://op.gg/lol/${mode === 'aram' ? 'modes/aram' : 'champions'}/ahri/items?patch=16.21${mode === 'aram' ? '' : '&type=ranked'}`,
    observedAt:new Date(NOW).toISOString(), items:[{id:6655, sampleCount:10000, winRate:.51, scope:'single-item'}],
    ordersContractVersion:1, buildOrders};
}
const validate = value => validateReferenceBuildSnapshot(value, {championId:'Ahri', patch:'16.21', now:NOW});

test('visible directional arrows and JSON metadata preserve the core sequence and whole-build rates', () => {
  assert.deepEqual(ordered(), [{items:['6655','4646','4645'], sampleCount:3053, winRate:49.1320013101867 / 100,
    orderKind:'core-item-sequence', pickRate:.1576}]);
  const reversed = coreRow([4645,4646,6655]);
  assert.deepEqual(parse(coreTable([reversed]), [reversed])[0].items, ['4645','4646','6655']);
  assert.deepEqual(parse(coreTable() + coreTable([coreRow([3020,3006,3111])], {title:'Boots'})), ordered(),
    'other sections reuse the generic caption but cannot provide core-order proof');
  assert.equal(hasUsableReferenceBuildOrder({buildOrders:ordered()}), true);
  assert.equal(hasUsableReferenceBuildOrder({buildOrders:[{...ordered()[0],sampleCount:199}]}), false);
  assert.equal(hasUsableReferenceBuildOrder({buildOrders:[{...ordered()[0],sampleCount:200}]}), true);
});

test('mixed three- and four-entry source rows preserve verified triples without truncating component routes', () => {
  const four=coreRow([3070,3084,3121,2502],{play:'296',pick_rate:3.13,win_rate:47.2972972973});
  const three=coreRow([3121,3190,3050],{play:'827',pick_rate:8.74,win_rate:52.2370012092});
  for(const rows of [[three,four],[four,three]]) {
    const accepted=parse(coreTable(rows),rows);
    assert.equal(accepted.length,1);assert.deepEqual(accepted[0].items,['3121','3190','3050']);
    assert.equal(accepted[0].sampleCount,827);
  }
  assert.deepEqual(parse(coreTable([four]),[four]),[],'an all-four-entry table provides no supported triple');
  assert.deepEqual(parse(coreTable([three,four]).replace('/3070.png','/1001.png'),[three,four]),[],
    'even skipped four-entry rows must match the independent visible proof');
  const corrupted=structuredClone(three);corrupted.metaBuildItems[0].id=1001;
  assert.deepEqual(parse(coreTable([three,four]),[corrupted,four]),[],'a corrupt supported triple still fails closed');
});

test('unordered bundles, absent/wrong arrows, duplicate sections and mismatched visual identities do not become orders', () => {
  for (const html of ['', coreTable([], {}), coreTable(undefined,{arrow:''}), coreTable(undefined,{arrow:'+'}),
    coreTable(undefined,{arrow:rightChevron.replace('M13.2','M0')}), coreTable(undefined,{title:'Starter items'}),
    coreTable() + coreTable(), coreTable(undefined,{patch:'16.20'}),
    coreTable().replace('/6655.png','/1001.png'), coreTable().replace('3,053 Games','3,054 Games'),
    coreTable().replace('49.13%','49.14%'), coreTable().replace('15.76%','15.77%'),
    coreTable().replace('opgg-static.akamaized.net','example.com'), `<script>${coreTable()}</script>`]) {
    assert.deepEqual(parse(html), [], html.slice(0,80));
  }
  const reversed = coreRow([4645,4646,6655]);
  assert.deepEqual(parse(coreTable(), [reversed]), []);
});

test('malformed or excessive raw order tables fail closed without executing markup', () => {
  for (const change of [row=>row.ids.push(3006), row=>row.ids[0]=0, row=>row.ids[0]='6655',
    row=>row.metaBuildItems.reverse(), row=>row.metaBuildItems.pop(), row=>row.metaBuildItems[0].id=3006,
    row=>row.play='3.1K', row=>row.play='0', row=>row.play='3,05', row=>row.play=3053,
    row=>row.win_rate=101, row=>row.win_rate='49.13', row=>row.pick_rate=-1, row=>row.pick_rate='15.76']) {
    const row=coreRow(); change(row); assert.deepEqual(parse(coreTable(), [row]), []);
  }
  assert.deepEqual(parse('x'.repeat(4*1024*1024+1)), []);
  assert.deepEqual(parse(coreTable(), Array.from({length:101},()=>coreRow())), []);
  assert.deepEqual(parse(coreTable(), [coreRow()], '16.21&token=bad'), []);
  const html=`<script>globalThis.__orderExecuted = true;</script>${coreTable()}`;
  assert.equal(parse(html).length,1); assert.equal(globalThis.__orderExecuted,undefined);
});

test('normalized rows are strictly bounded, unique ordered triples with probabilities and whitelisted fields', () => {
  const row=ordered()[0]; row.player='not retained';
  assert.equal(validateReferenceBuildOrders([row])[0].player,undefined);
  for(const change of [value=>value.items=[6655,4646,4645], value=>value.items=['6655','6655','4645'],
    value=>value.items=['6655','4646'], value=>value.items=['0','4646','4645'], value=>value.items[0]='1e4',
    value=>value.sampleCount=0, value=>value.sampleCount=1.5, value=>value.sampleCount='1000',
    value=>value.winRate=NaN, value=>value.winRate=1.1, value=>value.winRate='0.5',
    value=>value.pickRate=-.1, value=>value.orderKind='item-set']) {
    const value=structuredClone(row);change(value);assert.throws(()=>validateReferenceBuildOrders([value]),{code:'invalid-data'});
  }
  for(const rows of [null,{},[row,row],Array.from({length:101},()=>row)]) assert.throws(()=>validateReferenceBuildOrders(rows),{code:'invalid-data'});
});

test('repository order projection retains independent rates and permits only one correctly scoped fallback', () => {
  const primary=snapshot('aram',[]); primary.orderFallback=snapshot('summoners-rift');
  primary.orderFallback.observedAt=new Date(NOW-60000).toISOString();
  const result=validate(primary);
  assert.deepEqual(result.items,primary.items); assert.equal(result.buildOrders.length,0);
  assert.deepEqual(result.orderFallback.buildOrders,ordered()); assert.equal(result.orderFallback.items[0].winRate,.51);
  assert.equal(result.orderFallback.observedAt,new Date(NOW-60000).toISOString());
  assert.ok(Object.isFrozen(result.orderFallback.buildOrders[0].items));
  const low=snapshot('aram',[{...ordered()[0],sampleCount:199}]);low.orderFallback=snapshot('summoners-rift');
  assert.ok(validate(low).orderFallback);
  for(const change of [value=>value.orderFallback.championId='Jinx',value=>value.orderFallback.patch='16.20',
    value=>value.orderFallback.sourceChampionId=222,value=>value.orderFallback.mode='aram',
    value=>value.orderFallback.source='another', value=>value.orderFallback.sourceUrl='https://op.gg/lol/champions/jinx/items?patch=16.21&type=ranked',
    value=>value.orderFallback.observedAt=new Date(NOW+6*60000).toISOString(),value=>value.orderFallback.ordersContractVersion=2,
    value=>value.orderFallback.buildOrders=[],value=>value.orderFallback.buildOrders[0].sampleCount=199,
    value=>value.orderFallback.orderFallback=snapshot('summoners-rift'),value=>value.buildOrders=ordered(),
    value=>value.ordersContractVersion=2,value=>value.orderFallback=null,value=>value.extra='x'.repeat(256*1024)]) {
    const value=structuredClone(primary);change(value);assert.throws(()=>validate(value));
  }
  const legacy=snapshot();delete legacy.buildOrders;delete legacy.ordersContractVersion;
  assert.equal(validate(legacy).ordersContractVersion,undefined,'old item caches remain readable');
});

test('partial order failures remain bounded, sanitized and incompatible with a successful order result', () => {
  for(const mode of ['aram','summoners-rift']) {
    const raw=snapshot(mode,[]);raw.orderFetchFailure={code:'timeout',retryAt:NOW+60000,private:'discard'};
    assert.deepEqual(validate(raw).orderFetchFailure,{code:'timeout',retryAt:NOW+60000});
    for(const change of [value=>value.orderFetchFailure.code='private error',value=>value.orderFetchFailure.retryAt=NOW+31*60000,
      value=>value.orderFetchFailure.retryAt=String(NOW),value=>value.orderFetchFailure.retryAt=0,
      value=>value.orderFetchFailure=null,value=>value.buildOrders=ordered(),
      value=>value.orderFallback=snapshot('summoners-rift')]) {
      const value=structuredClone(raw);change(value);assert.throws(()=>validate(value));
    }
  }
});

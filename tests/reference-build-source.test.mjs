import test from 'node:test';
import assert from 'node:assert/strict';
import {createReferenceBuildSource} from '../server/reference-build-source.mjs';

const NOW = Date.parse('2026-10-25T04:10:00.000Z');
const request = {championId:'Ahri', championSlug:'ahri', patch:'16.21'};
const item = (id = 6655, extra = {}) => ({ids:[id], pick_rate:70.77, play:'19,728', win_rate:51.769059205190594,
  metaItem:{id, name:'Fixture item'}, ...extra});
const el = (tag, children, extra = {}) => ['$', tag, null, {children, ...extra}];
const section = (title, rows, mode) => el('section', [el('div', el('div', title)),
  el('div', ['$', '$L66', null, {data:rows, mode}])]);
function roots({mode = 'aram', patch = '16.21', slug = 'ahri', sourceId = 103,
  rows = [item()], boots = [item(3020, {play:'20,724', pick_rate:89.54, win_rate:51.38004246284501})],
  extraSections = [], label = 'Items'} = {}) {
  if (mode === 'aram') return [
    ['$', '$Ltracking', null, {main:'modes', sub:'aram', detail:'items', params:{game_region:'global', game_patch_version:patch}}],
    ['$', '$Lheader', null, {championName:slug, type:'aram'}],
    ['$', '$Lfilter', null, {query:{patch, region:'global', tier:'all'}, pathParams:{mode:'aram', slug:[slug, 'items']}}],
    ['$', '$Ldirectory', null, {type:'aram', query:'$filter:props:query', champions:[{key:slug, id:sourceId}]}],
    section(label, rows, 'aram'), ...(boots ? [section('Boots', boots, 'aram')] : []), ...extraSections,
  ];
  return [
    ['$', '$Ltracking', null, {main:'champions', sub:'ranked', detail:'items',
      params:{game_region:'global', game_tier:'emerald_plus', game_patch_version:patch, type:'ranked', champion_name:'Ahri'}}],
    ['$', '$Lheader', null, {championName:slug}],
    ['$', '$Lnavigation', null, {data:{href:{pathname:`/champions/${slug}/build/mid`, query:{patch, type:'ranked'}}}}],
    ['$', '$Lpro', null, {data:{key:'pro-build', href:`https://esports.op.gg/champions/${sourceId}`}}],
    section(label, rows, 'ranked'), ...(boots ? [section('Boots', boots, 'ranked')] : []), ...extraSections,
  ];
}
function html(options, transform = value => value) {
  const records = transform(roots(options)).map((value, index) => `${(index + 16).toString(16)}:${JSON.stringify(value)}\n`).join('');
  return `<html><body><script>self.__next_f.push(${JSON.stringify([1, records])})</script></body></html>`;
}
const response = (page, extra = {}) => ({ok:true, status:200,
  headers:{get:name => name === 'content-type' ? 'text/html; charset=utf-8' : null}, text:async () => page, ...extra});
function source(fetcher, now = () => NOW) { return createReferenceBuildSource({fetcher, now}); }

test('ARAM item and boot rates remain true single-item scopes, with no request for ranked', async () => {
  const calls = [];
  const result = await source(async (url, options) => { calls.push({url, options}); return response(html()); }).load(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://op.gg/lol/modes/aram/ahri/items?patch=16.21');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.ok(!Object.keys(calls[0].options.headers).some(name => /authorization|cookie/i.test(name)));
  assert.equal(result.mode, 'aram');
  assert.equal(result.patch, '16.21');
  assert.equal(result.championId, 'Ahri');
  assert.equal(result.sourceChampionId, 103);
  assert.equal(result.observedAt, new Date(NOW).toISOString());
  assert.equal(result.source, 'OP.GG');
  assert.equal(result.comparable, true);
  assert.equal(result.tier, 'all');
  assert.equal(result.items[0].id, 6655);
  assert.equal(result.items[0].sampleCount, 19728);
  assert.equal(result.items[0].winRate, 51.769059205190594 / 100);
  assert.equal(result.items[0].pickRate, .7077);
  assert.equal(result.items[0].scope, 'single-item');
  assert.equal(result.items[1].scope, 'boots');
  assert.match(result.attribution, /OP.GG/);
});

test('ranked SR is tried only after unavailable ARAM and retains its actual scope', async () => {
  const calls = [];
  const result = await source(async url => {
    calls.push(url);
    return calls.length === 1 ? {ok:false, status:404} : response(html({mode:'summoners-rift'}));
  }).load(request);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'https://op.gg/lol/champions/ahri/items?patch=16.21&type=ranked');
  assert.equal(result.mode, 'summoners-rift');
  assert.equal(result.region, 'global');
  assert.equal(result.tier, 'emerald_plus');
  assert.equal(result.position, 'mid');
  assert.equal(result.items[0].scope, 'single-item');
});

test('old or wrong-mode ARAM data is unavailable, never relabelled as requested', async () => {
  for (const page of [html({patch:'16.20'}), html({mode:'summoners-rift'})]) {
    let calls = 0;
    const result = await source(async () => ++calls === 1 ? response(page) : {ok:false, status:404}).load(request);
    assert.equal(result, null);
    assert.equal(calls, 2);
  }
});

test('wrong champion, missing independent version proof or a stale filter is rejected', async () => {
  const pages = [
    html({slug:'jinx'}),
    html({}, rows => rows.filter((_, index) => index !== 0)),
    html({}, rows => { rows[2][3].query.patch = '16.20'; return rows; }),
    html({}, rows => { rows[0][3].params.game_patch_version = '16.20'; return rows; }),
  ];
  for (const page of pages) {
    let calls = 0;
    assert.equal(await source(async () => ++calls === 1 ? response(page) : {ok:false, status:404}).load(request), null);
  }
});

test('numeric hero requests require an explicit source identity match in both modes', async () => {
  const numericRequest = {...request, championId:103};
  assert.equal((await source(async () => response(html())).load(numericRequest)).championId, '103');
  for (const mode of ['aram', 'summoners-rift']) {
    let calls = 0;
    const result = await source(async () => {
      calls++;
      if (mode !== 'aram' && calls === 1) return {ok:false, status:404};
      if (calls === 1 || mode !== 'aram') return response(html({mode, sourceId:222}));
      return {ok:false, status:404};
    }).load(numericRequest);
    assert.equal(result, null);
  }
});

test('Riot champion IDs use observed lowercased keys, including monkeyking', async () => {
  const calls = [];
  const result = await source(async url => { calls.push(url); return response(html({slug:'monkeyking', sourceId:62})); })
    .load({championId:'MonkeyKing', patch:'16.21'});
  assert.match(calls[0], /\/monkeyking\/items/);
  assert.equal(result.sourceChampionId, 62);
  let called = false;
  assert.equal(await source(async () => { called = true; }).load({championId:'MonkeyKing', championSlug:'wukong', patch:'16.21'}), null);
  assert.equal(called, false);
});

test('a core build or starter bundle is never split into fake single-item rates', async () => {
  const core = {ids:[6655, 4646, 4645], play:'3,053', pick_rate:15.76, win_rate:49.1320013101867,
    metaBuildItems:[{id:6655}, {id:4646}, {id:4645}]};
  for (const page of [html({rows:[core]}), html({label:'Core builds', rows:[core], boots:null})]) {
    let calls = 0;
    assert.equal(await source(async () => ++calls === 1 ? response(page) : {ok:false, status:404}).load(request), null);
  }
  const result = await source(async () => response(html({extraSections:[section('Core builds', [core], 'aram')]}))).load(request);
  assert.deepEqual(result.items.map(row => row.id), [6655, 3020]);
  assert.ok(!result.items.some(row => row.id === 4645));
});

test('malformed counts, rates, IDs, duplicates and incompatible item sections fail closed', async () => {
  const invalid = [
    html({rows:[item(6655, {play:'19.7K'})]}), html({rows:[item(6655, {play:'19,72'})]}),
    html({rows:[item(6655, {play:'0'})]}), html({rows:[item(6655, {win_rate:101})]}),
    html({rows:[item(6655, {pick_rate:-1})]}), html({rows:[item(6655, {metaItem:{id:4645}})]}),
    html({rows:[item(), item()]}), html({boots:[item()]}),
    html({extraSections:[section('Items', [item(4645)], 'aram')]}),
    html({}, rows => { rows[4][3].children[1][3].children[3].mode = 'ranked'; return rows; }),
  ];
  for (const page of invalid) {
    let calls = 0;
    assert.equal(await source(async () => ++calls === 1 ? response(page) : {ok:false, status:404}).load(request), null);
  }
});

test('zero and full source win rates are accepted as probabilities without made-up counts', async () => {
  const result = await source(async () => response(html({rows:[item(1, {win_rate:0}), item(2, {win_rate:100})]}))).load(request);
  assert.deepEqual(result.items.slice(0, 2).map(row => row.winRate), [0, 1]);
});

test('blocked responses stop fallback and impose a bounded in-memory quiet period', async () => {
  for (const status of [401, 403, 429]) {
    let time = NOW, calls = 0;
    const client = source(async () => { calls++; return {ok:false, status}; }, () => time);
    assert.equal(await client.load(request), null);
    assert.equal(calls, 1);
    time += 1000;
    assert.equal(await client.load(request), null);
    assert.equal(calls, 1, 'do not retry blocked ARAM through a ranked path');
    time += 31 * 60 * 1000;
    assert.equal(await client.load(request), null);
    assert.equal(calls, 2);
  }
});

test('incorrect final URLs, non-HTML and oversized responses are never accepted', async () => {
  const invalid = [
    response(html(), {url:'https://example.com/redirected'}),
    response(html(), {headers:{get:name => name === 'content-type' ? 'application/json' : null}}),
    response(html(), {headers:{get:name => name === 'content-length' ? String(5 * 1024 * 1024) : null}}),
    response('x'.repeat(4 * 1024 * 1024 + 1)),
  ];
  for (const first of invalid) {
    let calls = 0;
    assert.equal(await source(async () => ++calls === 1 ? first : {ok:false, status:404}).load(request), null);
  }
});

test('ordinary scripts are never executed; JSON Flight chunks may split records', async () => {
  const page = html();
  const pushed = JSON.parse(page.match(/self\.__next_f\.push\(([\s\S]*)\)<\/script>/)[1]);
  const middle = Math.floor(pushed[1].length / 2);
  const split = `<script>globalThis.__hexguideMustNeverRun = true;</script>`
    + `<script>self.__next_f.push(${JSON.stringify([1, pushed[1].slice(0, middle)])})</script>`
    + `<script>self.__next_f.push(${JSON.stringify([1, pushed[1].slice(middle)])})</script>`;
  assert.ok(await source(async () => response(split)).load(request));
  assert.equal(globalThis.__hexguideMustNeverRun, undefined);
  let calls = 0;
  assert.equal(await source(async () => ++calls === 1
    ? response('<script>self.__next_f.push(notJSON())</script>') : {ok:false, status:404}).load(request), null);
});

test('streamed responses use bounded byte reading and release their reader', async () => {
  const encoder = new TextEncoder();
  const result = await source(async () => new Response(new ReadableStream({start(controller) {
    controller.enqueue(encoder.encode(html())); controller.close();
  }}), {headers:{'content-type':'text/html'}})).load(request);
  assert.equal(result.mode, 'aram');
  let cancelled = false, calls = 0;
  const oversized = new Response(new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
  }, cancel() { cancelled = true; }}), {headers:{'content-type':'text/html'}});
  assert.equal(await source(async () => ++calls === 1 ? oversized : {ok:false, status:404}).load(request), null);
  assert.equal(cancelled, true);
});

test('invalid requests make no network requests; no player/account data can enter a URL', async () => {
  let calls = 0;
  const client = source(async () => { calls++; return response(html()); });
  for (const value of [{}, {...request, patch:'16.20&account=abc'}, {...request, championSlug:'ahri/../../account'},
    {...request, championId:'Jinx'}, {...request, championId:'https://localhost/'}, {...request, championId:0}]) {
    assert.equal(await client.load(value), null);
  }
  assert.equal(calls, 0);
  assert.throws(() => createReferenceBuildSource({fetcher:null}), TypeError);
});

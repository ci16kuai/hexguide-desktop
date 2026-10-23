import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createDefaultLayout, validateLayout, DEFAULT_LAYOUT, MAX_LAYOUT_BYTES, UI_ELEMENTS} from '../dist/layout-config.js';
import {LayoutStore, LayoutValidationError} from '../server/layout.mjs';
import {AppearanceStore} from '../server/appearance.mjs';
import {BackgroundSidebar} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';

async function folder(t) {
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-23\\hexguide-desktop';
  await mkdir(root, {recursive:true});
  const directory = await mkdtemp(path.join(root, 'layout-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return directory;
}

function request(port, target, {headers={},method='GET',body} = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port,path:target,method,headers},response => {
      const chunks=[];
      response.on('data',chunk => chunks.push(chunk));
      response.on('end',() => resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);
    req.end(body);
  });
}

const container = UI_ELEMENTS.find(element => element.container && UI_ELEMENTS.some(child => child.parent === element.id));
const leaf = UI_ELEMENTS.find(element => !element.container);
const children = UI_ELEMENTS.filter(element => element.parent === container.id);

function changed() {
  return {
    schemaVersion:1,
    elements:{
      [container.id]:{hidden:false,fontFamily:'simsun',fontSize:60,color:'#AABBCC',background:'transparent',padding:64,align:'center',width:1600,height:900,columns:3,gap:48,span:3,borderRadius:32},
      [leaf.id]:{hidden:true,fontFamily:'yahei',fontSize:10,color:'#000000',background:'#ffffff',padding:0,align:'right',width:0,height:0,span:1,borderRadius:0},
    },
    orders:{[container.id]:children.map(element => element.id).reverse()},
  };
}

test('layout registry has unique stable IDs, valid parent containers and safe immutable defaults', () => {
  const ids = new Set(UI_ELEMENTS.map(element => element.id));
  assert.equal(ids.size, UI_ELEMENTS.length);
  assert.ok(UI_ELEMENTS.length > 20, 'whole-interface registry covers more than a few summary panels');
  assert.ok(container && leaf && children.length);
  for (const element of UI_ELEMENTS) {
    assert.match(element.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(element.label);
    assert.equal(typeof element.container,'boolean');
    if (element.parent !== null) assert.equal(UI_ELEMENTS.find(parent => parent.id === element.parent)?.container,true,element.id);
  }
  assert.ok(Object.isFrozen(DEFAULT_LAYOUT));
  assert.ok(Object.isFrozen(DEFAULT_LAYOUT.elements));
  const first = createDefaultLayout();
  first.elements[leaf.id] = {hidden:true};
  assert.deepEqual(createDefaultLayout(), {schemaVersion:1,elements:{},orders:{}});
});

test('layout schema accepts sparse boundary values and direct-sibling subset orders without sharing objects', () => {
  const input = changed();
  assert.deepEqual(validateLayout(input),input);
  const returned = validateLayout(input);
  returned.elements[leaf.id].hidden = false;
  returned.orders[container.id].reverse();
  assert.equal(input.elements[leaf.id].hidden,true);
  assert.deepEqual(input.orders[container.id],children.map(element => element.id).reverse());
  assert.deepEqual(validateLayout({schemaVersion:1,elements:{[leaf.id]:{}},orders:{[container.id]:[]}}), {schemaVersion:1,elements:{[leaf.id]:{}},orders:{[container.id]:[]}});
  assert.deepEqual(validateLayout({schemaVersion:1,elements:{},orders:{[container.id]:[children[0].id]}}).orders[container.id],[children[0].id]);
});

test('layout schema rejects unknown IDs and unsafe fields, malformed orders, CSS and numeric values outside documented ranges', () => {
  const invalid = [null,[],{},new Date(),Object.create({schemaVersion:1,elements:{},orders:{}}),
    {schemaVersion:2,elements:{},orders:{}}, {schemaVersion:1,elements:{},orders:{},unknown:true},
    {schemaVersion:1,elements:[],orders:{}}, {schemaVersion:1,elements:{},orders:null},
    {schemaVersion:1,elements:{'body > *':{hidden:true}},orders:{}},
    {schemaVersion:1,elements:{[leaf.id]:null},orders:{}},
    {schemaVersion:1,elements:{[leaf.id]:{customCss:'body{display:none}'}},orders:{}},
    {schemaVersion:1,elements:{[leaf.id]:{text:'<script>alert(1)</script>'}},orders:{}},
    {schemaVersion:1,elements:{[leaf.id]:{columns:2}},orders:{}},
    {schemaVersion:1,elements:{[leaf.id]:{gap:10}},orders:{}},
    {schemaVersion:1,elements:{},orders:{unknown:[]}},
    {schemaVersion:1,elements:{},orders:{[leaf.id]:[]}},
    {schemaVersion:1,elements:{},orders:{[container.id]:[container.id]}},
    {schemaVersion:1,elements:{},orders:{[container.id]:[children[0].id,children[0].id]}},
    {schemaVersion:1,elements:{},orders:{[container.id]:[null]}},
    JSON.parse('{"schemaVersion":1,"elements":{},"orders":{},"__proto__":{}}'),
    JSON.parse(`{"schemaVersion":1,"elements":{"${leaf.id}":{"__proto__":{}}},"orders":{}}`),
  ];
  for (const [key,value] of [
    ['hidden',1],['fontFamily','url(https://example.com)'],['fontFamily','Arial'],
    ['fontSize',9],['fontSize',61],['fontSize',12.5],['fontSize','16'],
    ['color','#fff'],['color','red'],['color','var(--token)'],['color','url(x)'],
    ['background','#000000;display:none'],['background',null],['align','justify'],
    ['width',-1],['width',1601],['height',901],['height',Infinity],
    ['padding',65],['padding',-1],['columns',0],['columns',4],['gap',49],
    ['span',0],['span',4],['borderRadius',33],['borderRadius',NaN],
  ]) invalid.push({schemaVersion:1,elements:{[container.id]:{[key]:value}},orders:{}});
  const foreignSibling = UI_ELEMENTS.find(element => element.parent !== container.id);
  if (foreignSibling) invalid.push({schemaVersion:1,elements:{},orders:{[container.id]:[foreignSibling.id]}});
  for (const input of invalid) assert.throws(() => validateLayout(input),TypeError);
});

test('layout persistence survives restart and corruption, keeps appearance/session separate and copies accepted values', async t => {
  const directory = await folder(t);
  await writeFile(path.join(directory,'appearance.json'),'appearance fixture');
  await writeFile(path.join(directory,'session.json'),'game fixture');
  const store = await new LayoutStore({dataDirectory:directory}).load();
  assert.deepEqual(store.get(),createDefaultLayout());
  const input = changed();
  const accepted = await store.set(input);
  input.elements[leaf.id].hidden = false;
  accepted.elements[leaf.id].fontSize = 55;
  const consumer = store.get();
  consumer.orders[container.id] = [];
  assert.deepEqual(store.get(),changed());
  assert.deepEqual((await new LayoutStore({dataDirectory:directory}).load()).get(),changed());
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'ui-layout.json'),'utf8')),changed());
  assert.deepEqual((await readdir(directory)).sort(),['appearance.json','session.json','ui-layout.json']);
  assert.equal(await readFile(path.join(directory,'appearance.json'),'utf8'),'appearance fixture');
  assert.equal(await readFile(path.join(directory,'session.json'),'utf8'),'game fixture');
  for (const body of ['{broken',JSON.stringify({...changed(),schemaVersion:999}), 'x'.repeat(MAX_LAYOUT_BYTES+1)]) {
    await writeFile(path.join(directory,'ui-layout.json'),body);
    assert.deepEqual((await new LayoutStore({dataDirectory:directory}).load()).get(),createDefaultLayout());
  }
});

test('layout writes are serialized atomically; a failed save retains the previous model and a later save can recover', async t => {
  const directory = await folder(t);
  const store = new LayoutStore({dataDirectory:directory});
  const first = changed(), last = createDefaultLayout();
  last.elements[leaf.id] = {hidden:false,fontSize:23};
  const results = await Promise.all([store.set(first),store.set(last)]);
  assert.deepEqual(results,[first,last]);
  assert.deepEqual(store.get(),last);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'ui-layout.json'),'utf8')),last);
  assert.deepEqual(await readdir(directory),['ui-layout.json']);
  await assert.rejects(store.set({...last,token:'rejected'}),LayoutValidationError);
  assert.deepEqual(store.get(),last);
  const blocked = path.join(directory,'not-a-directory');
  await writeFile(blocked,'fixture');
  store.dataDirectory = blocked;
  await assert.rejects(store.set(first));
  assert.deepEqual(store.get(),last);
  await rm(blocked);
  await store.set(first);
  assert.deepEqual(store.get(),first);
  await store.flush();
});

test('an exactly 32 KiB canonical layout survives its saved newline, while oversized store writes are rejected before persistence', async t => {
  const directory = await folder(t);
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>fixture</title>');
  const full = {
    schemaVersion:1,
    elements:Object.fromEntries(UI_ELEMENTS.map(element => [element.id,{
      hidden:false,fontFamily:'simsun',fontSize:60,color:'#AABBCC',background:'transparent',padding:64,
      align:'center',width:1600,height:900,...(element.container ? {columns:3,gap:48} : {}),span:3,borderRadius:32,
    }])),
    orders:{},
  };
  const byteLength = value => Buffer.byteLength(JSON.stringify(value),'utf8');
  assert.ok(byteLength(validateLayout(full)) > MAX_LAYOUT_BYTES,'full valid model exercises the persistence limit');
  const boundary = structuredClone(full);
  // Remove individual optional overrides, then shorten booleans one byte at a time to hit the exact boundary.
  for (const props of Object.values(boundary.elements)) {
    for (const [key,value] of Object.entries(props)) {
      delete props[key];
      if (byteLength(boundary) < MAX_LAYOUT_BYTES) props[key] = value;
    }
  }
  for (const props of Object.values(boundary.elements)) {
    if (byteLength(boundary) === MAX_LAYOUT_BYTES) break;
    if (props.hidden === false) props.hidden = true;
  }
  assert.equal(byteLength(validateLayout(boundary)),MAX_LAYOUT_BYTES);
  const dataDirectory = path.join(directory,'data');
  const layout = new LayoutStore({dataDirectory});
  const local = await createLocalServer({collector:{getSnapshot:() => ({})},layout,staticDirectory:directory,token:'g'.repeat(64)});
  t.after(() => local.close());
  const response = await request(local.port,'/api/layout',{
    headers:{'X-Hexguide-Session':local.token,'Content-Type':'application/json'},method:'POST',body:JSON.stringify(boundary),
  });
  assert.equal(response.status,200);
  assert.equal((await stat(path.join(dataDirectory,'ui-layout.json'))).size,MAX_LAYOUT_BYTES+1);
  assert.deepEqual((await new LayoutStore({dataDirectory}).load()).get(),boundary);
  await assert.rejects(layout.set(full),LayoutValidationError);
  assert.deepEqual(layout.get(),boundary);
  assert.deepEqual((await new LayoutStore({dataDirectory}).load()).get(),boundary);
});

test('layout API preserves local authentication and host/origin checks, applies its own body limit and roundtrips independently from game state', async t => {
  const directory = await folder(t);
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>fixture</title>');
  const collector = {getSnapshot:() => ({connection:{status:'waiting'},phase:'None',items:[]})};
  const appearance = new AppearanceStore();
  const sidebar = new BackgroundSidebar({collector,appearance});
  const layout = await new LayoutStore({dataDirectory:path.join(directory,'data')}).load();
  const local = await createLocalServer({collector,sidebar,appearance,layout,staticDirectory:directory,token:'e'.repeat(64)});
  t.after(() => local.close());
  const headers = {'X-Hexguide-Session':local.token,'Content-Type':'application/json'};
  const body = JSON.stringify(changed());
  for (const method of ['GET','POST']) {
    const options = {method,...(method === 'POST' ? {body} : {})};
    assert.equal((await request(local.port,'/api/layout',options)).status,401);
    assert.equal((await request(local.port,'/api/layout',{...options,headers:{...headers,Origin:'https://attacker.example'}})).status,403);
    assert.equal((await request(local.port,'/api/layout',{...options,headers:{...headers,Host:'attacker.example'}})).status,403);
  }
  assert.equal((await request(local.port,'/api/layout?token='+local.token)).status,401);
  assert.deepEqual(JSON.parse((await request(local.port,'/api/layout',{headers})).body),createDefaultLayout());
  for (const invalid of ['{}','null','[]','{broken',JSON.stringify({...changed(),unknown:true})]) assert.equal((await request(local.port,'/api/layout',{headers,method:'POST',body:invalid})).status,400);
  assert.equal((await request(local.port,'/api/layout',{headers,method:'POST',body:' '.repeat(MAX_LAYOUT_BYTES+1)})).status,413);
  assert.equal((await request(local.port,'/api/layout',{headers,method:'POST',body:' '.repeat(8192)+body})).status,200,'layout model may legitimately exceed the old 4 KiB limit');
  for (const endpoint of ['/api/appearance','/api/session','/api/sidebar/ocr','/api/ocr']) assert.equal((await request(local.port,endpoint,{headers,method:'POST',body:' '.repeat(4097)})).status,413,endpoint);
  assert.equal((await request(local.port,'/api/layout',{headers,method:'PUT',body})).status,405);
  assert.deepEqual(JSON.parse((await request(local.port,'/api/layout',{headers:{...headers,Origin:`http://127.0.0.1:${local.port}`}})).body),changed());
  assert.deepEqual(JSON.parse((await request(local.port,'/api/session',{headers})).body).owned,[]);
  assert.deepEqual(appearance.get(),new AppearanceStore().get());
  assert.deepEqual((await new LayoutStore({dataDirectory:path.join(directory,'data')}).load()).get(),changed());
  const blocked = path.join(directory,'blocked-data');
  await writeFile(blocked,'fixture');
  layout.dataDirectory = blocked;
  const failedSave = await request(local.port,'/api/layout',{headers,method:'POST',body:JSON.stringify(createDefaultLayout())});
  assert.equal(failedSave.status,500);
  assert.ok(!failedSave.body.includes(directory),'disk paths are not exposed in API errors');
  assert.deepEqual(JSON.parse((await request(local.port,'/api/layout',{headers})).body),changed(),'failed save retains the last saved layout');
  layout.dataDirectory = path.join(directory,'data');
  assert.equal((await request(local.port,'/api/layout',{headers,method:'POST',body:JSON.stringify(createDefaultLayout())})).status,200);
  assert.deepEqual(JSON.parse((await request(local.port,'/api/layout',{headers})).body),createDefaultLayout());
  const noSettings = await createLocalServer({collector,staticDirectory:directory,token:'f'.repeat(64)});
  t.after(() => noSettings.close());
  assert.equal((await request(noSettings.port,'/api/layout',{headers:{'X-Hexguide-Session':noSettings.token}})).status,503);
  assert.equal((await request(noSettings.port,'/api/layout',{headers:{'X-Hexguide-Session':noSettings.token},method:'POST',body})).status,503);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DEFAULT_APPEARANCE, createDefaultAppearance, validateAppearance} from '../dist/appearance-config.js';
import {AppearanceStore, AppearanceValidationError} from '../server/appearance.mjs';
import {BackgroundSidebar} from '../server/sidebar.mjs';
import {createLocalServer} from '../server/http.mjs';

async function folder(t) {
  const root = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-23\\hexguide-desktop';
  await mkdir(root, {recursive:true});
  const directory = await mkdtemp(path.join(root, 'appearance-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return directory;
}

function changed() {
  const settings = createDefaultAppearance();
  settings.main = {fontFamily:'simsun', scale:130, density:'compact', cardLayout:'list', panelSide:'right'};
  settings.sidebar = {fontFamily:'yahei', scale:85, width:460, side:'right', opacity:75, sections:['offers','hero','plan','owned']};
  return settings;
}

test('appearance schema accepts documented boundaries and rejects CSS, unknown keys, partial values and non-permutations', () => {
  assert.equal(createDefaultAppearance().sidebar.side, 'left', 'new sidebars default to the left edge');
  const settings = changed();
  assert.equal(settings.sidebar.side, 'right', 'right-side selection remains supported during this run');
  assert.deepEqual(validateAppearance(settings), settings);
  const independent = validateAppearance(settings);
  independent.sidebar.sections.reverse();
  assert.notDeepEqual(independent.sidebar.sections, settings.sidebar.sections);
  assert.ok(Object.isFrozen(DEFAULT_APPEARANCE.sidebar.sections));
  const invalid = [null, [], {}, {...settings, schemaVersion:2}, {...settings, extra:'ignored?'}];
  for (const [section, key, value] of [
    ['main','fontFamily','url(https://example.com)'], ['main','fontFamily','Arial'],
    ['main','scale',84], ['main','scale',131], ['main','scale','100'], ['main','scale',100.5],
    ['main','density','loose'], ['main','cardLayout','automatic'], ['main','panelSide','bottom'],
    ['sidebar','fontFamily','anything'], ['sidebar','scale',NaN], ['sidebar','scale',Infinity],
    ['sidebar','width',279], ['sidebar','width',461], ['sidebar','width',324.5],
    ['sidebar','opacity',74], ['sidebar','opacity',101], ['sidebar','side','top'],
    ['sidebar','sections',['hero','owned','offers']], ['sidebar','sections',['hero','owned','offers','offers']],
    ['sidebar','sections',['hero','owned','offers','unknown']], ['sidebar','sections','hero'],
  ]) {
    const valueToReject = createDefaultAppearance();
    valueToReject[section][key] = value;
    invalid.push(valueToReject);
  }
  const nestedExtra = createDefaultAppearance();
  nestedExtra.main.customCss = 'body{display:none}';
  invalid.push(nestedExtra);
  const partial = createDefaultAppearance();
  delete partial.sidebar.opacity;
  invalid.push(partial);
  invalid.push(JSON.parse(JSON.stringify(settings).replace('"fontFamily":"simsun"', '"fontFamily":"simsun","__proto__":{}')));
  for (const input of invalid) assert.throws(() => validateAppearance(input), TypeError);
});

test('saved appearance except startup docking survives restart independently from game selections, while corrupt or unsupported files use defaults', async t => {
  const directory = await folder(t);
  const store = await new AppearanceStore({dataDirectory:directory}).load();
  assert.deepEqual(store.get(), createDefaultAppearance());
  const settings = changed();
  await store.set(settings);
  settings.sidebar.width = 300;
  assert.equal(store.get().sidebar.width,460,'caller mutation cannot modify accepted settings');
  const returned = store.get();
  returned.main.scale = 90;
  assert.equal(store.get().main.scale,130,'consumer mutation cannot modify saved settings');
  const disk = JSON.parse(await readFile(path.join(directory,'appearance.json'),'utf8'));
  assert.deepEqual(disk, changed());
  assert.deepEqual((await readdir(directory)).sort(), ['appearance.json']);
  const restored = await new AppearanceStore({dataDirectory:directory}).load();
  const restoredSettings = changed();
  restoredSettings.sidebar.side = 'left';
  assert.deepEqual(restored.get(), restoredSettings);
  for (const body of ['{broken', JSON.stringify({...changed(),schemaVersion:999}), 'x'.repeat(4097)]) {
    await writeFile(path.join(directory,'appearance.json'),body);
    assert.deepEqual((await new AppearanceStore({dataDirectory:directory}).load()).get(), createDefaultAppearance());
  }
});

test('each startup docks left while retaining every other saved appearance preference and leaving disk unchanged', async t => {
  const directory = await folder(t);
  const firstRun = await new AppearanceStore({dataDirectory:directory}).load();
  const selected = changed();
  await firstRun.set(selected);
  assert.equal(firstRun.get().sidebar.side, 'right', 'right-side docking works in the current run');
  const file = path.join(directory, 'appearance.json');
  const savedBytes = await readFile(file, 'utf8');
  const restarted = await new AppearanceStore({dataDirectory:directory}).load();
  const expected = structuredClone(selected);
  expected.sidebar.side = 'left';
  assert.deepEqual(restarted.get(), expected, 'only sidebar docking resets; fonts, size, opacity, section order and main layout survive');
  assert.equal(await readFile(file, 'utf8'), savedBytes, 'startup does not rewrite or discard saved fields');
  assert.deepEqual(await readdir(directory), ['appearance.json'], 'drag position is not persisted by the appearance store');
  await restarted.set(selected);
  assert.equal(restarted.get().sidebar.side, 'right', 'a new run can still select right-side docking');
  assert.deepEqual((await new AppearanceStore({dataDirectory:directory}).load()).get(), expected, 'every subsequent startup returns to left docking');
});

test('appearance writes are serialized; failed persistence retains the last saved view and permits a later retry', async t => {
  const directory = await folder(t);
  const store = new AppearanceStore({dataDirectory:directory});
  const first = changed();
  const last = changed();
  last.main.scale = 110;
  last.sidebar.width = 380;
  const [savedFirst, savedLast] = await Promise.all([store.set(first), store.set(last)]);
  assert.deepEqual(savedFirst,first);
  assert.deepEqual(savedLast,last);
  assert.deepEqual(store.get(),last);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'appearance.json'),'utf8')),last);
  await assert.rejects(store.set({...last,token:'not allowed'}),AppearanceValidationError);
  assert.deepEqual(store.get(),last);
  const blocked = path.join(directory,'not-a-directory');
  await writeFile(blocked,'fixture');
  const failed = new AppearanceStore({dataDirectory:blocked});
  await assert.rejects(failed.set(first));
  assert.deepEqual(failed.get(),createDefaultAppearance());
  await rm(blocked);
  await failed.set(last);
  assert.deepEqual(failed.get(),last);
  await Promise.all([store.flush(), failed.flush()]);
});

function request(port, target, {headers={},method='GET',body} = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port,path:target,method,headers},response => {
      const chunks=[];
      response.on('data',chunk => chunks.push(chunk));
      response.on('end',() => resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);
    req.end(body);
  });
}

test('appearance API retains local Host, Origin, session authentication, bounded strict writes and updates the sidebar model', async t => {
  const directory = await folder(t);
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>fixture</title>');
  const collector = {getSnapshot:() => ({connection:{status:'waiting'},phase:'None',items:[]})};
  const appearance = await new AppearanceStore({dataDirectory:path.join(directory,'data')}).load();
  const sidebar = new BackgroundSidebar({collector, appearance});
  const local = await createLocalServer({collector,sidebar,appearance,staticDirectory:directory,token:'c'.repeat(64)});
  t.after(() => local.close());
  const headers = {'X-Hexguide-Session':local.token, 'Content-Type':'application/json'};
  const body = JSON.stringify(changed());
  for (const method of ['GET','POST']) {
    const options = {method,...(method === 'POST' ? {body} : {})};
    assert.equal((await request(local.port,'/api/appearance',options)).status,401);
    assert.equal((await request(local.port,'/api/appearance',{...options,headers:{...headers,Origin:'https://attacker.example'}})).status,403);
    assert.equal((await request(local.port,'/api/appearance',{...options,headers:{...headers,Host:'attacker.example'}})).status,403);
  }
  assert.equal((await request(local.port,'/api/appearance?token='+local.token)).status,401);
  assert.deepEqual(JSON.parse((await request(local.port,'/api/appearance',{headers})).body),createDefaultAppearance());
  for (const invalid of ['{}','null','[]','{broken',JSON.stringify({...changed(),unknown:'rejected'})]) assert.equal((await request(local.port,'/api/appearance',{headers,method:'POST',body:invalid})).status,400);
  assert.equal((await request(local.port,'/api/appearance',{headers,method:'POST',body:' '.repeat(4097)})).status,413);
  assert.equal((await request(local.port,'/api/appearance',{headers,method:'PUT',body})).status,405);
  assert.equal((await request(local.port,'/api/appearance',{headers,method:'POST',body})).status,200);
  const model = JSON.parse((await request(local.port,'/api/sidebar',{headers})).body);
  assert.deepEqual(model.appearance,changed());
  assert.deepEqual(model.owned,[],'appearance edits never change game selections');
  assert.deepEqual(model.offers,[]);
  assert.deepEqual(JSON.parse((await request(local.port,'/api/appearance',{headers})).body),changed());
  const noSettings = await createLocalServer({collector,staticDirectory:directory,token:'d'.repeat(64)});
  t.after(() => noSettings.close());
  assert.equal((await request(noSettings.port,'/api/appearance',{headers:{'X-Hexguide-Session':noSettings.token}})).status,503);
});

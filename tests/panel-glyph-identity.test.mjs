import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import path from 'node:path';
import {PANEL_GLYPH_ALGORITHM,panelTemplateBinding,panelGlyphIdentity} from '../server/panel-glyph-identity.mjs';
import {validatePanelEvidence} from '../server/panel-selection.mjs';
import {glyphProof} from './fixtures/panel-glyph-proof.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const fixtureRoot = new URL('./fixtures/panel-glyphs/',import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json',fixtureRoot),'utf8'));
const assets = new Map(manifest.assets.map(asset => [asset.id,asset]));
const stamp = Date.parse('2026-10-25T01:00:00Z');
function context(ids = ['final_form','surge_field','goliath'], owned = []) {
  const definition = id => ({id,iconKey:assets.get(id).url,kind:'augment',statistic:{championId:'Ahri',mode:'mayhem',patch:'16.21',source:'offline-fixture',sampleCount:id === 'surge_field' ? 800 : 1000,winRate:.55}});
  return {eligible:true,now:stamp+2000,gameId:'offline-glyph',gameEpoch:1,revision:1,offerToken:'a'.repeat(32),ids,
    championId:'Ahri',patch:'16.21',offeredAt:stamp,offers:ids.map(definition),owned:owned.map(definition)};
}
function proof(current, matches = [[0,1]], glyphs = glyphProof(current.offers,current.owned,(_url,id) => assets.get(id).glyph)) {
  return {version:2,provider:'panel-icon',offerToken:current.offerToken,gameId:current.gameId,gameEpoch:current.gameEpoch,revision:current.revision,ids:[...current.ids],glyphs,
    frames:[0,1,2].map(index => ({captureId:`offline-${index}`,capturedAt:stamp+1000+index*150,panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,geometryKey:'offline-hud',
      slots:Array.from({length:6},(_,slotIndex) => {const indices = matches[slotIndex] || [];return {slotIndex,state:indices.length > 1 ? 'ambiguous' : indices.length ? 'candidate' : 'empty',candidateIndices:[...indices]};})}))};
}

test('pinned real catalog assets have distinct URLs, tracked bytes and the same normalized glyph for all three reported aliases',async () => {
  const catalog = JSON.parse(await readFile(new URL('../dist/data.json',import.meta.url),'utf8'));
  assert.equal(manifest.algorithm,PANEL_GLYPH_ALGORITHM);
  for (const asset of manifest.assets) {
    assert.equal(catalog.augments.find(augment => augment.id === asset.id).icon,asset.url);
    const bytes = await readFile(new URL(`${asset.id}.png`,fixtureRoot));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  }
  const aliases = ['its_killing_time','final_form','surge_field'].map(id => assets.get(id));
  assert.equal(new Set(aliases.map(asset => asset.url)).size,3);
  assert.equal(new Set(aliases.map(asset => asset.glyph)).size,1);
  assert.notEqual(assets.get('goliath').glyph,aliases[0].glyph);
});

test('cross-URL equivalent offer glyphs share one proven group and retain inferred labeling',() => {
  const current = context(), result = validatePanelEvidence(proof(current),current);
  assert.equal(result.status,'inferred'); assert.equal(result.id,'final_form'); assert.equal(result.inferred,true);
  assert.deepEqual(result.evidence.candidateIndices,[0,1]);
  assert.equal(result.evidence.resolution,'usage-then-win-rate');
});

test('a cross-URL known-owned glyph is subtracted before selecting a different new glyph or an extra equivalent glyph',() => {
  const current = context(['final_form','goliath','eureka'],['its_killing_time']);
  assert.equal(validatePanelEvidence(proof(current,[[0]]),current).reason,'panel-no-new-match');
  assert.equal(validatePanelEvidence(proof(current,[[0],[1]]),current).id,'goliath');
  assert.equal(validatePanelEvidence(proof(current,[[0],[0]]),current).id,'final_form');
  const multipleOwned = context(['final_form','goliath','eureka'],['its_killing_time','surge_field']);
  assert.equal(validatePanelEvidence(proof(multipleOwned,[[0],[0]]),multipleOwned).reason,'panel-no-new-match');
  assert.equal(validatePanelEvidence(proof(multipleOwned,[[0],[0],[0]]),multipleOwned).id,'final_form');
});

test('template bindings reject reordered, missing, malformed, stale-ID and stale-URL attestations',() => {
  const current = context(['final_form','goliath','eureka'],['its_killing_time']);
  for (const mutate of [
    value => {value.glyphs.algorithm = 'normalized28-sha256-v0';},
    value => {value.glyphs.extra = 'private';},
    value => {value.glyphs.templates.reverse();},
    value => {value.glyphs.templates.pop();},
    value => {value.glyphs.templates.push(value.glyphs.templates[0]);},
    value => {value.glyphs.templates[0][0] = panelTemplateBinding('other',current.offers[0].iconKey);},
    value => {value.glyphs.templates[0][0] = panelTemplateBinding(current.ids[0],assets.get('surge_field').url);},
    value => {value.glyphs.templates[0][1] = 'not-a-fingerprint';},
    value => {delete value.glyphs.templates[0][1];},
    value => {value.glyphs.templates[0].push('extra');},
    value => {value.glyphs = null;},
  ]) {
    const value = proof(current,[[0],[1]]); mutate(value);
    assert.equal(validatePanelEvidence(value,current).reason,'panel-glyph-identity-invalid');
  }
  const legacy = proof(current); delete legacy.version; delete legacy.glyphs;
  assert.equal(validatePanelEvidence(legacy,current).reason,'panel-evidence-invalid','URL-only native observations cannot bypass v2');
});

test('different descriptors cannot be aliased by changing candidate indices and one URL cannot claim two identities',() => {
  const current = context(['final_form','goliath','eureka']);
  assert.equal(validatePanelEvidence(proof(current,[[0,1]]),current).reason,'panel-collision-unverified');
  const shared = context(), partial = proof(shared,[[0]]);
  assert.equal(validatePanelEvidence(partial,shared).reason,'panel-collision-unverified');
  shared.offers[1].iconKey = shared.offers[0].iconKey;
  const conflict = proof(shared);
  conflict.glyphs.templates[1][1] = assets.get('goliath').glyph;
  assert.equal(validatePanelEvidence(conflict,shared).reason,'panel-glyph-identity-invalid');
});

test('maximum nine template descriptors remain bounded and oversized full proofs never pass',() => {
  const current = context();
  current.owned = Array.from({length:6},(_,index) => ({id:`previous_${index}`,iconKey:`https://raw.communitydragon.org/16.21/old-${index}.png`}));
  const glyphs = glyphProof(current.offers,current.owned,url => createHash('sha256').update(url).digest('hex'));
  const value = proof(current,[[0]],glyphs);
  assert.equal(glyphs.templates.length,9);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096);
  assert.equal(validatePanelEvidence(value,current).status,'matched');
  const extraOwned = {...current,owned:[...current.owned,{id:'seventh',iconKey:'seventh'}]};
  assert.equal(validatePanelEvidence(value,extraOwned).reason,'panel-context-invalid');
  current.ids = [0,1,2].map(index => String(index).padEnd(100,'a'));
  current.offers = current.ids.map(id => ({id,iconKey:id,kind:'augment'}));
  current.gameId = 'g'.repeat(40); current.gameEpoch = current.revision = Number.MAX_SAFE_INTEGER;
  current.now = Number.MAX_SAFE_INTEGER-100; current.offeredAt = Number.MAX_SAFE_INTEGER-2000;
  const worst = {...value,ids:current.ids,gameId:current.gameId,gameEpoch:current.gameEpoch,revision:current.revision,
    glyphs:glyphProof(current.offers,current.owned,() => 'a'.repeat(64)),frames:[0,1,2].map(index => ({
      captureId:String(index).padEnd(80,'a'),capturedAt:Number.MAX_SAFE_INTEGER-1100+index*400,
      panelVisible:true,gameSurfaceVerified:true,selectionUiVisible:false,geometryKey:'g'.repeat(120),
      slots:Array.from({length:6},(_,slotIndex) => ({slotIndex,state:'ambiguous',candidateIndices:[0,1,2]})),
    }))};
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) <= 4096,'even every maximum-length valid v2 field with nine templates and three frames fits');
  assert.equal(validatePanelEvidence(worst,current).reason,'panel-no-new-match');
  worst.frames = Array.from({length:8},(_,index) => ({...worst.frames[0],captureId:String(index).padEnd(80,'a'),capturedAt:Number.MAX_SAFE_INTEGER-1800+index*200}));
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) > 4096);
  assert.equal(validatePanelEvidence(worst,current).reason,'panel-evidence-invalid');
});

test('actual native extraction and matching use the same v2 identity and bind every known-owned template',{skip:process.platform !== 'win32',timeout:20000},async t => {
  const workRoot = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-25\\hexguide-six-fixes\\glyph';
  await mkdir(workRoot,{recursive:true});
  const work = await mkdtemp(path.join(workRoot,'native-'));
  t.after(async () => {assert.ok(path.resolve(work).startsWith(path.resolve(workRoot)+path.sep));await rm(work,{recursive:true,force:true});});
  const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tests','fixtures','panel-glyph-native.ps1'),'-Root',root,'-Work',work],{windowsHide:true,timeout:18000,encoding:'utf8',maxBuffer:64000});
  const native = JSON.parse(stdout.replace(/^\uFEFF/,''));
  assert.equal(native.mode,'offline-no-ui'); assert.equal(native.liveVerified,false); assert.ok(native.fixtureChecks >= 100);
  assert.deepEqual(native.glyphs,Object.fromEntries(manifest.assets.map(asset => [asset.id,asset.glyph])));
  assert.equal(native.binding,panelTemplateBinding('final_form',assets.get('final_form').url));
  assert.equal(native.shared.state,'ambiguous'); assert.deepEqual(native.shared.candidateIndices,[0,1]);
  assert.equal(native.ownedOnly.state,'owned'); assert.deepEqual(native.ownedOnly.candidateIndices,[]);
  const current = context(['final_form','surge_field','goliath'],['its_killing_time']);
  assert.ok(panelGlyphIdentity(native.templateProof,current.offers,current.owned));
  assert.equal(validatePanelEvidence(proof(current,[[0,1]],native.templateProof),current).reason,'panel-no-new-match');
  const extra = validatePanelEvidence(proof(current,[[0,1],[0,1]],native.templateProof),current);
  assert.equal(extra.status,'inferred'); assert.equal(extra.id,'final_form');
});

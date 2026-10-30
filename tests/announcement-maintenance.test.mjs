import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {diffCatalogs,normalizeCatalog} from '../tools/version-maintenance/sources.mjs';
import {runMaintenance,translateFields} from '../tools/version-maintenance/maintenance.mjs';
import {validateFeed} from '../tools/version-maintenance/validate-feed.mjs';

const source={name:'Riot Data Dragon',url:'https://ddragon.leagueoflegends.com/cdn/16.21.1/data/zh_CN/item.json',sha256:'a'.repeat(64)};
function catalog(version='16.21.1',ad=65) {
  return {schemaVersion:1,version,clientVersion:version.split('.').slice(0,2).join('.'),sources:[source],
    items:{'1001':{name:'测试装备',numbers:{'stats.FlatPhysicalDamageMod':ad,'stats.FlatCritChanceMod':.2},description:'命中造成 10% 额外伤害'}},
    augments:{Aug1:{name:'测试海克斯',numbers:{Damage:[10,10,10]}}}};
}
test('numerical diff keeps stable IDs, percentages and exact level arrays',()=>{
  const old=catalog('16.20.1',60),next=catalog();next.items['1001'].numbers['stats.FlatCritChanceMod']=.25;next.augments.Aug1.numbers.Damage=[12,13,14];
  const {changes}=diffCatalogs(old,next);
  assert.equal(changes.length,3);assert.equal(changes.find(x=>x.field.includes('CritChance')).scale,100);
  assert.deepEqual(changes.find(x=>x.kind==='augment').after,[12,13,14]);
  assert.deepEqual(changes.find(x=>x.field.includes('Physical')).before,60);
});
test('unknown old values, added/removed entities and changed wording never invent numerical transitions',()=>{
  const old=catalog(),next=catalog();delete old.items['1001'].numbers['stats.FlatPhysicalDamageMod'];next.items['1002']=next.items['1001'];
  next.items['1001'].description='不同机制造成 20% 额外伤害';
  const {changes,warnings}=diffCatalogs(old,next);assert.equal(changes.length,0);assert.equal(warnings.length,1);
});
test('same-shaped descriptions associate each numerical slot with its own context and percent unit',()=>{
  const old=catalog(),next=catalog();next.items['1001'].description='命中造成 15% 额外伤害';
  const row=diffCatalogs(old,next).changes[0];assert.equal(row.before,10);assert.equal(row.after,15);assert.equal(row.unit,'%');assert.equal(row.scale,1);assert.ok(row.context.includes('额外伤害'));
});
test('AI translates every change key and cannot replace numerical facts',async()=>{
  const changes=diffCatalogs(catalog('16.20.1',60),catalog()).changes;
  let request;
  const result=await translateFields(changes,{key:'not-a-real-key',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');request=JSON.parse(options.body);
    return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({translations:[{key:changes[0].key,label:'攻击力'}]})}]}]}));
  }});
  assert.equal(request.store,false);assert.equal(request.text.format.strict,true);assert.equal(result.labels[changes[0].key],'攻击力');assert.equal(changes[0].after,65);
  await assert.rejects(translateFields(changes,{key:'x',fetchImpl:async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"translations":[]}'}]}]}))}),/coverage/);
});
test('large updates use bounded AI batches without mixing similarly named effect slots',async()=>{
  const changes=Array.from({length:75},(_,i)=>({key:`item:${i}:effect.0`,field:'effect.0',name:'测试装备',before:1,after:2}));let calls=0;
  const result=await translateFields(changes,{key:'not-a-real-key',fetchImpl:async(url,options)=>{
    calls++;const rows=JSON.parse(JSON.parse(options.body).input);assert.ok(rows.length<=64);
    return new Response(JSON.stringify({status:'completed',usage:{input_tokens:10,output_tokens:20,total_tokens:30},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({translations:rows.map(x=>({key:x.key,label:'效果数值'}))})}]}]}));
  }});
  assert.equal(calls,2);assert.equal(Object.keys(result.labels).length,75);assert.equal(result.usage.total_tokens,60);
});
function sourceFixture() {
  const input={version:'16.21.1',items:{version:'16.21.1',data:{}},lists:[{modeName:'KIWI',augmentList:[]}],definitions:{},names:[],sources:[source]};
  for(let i=0;i<100;i++) {
    const id=`Aug${i}`,base=`Maps/ModeSpecificData/Augments/${id}`,spell=base+'/Spell';input.lists[0].augmentList.push(base);
    input.items.data[String(1000+i)]={name:'测试装备',maps:{12:true},stats:{FlatPhysicalDamageMod:60},gold:{base:100,total:100,sell:70}};
    input.definitions[base]={__type:'AugmentData',AugmentNameId:id,RootSpell:spell};
    input.definitions[spell]={__type:'SpellObject',objectPath:spell,ObjectName:'Spell',mSpell:{DataValues:[],Cooldown:{values:[120]},cooldownTime:100,castRange:2000,mSpellCalculations:{Damage:{__type:'GameCalculation',mFormulaParts:[{__type:'GameCalculationPartByCharLevelInterpolation',mStartValue:40,mEndValue:200}]}}}};
    input.names.push({augmentNameId:id,nameTRA:'测试强化'});
  }
  return input;
}
test('explicit formula constants, cooldowns and child-spell values are observed; structural changes remain unpaired',()=>{
  const input=sourceFixture(),old=normalizeCatalog(input),spell=input.definitions['Maps/ModeSpecificData/Augments/Aug0/Spell'].mSpell;
  spell.mSpellCalculations.Damage.mFormulaParts[0].mStartValue=50;spell.Cooldown.values=[100];
  const current=normalizeCatalog(input),diff=diffCatalogs(old,current);
  assert.equal(diff.changes.length,2);assert.ok(diff.changes.some(x=>x.field==='raw.Cooldown.values'));assert.ok(diff.changes.some(x=>x.field.endsWith('mStartValue')));
  spell.mSpellCalculations.Damage.mFormulaParts[0].mStat=2;
  const changedStructure=diffCatalogs(old,normalizeCatalog(input));assert.equal(changedStructure.changes.length,1);assert.equal(changedStructure.warnings.length,1);
  const child='Maps/ModeSpecificData/Augments/Aug0/Child';input.definitions[child]={__type:'SpellObject',objectPath:child,ObjectName:'Child',mSpell:{DataValues:[{name:'Bonus',values:[10]}]}};
  const withChild=normalizeCatalog(input);input.definitions[child].mSpell.DataValues[0].values=[12];
  assert.equal(diffCatalogs(withChild,normalizeCatalog(input)).changes[0].field,'spell.Child.Bonus');
});
async function setup() {
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-announcement-maintenance-'));
  const stateDirectory=path.join(root,'state'),feedDirectory=path.join(root,'feed'),envFile=path.join(root,'.env');await writeFile(envFile,'OPENAI_API_KEY=sk-unit-test-only\n');
  let calls=0;
  const options={stateDirectory,feedDirectory,envFile,officialProvider:async()=>null,now:'2026-10-31T01:00:00.000Z',versionsProvider:async()=>['16.21.1','16.20.1'],
    catalogProvider:async version=>catalog(version,version==='16.20.1'?60:65),translator:async changes=>{calls++;return {labels:Object.fromEntries(changes.map(x=>[x.key,'攻击力'])),model:'test-model'};}};
  return {root,options,calls:()=>calls};
}
test('first run backfills one real patch; unchanged input makes no further AI calls or notices',async()=>{
  const s=await setup();const first=await runMaintenance(s.options);assert.equal(first.changeCount,1);assert.equal(s.calls(),1);
  const second=await runMaintenance(s.options);assert.equal(second.changeCount,0);assert.equal(s.calls(),1);
  const index=await validateFeed(s.options.feedDirectory);assert.equal(index.entries.length,1);
});
test('failed AI leaves baseline and published history untouched; retry can succeed',async()=>{
  const s=await setup();await assert.rejects(runMaintenance({...s.options,translator:async()=>{throw Error('quota');}}),/quota/);
  await assert.rejects(readFile(path.join(s.options.stateDirectory,'snapshot.json')),/ENOENT/);
  const next=await runMaintenance(s.options);assert.ok(next.announcementId);assert.equal((await validateFeed(s.options.feedDirectory)).entries.length,1);
});
test('article survives interruption between saving the notice and advancing the baseline without a second AI charge',async()=>{
  const s=await setup();await runMaintenance(s.options);
  await writeFile(path.join(s.options.stateDirectory,'snapshot.json'),JSON.stringify(catalog('16.20.1',60)));
  await runMaintenance(s.options);assert.equal(s.calls(),1);assert.equal((await validateFeed(s.options.feedDirectory)).entries.length,1);
});
test('corrupt public article is rejected by publication validation',async()=>{
  const s=await setup();await runMaintenance(s.options);const index=await validateFeed(s.options.feedDirectory);
  await writeFile(path.join(s.options.feedDirectory,index.entries[0].id+'.json'),'{}');await assert.rejects(validateFeed(s.options.feedDirectory),/hash/);
});
test('a newer baseline and a concurrent live lock block updates',async()=>{
  const s=await setup();await mkdir(s.options.stateDirectory,{recursive:true});
  await writeFile(path.join(s.options.stateDirectory,'snapshot.json'),JSON.stringify(catalog('16.22.1')));
  await assert.rejects(runMaintenance(s.options),/newer baseline/);
  await writeFile(path.join(s.options.stateDirectory,'maintenance.lock'),'{}');await assert.rejects(runMaintenance(s.options),/active/);
});

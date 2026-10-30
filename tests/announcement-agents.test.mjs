import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AnnouncementAgent} from '../tools/version-maintenance/agents.mjs';
import {runAgentMaintenance} from '../tools/version-maintenance/run-agent.mjs';
import {finalizeAgentRun} from '../tools/version-maintenance/finalize-agent-run.mjs';
import {setupAgent} from '../tools/version-maintenance/setup-agent.mjs';
import {validateFeed} from '../tools/version-maintenance/validate-feed.mjs';

const config={schemaVersion:1,agentId:'agent_test',name:'公告助手',model:'gpt-6-luna'};
const change=(i=1)=>({key:`item:${i}:damage`,kind:'item',entityId:String(i),name:'测试装备',field:'damage',before:60,after:65,unit:'',scale:1});
function sdk({output,turnStatus='completed',usage={input_tokens:100,output_tokens:20,total_tokens:120},streamError=false,activeStatus='idle'}={}) {
  const requests=[],updates=[],cancelled=[],sessions=new Map();let sequence=0;
  const client={beta:{agents:{sessions:{
    async create(body) {
      requests.push(body);const id=`sess_${++sequence}`,turnId=`turn_${sequence}`,input=JSON.parse(body.input);
      sessions.set(id,{id,agent:{id:config.agentId,model:'gpt-6-luna'},metadata:body.metadata,status:activeStatus,usage});
      const value=output??(input.task==='translate_fields'?{translations:input.fields.map(row=>({key:row.key,label:'攻击力'}))}:{status:'checked',summary:'已完成数值检查。'});
      return {controller:{abort(){}},withResultCollection(){},async *[Symbol.asyncIterator](){yield {type:'agent.session.created',session:{id}};yield {type:'agent.session.turn.created',session_id:id,turn_id:turnId};if(streamError)throw Error('connection lost');},
        async finalResult(){return {session_id:id,turn_id:turnId,turn:{id:turnId,session_id:id,status:turnStatus,usage},output_text:JSON.stringify(value)};}};
    },
    async retrieve(id){return sessions.get(id);},
    async list(){return {data:[...sessions.values()]};},
    async update(id,body){updates.push({id,body});return {...sessions.get(id),...body};},
    events:{async create(id,body){cancelled.push({id,body});if(body.events.some(row=>row.type==='agent.session.input.cancel'))sessions.get(id).status='idle';}}
  }}}};return {client,requests,updates,cancelled,sessions};
}
test('saved Agent sessions translate bounded batches and inherit Platform-managed settings',async()=>{
  const fake=sdk(),agent=new AnnouncementAgent({client:fake.client,config,runId:'test-run'}),changes=Array.from({length:75},(_,i)=>change(i));
  const before=structuredClone(changes),result=await agent.translate(changes);
  assert.equal(fake.requests.length,2);assert.equal(Object.keys(result.labels).length,75);assert.deepEqual(changes,before);
  for(const body of fake.requests){assert.equal(body.agent_id,config.agentId);assert.equal(body.environment.type,'none');assert.equal(body.agent.model,undefined);assert.equal(body.agent.instructions,undefined);assert.deepEqual(body.agent.tools,[]);assert.equal(body.agent.text.format.type,'json_schema');assert.equal(body.agent.text.format.name,undefined);assert.equal(body.agent.text.format.strict,undefined);}
  assert.equal(result.usage.total_tokens,240);assert.equal(result.agent.sessions[0].turnId,'turn_1');
});
test('invalid labels and incomplete turns are rejected rather than treated as completed notices',async()=>{
  const missing=sdk({output:{translations:[]}});await assert.rejects(new AnnouncementAgent({client:missing.client,config,runId:'missing'}).translate([change()]),/coverage/);
  const failed=sdk({turnStatus:'failed'});await assert.rejects(new AnnouncementAgent({client:failed.client,config,runId:'failed'}).translate([change()]),/turn failed/);
  const duplicate=sdk({output:{translations:[{key:change().key,label:'攻击力'},{key:change().key,label:'攻击力'}]}});
  await assert.rejects(new AnnouncementAgent({client:duplicate.client,config,runId:'duplicate'}).translate([change()]),/coverage/);
});
test('disconnected active sessions are recorded and explicitly cancelled without automatic resubmission',async()=>{
  const fake=sdk({streamError:true,activeStatus:'in_progress'}),records=[];
  const agent=new AnnouncementAgent({client:fake.client,config,runId:'connection-test',onRecord:async row=>records.push(structuredClone(row))});
  await assert.rejects(agent.translate([change()]),/connection lost/);
  assert.equal(fake.requests.length,1);assert.equal(fake.cancelled.length,1);assert.equal(fake.cancelled[0].body.events[0].type,'agent.session.input.cancel');assert.equal(records.at(-1).sessions[0].status,'failed');
});
test('unknown usage stays null and is not reported as zero tokens',async()=>{
  const fake=sdk({usage:null}),agent=new AnnouncementAgent({client:fake.client,config,runId:'usage-test'});
  await agent.recordCheck({changeCount:0});assert.equal(agent.summary.usage,null);assert.equal(agent.summary.sessions[0].usage,null);
});
async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-agents-maintenance-')),stateDirectory=path.join(root,'state'),feedDirectory=path.join(root,'feed');
  const catalog=(version,ad)=>({schemaVersion:1,version,clientVersion:version.split('.').slice(0,2).join('.'),sources:[{name:'Riot',url:'https://ddragon.leagueoflegends.com/data.json',sha256:'c'.repeat(64)}],items:{'1001':{name:'装备',numbers:{damage:ad},description:''}},augments:{}});
  const old=catalog('16.20.1',60),current=catalog('16.21.1',65);
  await mkdir(stateDirectory);await writeFile(path.join(stateDirectory,'snapshot.json'),JSON.stringify(old));
  const envFile=path.join(root,'.env');await writeFile(envFile,'OPENAI_API_KEY=sk-unit-test-only\n');
  return {root,stateDirectory,feedDirectory,current,options:{stateDirectory,feedDirectory,envFile,versionsProvider:async()=>['16.21.1','16.20.1'],catalogProvider:async()=>current}};
}
test('a generated notice and unchanged check both retain real Agent run IDs while preserving public history',async()=>{
  const f=await fixture(),fake=sdk();
  const first=await runAgentMaintenance({...f.options,client:fake.client,config,runId:'first'});
  assert.equal(first.changeCount,1);assert.equal(first.agent.sessions.length,1);assert.equal((await validateFeed(f.feedDirectory)).entries.length,1);
  const second=await runAgentMaintenance({...f.options,client:fake.client,config,runId:'second'});
  assert.equal(second.changeCount,0);assert.equal(second.agent.sessions[0].task,'check-receipt');assert.equal(fake.requests.length,2);
  const receipt=JSON.parse(await readFile(path.join(f.stateDirectory,'agent-runs/second.json')));assert.equal(receipt.outcome,'ready-to-publish');assert.equal(receipt.agentId,config.agentId);
  assert.equal(JSON.parse(await readFile(path.join(f.stateDirectory,'last-run.json'))).agent.runId,'second');assert.equal((await validateFeed(f.feedDirectory)).entries.length,1);
});
test('an invalid Agent result cannot advance the baseline or create a public announcement',async()=>{
  const f=await fixture(),before=await readFile(path.join(f.stateDirectory,'snapshot.json'),'utf8'),fake=sdk({output:{translations:[]}});
  await assert.rejects(runAgentMaintenance({...f.options,client:fake.client,config,runId:'bad'}),/coverage/);
  assert.equal(await readFile(path.join(f.stateDirectory,'snapshot.json'),'utf8'),before);await assert.rejects(readFile(path.join(f.feedDirectory,'index.json')),{code:'ENOENT'});
  const record=JSON.parse(await readFile(path.join(f.stateDirectory,'agent-runs/bad.json')));assert.equal(record.outcome,'failed');assert.equal(fake.updates.at(-1).body.metadata.publication_status,'failed');
});
test('post-publish metadata updates are tied to the exact Agent and GitHub run',async()=>{
  const fake=sdk(),agent=new AnnouncementAgent({client:fake.client,config,runId:'same-run'});await agent.recordCheck({changeCount:0});
  const result=await finalizeAgentRun({client:fake.client,record:agent.summary,status:'published'});assert.equal(result.sessions.length,1);assert.equal(fake.updates.at(-1).body.metadata.publication_status,'published');
  await assert.rejects(finalizeAgentRun({client:fake.client,record:{...agent.summary,runId:'wrong-run'},status:'published'}),/does not belong/);
});
test('failed finalization cancels a remotely active turn even when the original runner was interrupted',async()=>{
  const fake=sdk(),agent=new AnnouncementAgent({client:fake.client,config,runId:'interrupted-run'});await agent.recordCheck({changeCount:0});
  fake.sessions.get('sess_1').status='in_progress';
  const result=await finalizeAgentRun({client:fake.client,record:agent.summary,status:'failed'});
  assert.equal(fake.cancelled.length,1);assert.equal(result.sessions[0].cancellationRequested,true);assert.equal(result.sessions[0].status,'idle');assert.equal(fake.updates.at(-1).body.metadata.publication_status,'failed');
});
test('a lost creation response can be reconciled by saved Agent ID and exact run metadata',async()=>{
  const fake=sdk(),agent=new AnnouncementAgent({client:fake.client,config,runId:'lost-response'});await agent.recordCheck({changeCount:0});fake.sessions.get('sess_1').status='in_progress';
  fake.sessions.set('sess_other',{id:'sess_other',agent:{id:config.agentId},metadata:{run_id:'other-run'},status:'in_progress'});
  const record={agentId:config.agentId,runId:'lost-response',sessions:[{sessionId:null}]};
  const result=await finalizeAgentRun({client:fake.client,record,status:'failed'});assert.equal(result.sessions.length,1);assert.equal(fake.cancelled[0].id,'sess_1');assert.equal(fake.sessions.get('sess_other').status,'in_progress');
});
test('setup reuses the saved Agent instead of duplicating resources or overwriting dashboard settings',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hexguide-agent-setup-')),configPath=path.join(root,'config.json');let created=0;
  const existing={id:config.agentId,name:'用户设置的名字',model:'gpt-6-luna',metadata:{application:'hexguide',purpose:'numerical-announcements'}};
  const client={beta:{agents:{async *list(){yield existing;},async create(){created++;throw Error('must reuse');},async retrieve(){return existing;}}}};
  const first=await setupAgent({client,configPath}),second=await setupAgent({client,configPath});assert.equal(created,0);assert.equal(first.agentId,config.agentId);assert.equal(second.name,existing.name);
});

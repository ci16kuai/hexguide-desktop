import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readApiKey,translateFields,atomicJson} from './maintenance.mjs';
import {validateFeed} from './validate-feed.mjs';

export async function verifyOpenAi({feedDirectory,key,translator=translateFields,auditor}={}) {
  const index=await validateFeed(feedDirectory);
  if(!index.entries.length)throw new Error('An existing real announcement is required for API verification.');
  const article=JSON.parse(await readFile(path.join(feedDirectory,`${index.entries[0].id}.json`),'utf8'));
  const change=structuredClone(article.changes[0]);
  if(article.schemaVersion===2){
    if(typeof auditor!=='function')throw Error('Official API verification requires an official announcement auditor.');
    const result=await auditor([change]);return {status:'verified',announcementId:article.id,fields:1,task:'official-audit',...result};
  }
  const result=await translator([change],{key});
  return {status:'verified',announcementId:article.id,fields:1,model:result.model,usage:result.usage};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{
    const key=await readApiKey();
    if(process.argv.includes('--agents')) {
      const {AnnouncementAgent,createAgentsClient}=await import('./agents.mjs');
      const config=JSON.parse(await readFile(new URL('./agent-config.json',import.meta.url),'utf8'));
      const recordIndex=process.argv.indexOf('--record'),recordPath=recordIndex>=0?process.argv[recordIndex+1]:null;
      if(!recordPath)throw Error('Agents verification requires a durable --record path.');
      const runId=`${process.env.ANNOUNCEMENT_RUN_ID??'manual-'+Date.now()}-verify`;
      const agent=new AnnouncementAgent({client:await createAgentsClient(key),config,runId,purpose:'api-verification',onRecord:record=>atomicJson(recordPath,record)});
      const result=await verifyOpenAi({feedDirectory:path.resolve(process.argv[2]??''),key,translator:changes=>agent.translate(changes),auditor:async changes=>{await agent.auditOfficial(changes);return {model:agent.summary.sessions.at(-1)?.model,usage:agent.summary.usage};}});
      await agent.markPublication('verification');console.log(JSON.stringify({...result,agent:agent.summary}));
    }else console.log(JSON.stringify(await verifyOpenAi({feedDirectory:path.resolve(process.argv[2]??''),key})));
  }
  catch(error){console.error(JSON.stringify({status:'failed',message:String(error.message).replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,700)}));process.exitCode=1;}
}

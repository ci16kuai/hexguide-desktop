import {readFile} from 'node:fs/promises';
import {readApiKey,atomicJson} from './maintenance.mjs';
import {AGENT_DEFINITION,createAgentsClient,safeError} from './agents.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export async function setupAgent({client,configPath}={}) {
  let existing;
  try{existing=JSON.parse(await readFile(configPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let agent;
  if(existing?.agentId)agent=await client.beta.agents.retrieve(existing.agentId);
  else {
    const matches=[];
    for await(const row of client.beta.agents.list({limit:100}))if(row.metadata?.application==='hexguide'&&row.metadata?.purpose==='numerical-announcements')matches.push(row);
    if(matches.length>1)throw Error('Multiple saved announcement agents found; select an agent ID explicitly.');
    agent=matches[0]??await client.beta.agents.create(AGENT_DEFINITION);
  }
  const config={schemaVersion:1,agentId:agent.id,name:agent.name,model:agent.model};
  await atomicJson(configPath,config);return config;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options={};const names={'--env-file':'envFile','--config':'configPath'};
  try{
    for(let i=2;i<process.argv.length;i+=2){if(!names[process.argv[i]]||!process.argv[i+1]||options[names[process.argv[i]]])throw Error('Invalid setup arguments.');options[names[process.argv[i]]]=process.argv[i+1];}
    if(!options.configPath)throw Error('An agent configuration output path is required.');
    console.log(JSON.stringify(await setupAgent({client:await createAgentsClient(await readApiKey(options.envFile)),configPath:options.configPath})));
  }catch(error){console.error(JSON.stringify({status:'failed',message:safeError(error)}));process.exitCode=1;}
}

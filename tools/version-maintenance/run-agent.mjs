import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readApiKey,atomicJson} from './maintenance.mjs';
import {AnnouncementAgent,createAgentsClient,safeError} from './agents.mjs';
import {runOfficialMaintenance} from './official-maintenance.mjs';

export async function runAgentMaintenance({client,config,runId=randomUUID(),githubRunUrl='',purpose='scheduled-check',maintenance=runOfficialMaintenance,...options}={}) {
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(runId))throw Error('Invalid maintenance run ID.');
  const recordPath=path.join(options.stateDirectory,'agent-runs',`${runId}.json`);
  const save=record=>atomicJson(recordPath,{schemaVersion:1,checkedAt:new Date().toISOString(),githubRunUrl,...record});
  const agent=new AnnouncementAgent({client,config,runId,githubRunUrl,purpose,onRecord:save});
  try {
    const receipt=await maintenance({...options,translator:changes=>agent.translate(changes),auditor:changes=>agent.auditOfficial(changes)});
    if(!agent.records.length)await agent.recordCheck(receipt);
    receipt.agent=agent.summary;
    await atomicJson(path.join(options.stateDirectory,'last-run.json'),receipt);
    await save({...agent.summary,outcome:'ready-to-publish'});
    return receipt;
  }catch(error) {
    await save({...agent.summary,outcome:'failed',error:safeError(error)});
    await agent.markPublication('failed').catch(()=>{});
    throw error;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options={},names={'--state-dir':'stateDirectory','--feed-dir':'feedDirectory','--env-file':'envFile','--config':'configPath','--run-id':'runId','--github-run-url':'githubRunUrl'};
  try {
    for(let i=2;i<process.argv.length;i+=2){if(!names[process.argv[i]]||!process.argv[i+1]||options[names[process.argv[i]]])throw Error('Invalid agent maintenance arguments.');options[names[process.argv[i]]]=process.argv[i+1];}
    if(!options.stateDirectory||!options.feedDirectory)throw Error('State and feed directories are required.');
    const config=JSON.parse(await readFile(options.configPath??new URL('./agent-config.json',import.meta.url),'utf8'));
    const client=await createAgentsClient(await readApiKey(options.envFile));delete options.configPath;
    console.log(JSON.stringify(await runAgentMaintenance({...options,client,config})));
  }catch(error){console.error(JSON.stringify({status:'failed',message:safeError(error)}));process.exitCode=1;}
}

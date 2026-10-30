import {readFile} from 'node:fs/promises';
import {readApiKey} from './maintenance.mjs';
import {createAgentsClient,safeError} from './agents.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export async function finalizeAgentRun({client,record,status}={}) {
  if(!['published','failed','verification'].includes(status))throw Error('Invalid publication status.');
  const rows=[],pending=[],sessionIds=new Set((record.sessions??[]).map(row=>row.sessionId).filter(Boolean));
  if((record.sessions??[]).some(row=>!row.sessionId)) {
    const recent=await client.beta.agents.sessions.list({agent_id:record.agentId,order:'desc',limit:100});
    for(const session of recent.data)if(session.agent?.id===record.agentId&&session.metadata?.run_id===record.runId)sessionIds.add(session.id);
  }
  for(const sessionId of sessionIds) {
    const row={sessionId};
    let session=await client.beta.agents.sessions.retrieve(row.sessionId);
    if(session.agent?.id!==record.agentId||session.metadata?.run_id!==record.runId)throw Error('Agent session does not belong to this maintenance run.');
    let cancellationRequested=false;
    if(status==='failed'&&['in_progress','requires_action'].includes(session.status)) {
      await client.beta.agents.sessions.events.create(row.sessionId,{events:[{type:'agent.session.input.cancel'}]});cancellationRequested=true;
      for(let attempt=0;attempt<3;attempt++){
        session=await client.beta.agents.sessions.retrieve(row.sessionId);
        if(!['in_progress','requires_action'].includes(session.status))break;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(['in_progress','requires_action'].includes(session.status))pending.push(row.sessionId);
    }
    await client.beta.agents.sessions.update(row.sessionId,{metadata:{...session.metadata,publication_status:status}});
    rows.push({sessionId:session.id,usage:session.usage??null,cancellationRequested,status:session.status});
  }
  if(pending.length)throw Error('Agent cancellation remains unconfirmed for '+pending.join(', '));
  return {status,sessions:rows};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const record=JSON.parse(await readFile(process.argv[2],'utf8')),status=process.argv[3];
    console.log(JSON.stringify(await finalizeAgentRun({client:await createAgentsClient(await readApiKey()),record,status})));
  }catch(error){console.error(JSON.stringify({status:'failed',message:safeError(error)}));process.exitCode=1;}
}

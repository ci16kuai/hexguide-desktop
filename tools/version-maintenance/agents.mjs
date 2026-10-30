import {EDITOR_INSTRUCTIONS,fieldPayload,translationSchema,validateTranslations} from './maintenance.mjs';
import {officialAuditSchema,validateOfficialAudit} from './official-maintenance.mjs';

export const AGENT_NAME='海克斯指南 · 英雄、装备与海克斯公告';
export const AGENT_DEFINITION={name:AGENT_NAME,model:'gpt-6-luna',instructions:EDITOR_INSTRUCTIONS,reasoning:{effort:'none'},tools:[],text:{verbosity:'low'},
  metadata:{application:'hexguide',purpose:'numerical-announcements',repository:'ci16kuai/hexguide-desktop',contract_version:'1'}};
export const safeError=error=>String(error?.message??error).replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,700);
export async function createAgentsClient(apiKey) {
  const {default:OpenAI}=await import('openai');
  return new OpenAI({apiKey,baseURL:'https://api.openai.com/v1',maxRetries:0,timeout:60000});
}
const sumUsage=records=>records.every(row=>row.usage)?records.reduce((sum,row)=>{
  for(const key of ['input_tokens','output_tokens','total_tokens'])sum[key]+=row.usage[key]??0;return sum;
},{input_tokens:0,output_tokens:0,total_tokens:0}):null;
export class AnnouncementAgent {
  constructor({client,config,runId,githubRunUrl='',purpose='scheduled-check',onRecord=async()=>{},timeoutMs=180000}={}) {
    if(!config?.agentId || !/^[A-Za-z0-9_-]{1,256}$/.test(config.agentId))throw Error('A saved announcement agent ID is required.');
    this.client=client;this.config=config;this.runId=String(runId);this.githubRunUrl=githubRunUrl;this.purpose=purpose;this.onRecord=onRecord;this.timeoutMs=timeoutMs;this.records=[];
  }
  get summary(){return {agentId:this.config.agentId,runId:this.runId,sessions:this.records.map(row=>({...row})),usage:sumUsage(this.records)};}
  async run(input,schema,kind) {
    let events,sessionId,turnId,completed=false;
    const metadata={application:'hexguide',run_id:this.runId,purpose:this.purpose,task:kind,publication_status:'pending',...(this.githubRunUrl?{github_run_url:this.githubRunUrl}:{})};
    const record={task:kind,status:'starting',sessionId:null,turnId:null,usage:null};this.records.push(record);
    try {
      await this.onRecord(this.summary);
      events=await this.client.beta.agents.sessions.create({agent_id:this.config.agentId,environment:{type:'none'},input:JSON.stringify(input),metadata,
        agent:{text:{format:{type:'json_schema',schema},verbosity:'low'},tools:[]},stream:true},{signal:AbortSignal.timeout(this.timeoutMs)});
      events.withResultCollection();
      for await(const event of events) {
        sessionId=event.session_id??event.session?.id??sessionId;turnId=event.turn_id??event.turn?.id??turnId;
        if(sessionId!==record.sessionId || turnId!==record.turnId){record.sessionId=sessionId??null;record.turnId=turnId??null;record.status='in_progress';await this.onRecord(this.summary);}
        if(event.type==='agent.session.requires_action')throw Error('Unexpected tool request from the announcement agent.');
      }
      const result=await events.finalResult();
      sessionId=result.session_id;turnId=result.turn_id;record.sessionId=sessionId;record.turnId=turnId;
      if(result.turn?.status!=='completed')throw Error(`Announcement agent turn ${result.turn?.status??'unknown'}.`);
      completed=true;record.status='completed';record.usage=result.turn.usage??null;record.model=this.config.model;
      try{const session=await this.client.beta.agents.sessions.retrieve(sessionId);record.usage=session.usage??record.usage;record.model=session.agent?.model??record.model;}catch{}
      await this.onRecord(this.summary);
      return {output:result.output_text,model:record.model,usage:record.usage,sessionId,turnId};
    }catch(error){
      record.sessionId=sessionId??record.sessionId;record.turnId=turnId??record.turnId;record.status='failed';record.error=safeError(error);
      if(sessionId&&!completed) {
        try {
          const session=await this.client.beta.agents.sessions.retrieve(sessionId);
          if(['in_progress','requires_action'].includes(session.status))await this.client.beta.agents.sessions.events.create(sessionId,{events:[{type:'agent.session.input.cancel'}]});
          record.usage=session.usage??record.usage;
        }catch{record.cancellationUnconfirmed=true;}
      }
      await this.onRecord(this.summary);throw error;
    }finally{events?.controller?.abort();}
  }
  async translate(changes) {
    const labels=Object.create(null);let model=this.config.model;
    for(let offset=0;offset<changes.length;offset+=64) {
      const batch=changes.slice(offset,offset+64),result=await this.run({task:'translate_fields',fields:fieldPayload(batch)},translationSchema(batch),'translate-fields');
      Object.assign(labels,validateTranslations(batch,result.output));model=result.model;
    }
    return {labels,model,usage:this.summary.usage,agent:this.summary};
  }
  async recordCheck(receipt) {
    const schema={type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['checked']},summary:{type:'string'}},required:['status','summary']};
    const resultData={...Object.fromEntries(['checkedAt','fromVersion','toVersion','changeCount','announcementId','reused'].filter(key=>Object.hasOwn(receipt,key)).map(key=>[key,receipt[key]])),warningCount:receipt.warnings?.length??0};
    const result=await this.run({task:'record_check',result:resultData,instruction:'仅确认检查回执。不要声称已发布；没有变化时明确无新增数值变化。'},schema,'check-receipt');
    const parsed=JSON.parse(result.output);
    if(parsed.status!=='checked'||typeof parsed.summary!=='string'||parsed.summary.length>500)throw Error('Invalid announcement check receipt.');
    return result;
  }
  async auditOfficial(changes){
    const acceptedKeys=[];const summaries=[];
    for(let offset=0;offset<changes.length;offset+=64){
      const batch=changes.slice(offset,offset+64),rows=batch.map(({key,kind,name,mode,text,ability})=>({key,kind,name,mode,text,...(ability?{ability}:{})}));
      const result=await this.run({task:'official_audit',excludedModes:['classic'],rows},officialAuditSchema(batch),'official-audit');
      const checked=validateOfficialAudit(batch,result.output);acceptedKeys.push(...checked.acceptedKeys);summaries.push(checked.summary);
    }
    return validateOfficialAudit(changes,{acceptedKeys,rejectedKeys:[],summary:summaries.join(' ').slice(0,700)});
  }
  async markPublication(status) {
    if(!['published','failed','verification'].includes(status))throw Error('Invalid publication status.');
    for(const record of this.records)if(record.sessionId) {
      const session=await this.client.beta.agents.sessions.retrieve(record.sessionId);
      await this.client.beta.agents.sessions.update(record.sessionId,{metadata:{...session.metadata,publication_status:status}});
    }
  }
}

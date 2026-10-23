/** Confirmed assistant state is shared by the main window and the tray service. */
export function createSessionSync({token,getState,applyState,request=fetch,onError=()=>{}}){
  let ready=false,applying=false,writing=false,closed=false,pending=null,generation=0;
  const signature=value=>JSON.stringify({owned:value.owned||[],route:value.route||'auto'});
  let known=signature(getState());
  const headers={'X-Hexguide-Session':token,'Content-Type':'application/json'};
  async function readResponse(response){if(!response.ok)throw Error(`本局记录同步暂不可用（${response.status}）`);return response.json();}
  function accept(value){
    if(!Array.isArray(value?.owned)||typeof value.route!=='string')return;
    const next=signature(value);known=next;
    if(signature(getState())!==next){applying=true;try{applyState(value);}finally{applying=false;}}
  }
  async function pull(){
    if(closed||writing||(ready&&pending))return;
    const started=generation;
    try{
      const value=await request('/api/session',{headers,cache:'no-store',signal:AbortSignal.timeout(4500)}).then(readResponse);
      if(!closed){ready=true;if(started===generation&&!writing&&!pending)accept(value);else if(pending)void flush();}
    }catch(error){onError(error.message);}
  }
  async function flush(){
    if(closed||!ready||writing||!pending)return;
    writing=true;const value=pending;pending=null;const started=generation;
    try{
      const response=await request('/api/session',{method:'POST',headers,body:JSON.stringify(value),signal:AbortSignal.timeout(4500)}).then(readResponse);
      if(!closed&&generation===started&&!pending)accept(response);
    }catch(error){if(!pending)pending=value;onError(error.message);}
    finally{writing=false;}
    if(pending&&generation!==started)void flush();
  }
  function publish(){
    if(closed||applying)return;
    const state=getState();const value={owned:[...(state.owned||[])],route:state.route||'auto'};
    if(signature(value)===known&&!pending)return;
    generation++;pending=value;void flush();
  }
  const timer=setInterval(()=>{if(pending)void flush();else void pull();},2200);
  void pull();
  return {publish,pull,close(){closed=true;clearInterval(timer);}};
}

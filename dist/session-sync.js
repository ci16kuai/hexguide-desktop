/** Confirmed assistant state is shared by the main window and the tray service. */
export function createSessionSync({token,getState,applyState,request=fetch,onError=()=>{}}){
  let ready=false,hydrated=false,applying=false,writing=false,closed=false,pending=null,generation=0,authoritative=null;
  const selection=value=>({owned:[...(value.owned||[])],route:value.route||'auto'});
  const signature=value=>JSON.stringify(selection(value));
  const sameOwned=(a,b)=>JSON.stringify(a.owned)===JSON.stringify(b.owned);
  const validSession=value=>Array.isArray(value?.owned)&&typeof value.route==='string'&&Number.isSafeInteger(value.revision)&&value.revision>=0&&Number.isSafeInteger(value.gameEpoch)&&value.gameEpoch>=0&&(value.gameId===null||typeof value.gameId==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(value.gameId));
  const initial=selection(getState());
  let local=selection(initial),known=signature(local);
  const headers={'X-Hexguide-Session':token,'Content-Type':'application/json'};
  const failure=response=>Error(`本局记录同步暂不可用（${response.status}）`);
  async function readSession(response){
    if(!response.ok)throw failure(response);
    const value=await response.json();
    if(!validSession(value))throw Error('本局记录同步返回了无效状态');
    return value;
  }
  function accept(value,{apply=true}={}){
    authoritative=value;known=signature(value);
    if(!apply)return;
    local=selection(value);
    if(signature(getState())!==known){applying=true;try{applyState(value);}finally{applying=false;}}
  }
  async function pull(){
    if(closed||writing||(ready&&pending))return;
    const started=generation;
    try{
      const value=await request('/api/session',{headers,cache:'no-store',signal:AbortSignal.timeout(4500)}).then(readSession);
      if(closed||writing)return;
      // A read started before a completed write cannot move its revision back.
      if(authoritative&&value.revision<authoritative.revision)return;
      const first=!hydrated;hydrated=true;
      ready=true;
      if(first&&pending?.touchesOwned&&!sameOwned(value,initial)){
        // Before hydration, local storage cannot establish which owned list is
        // current. Do not give an old full array the fresh server's guards.
        const edit=pending;pending=null;generation++;
        accept(value);
        if(edit.touchesRoute&&edit.route!==value.route){
          pending={...selection(value),route:edit.route,touchesOwned:false,touchesRoute:true};generation++;
        }
        onError('本局选择已更新，已同步最新记录；请核对后再修改。');
      }else accept(value,{apply:started===generation&&!pending});
      if(pending)void flush();
    }catch(error){if(!closed)onError(error.message);}
  }
  async function flush(){
    if(closed||!ready||writing||!pending||!authoritative)return;
    writing=true;const edit=pending;pending=null;const started=generation;
    const base=authoritative;
    // A route change carries no ownership intent. Preserve any choices that
    // arrived from background confirmation while that route edit was queued.
    const value={owned:edit.touchesOwned?[...edit.owned]:[...base.owned],route:edit.route,expectedRevision:base.revision,expectedGameEpoch:base.gameEpoch,expectedGameId:base.gameId};
    let conflict=false;
    try{
      const response=await request('/api/session',{method:'POST',headers,body:JSON.stringify(value),signal:AbortSignal.timeout(4500)});
      if(response.status===409){
        conflict=true;
        const payload=await response.json();
        const queued=pending;pending=null;generation++;
        const latestRoute=queued?.touchesRoute?queued:edit.touchesRoute?edit:null;
        const current=payload.session;
        if(!validSession(current)){ready=false;throw Error('本局记录已变化，正在重新同步');}
        if(!closed){
          accept(current);
          if(edit.touchesOwned||queued?.touchesOwned)onError('本局选择已更新，已同步最新记录；请核对后再修改。');
          // Never resubmit an old full owned array after a conflict. Only an
          // independent route edit can be retried within the same game.
          if(latestRoute&&current.gameEpoch===base.gameEpoch&&current.gameId===base.gameId&&latestRoute.route!==current.route){
            pending={...selection(current),route:latestRoute.route,touchesOwned:false,touchesRoute:true};generation++;
          }
        }
      }else{
        const current=await readSession(response);
        if(!closed)accept(current,{apply:generation===started&&!pending});
      }
    }catch(error){
      if(!conflict&&!pending)pending=edit;
      else if(!conflict)pending={...pending,touchesOwned:pending.touchesOwned||edit.touchesOwned,touchesRoute:pending.touchesRoute||edit.touchesRoute};
      if(conflict){pending=null;ready=false;}
      if(!closed)onError(error.message);
    }finally{writing=false;}
    if(closed)return;
    if(!ready)void pull();
    else if(pending&&generation!==started)void flush();
  }
  function publish(){
    if(closed||applying)return;
    const value=selection(getState());
    const touchesOwned=!sameOwned(value,local),touchesRoute=value.route!==local.route;
    local=value;
    if(signature(value)===known&&!pending)return;
    generation++;pending={...value,touchesOwned:touchesOwned||Boolean(pending?.touchesOwned),touchesRoute:touchesRoute||Boolean(pending?.touchesRoute)};void flush();
  }
  const timer=setInterval(()=>{if(pending&&ready)void flush();else void pull();},2200);
  void pull();
  return {publish,pull,close(){closed=true;clearInterval(timer);}};
}

import {buildLivePlan} from './adaptive.js';
import {shortItemEffect} from './statistics-view.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=n=>n!==null&&n!==undefined&&Number.isFinite(Number(n))?Math.round(Number(n)).toLocaleString('zh-CN'):'—';
const stat=(id,label,value)=>`<div data-ui-id="live-stat-${id}" data-ui-label="${label}数据"><dt>${label}</dt><dd>${value}</dd></div>`;
const emptyLive={connection:{status:'waiting',message:'等待英雄联盟客户端'},phase:'None',items:[],stats:{},augments:{status:'unavailable',ids:[]},mode:{known:false}};
const visual=(url,alt='',className='')=>`<img class="${className}" src="${esc(/^https:\/\//i.test(url||'')?url:'./assets/mark.svg')}" alt="${esc(alt)}" loading="lazy" onerror="this.onerror=null;this.src='./assets/mark.svg'">`;
const list=value=>Array.isArray(value)?value:[];
const sentence=value=>String(value||'').split(/(?<=[。！？])/u)[0].slice(0,140);
const rarityNames={silver:'白银',gold:'黄金',prismatic:'棱彩'};
function statisticsSources(plan){
  const info=plan.statistics||{},links=[];
  if(/^https:\/\/aramkit\.com(?:\/|$)/i.test(info.sourceUrl||''))links.push(`<a href="${esc(info.sourceUrl)}" target="_blank" rel="noopener noreferrer">ARAMKit ↗</a>`);
  if(/^https:\/\/(?:www\.)?op\.gg(?:\/|$)/i.test(info.reference?.sourceUrl||''))links.push(`<a href="${esc(info.reference.sourceUrl)}" target="_blank" rel="noopener noreferrer">OP.GG ↗</a>`);
  return links.length?`<p class="live-build-caption live-statistics-links">数据来源：${links.join(' · ')}</p>`:'';
}

function buildContent({plan,live,context,catalog,owned,usable,inferredIds=[]}){
  // The stage controls presentation even when a loading plan is temporarily unavailable.
  const preview=live.stage==='loading';
  const enemy=plan.enemyContext||{},fresh=usable&&live.teams?.status==='detected'&&enemy.status==='detected';
  const enemies=fresh?list(enemy.champions).map(player=>({...player,championId:player.id||player.championId,championName:player.name||player.championName})):[];
  const entry=item=>catalog?.data?.[String(item.id??item.itemID)];
  const roster=enemies.length?`<div class="live-enemy-grid${preview?' loading-roster':''}">${enemies.map(player=>{const c=context.getChampionById(player.championId);return `<article class="live-enemy"><div class="live-enemy-name">${visual(c?.icon||player.icon,'','live-enemy-avatar')}<div><strong>${esc(c?.name||player.championName||player.championId||'英雄待识别')}</strong>${preview?'':`<small>${Number.isFinite(player.level)&&player.level>0?`${number(player.level)} 级`:'等级未知'}</small>`}</div></div>${preview?'':`<div class="live-enemy-items">${list(player.items).length?list(player.items).map(item=>{const definition=entry(item),name=definition?.name||item.name||`装备 ${item.id??item.itemID}`;return `<span title="${esc(name)}">${visual(definition?.icon,name)}<small>${esc(name)}</small></span>`;}).join(''):'<small>尚未读取到装备</small>'}</div>`}</article>`;}).join('')}</div>`:'<p class="live-build-empty">等待读取本局敌方阵容与装备；读取前不推断对面抗性或治疗量。</p>';
  const allies=preview&&usable&&plan.allyContext?.status==='detected'?list(plan.allyContext.champions):[];
  const allyRoster=preview?`<section class="live-ally-context" aria-label="我方阵容"><h3>我方阵容</h3>${allies.length?`<div class="live-enemy-grid loading-roster">${allies.map(player=>{const c=context.getChampionById(player.id||player.championId);return `<article class="live-enemy"><div class="live-enemy-name">${visual(c?.icon||player.icon,'','live-ally-avatar')}<div><strong>${esc(c?.name||player.name||player.championName||player.id||player.championId||'英雄待识别')}</strong></div></div></article>`;}).join('')}</div>`:'<p class="live-build-empty">等待读取本局我方阵容。</p>'}</section>`:'';
  return `${preview?'':`<div class="live-build-current"><h3>已选海克斯</h3><div class="live-build-owned">${owned.length?owned.map(a=>`<span>${visual(a.icon)}${esc(a.name)}${inferredIds.includes(a.id)?'<small>推定已选（同图标）</small>':''}</span>`).join(''):'<p>等待游戏内选择；自动确认未记录时可在侧栏手动确认。</p>'}</div>${inferredIds.length?'<p class="live-build-caption">图标相同的候选存在歧义，此记录为助手推定；可在本局选择中移除并改选。</p>':''}</div>`}${allyRoster}<section class="live-enemy-context" aria-label="敌方阵容与装备"><h3>${preview?'敌方阵容':'敌方阵容与当前装备'}</h3><p class="live-build-caption">${esc(preview?'已读取敌方英雄；等级与装备将在入场后同步。':enemy.summary||'进入对局并确认本机英雄后自动更新。')}</p>${roster}${!preview&&list(enemy.signals).length?`<ul class="live-enemy-signals">${enemy.signals.map(signal=>`<li>${esc(typeof signal==='string'?signal:signal.summary||signal.reason||signal.label||'')}</li>`).join('')}</ul>`:''}</section><section class="live-build-items" aria-label="本局推荐装备"><h3>${preview?'开局出装预设':'本局装备选择'}</h3><p class="live-build-caption">${preview?'根据当前英雄与双方阵容推荐开局装备；入场后随对局状态更新。':'结合已选海克斯、已有装备与读取到的敌方构筑更新。'}</p>${usable&&plan.statistics?.summary?`<p class="live-build-caption live-statistics-source">${esc(plan.statistics.summary)}</p>${statisticsSources(plan)}`:''}${usable&&list(plan.buildItems).length?`<div class="live-item-grid">${plan.buildItems.map(item=>`<article class="live-item-card">${visual(item.icon,'','live-item-icon')}<div><h4>${esc(item.name)}</h4><p>${esc(item.effect||shortItemEffect(entry(item)?.description)||'装备效果资料待补充。')}</p><small>${esc(item.evidenceKind === 'confirmed-quest' ? item.reason : sentence(item.reason))}</small></div></article>`).join('')}</div>`:`<p class="live-build-empty">${usable?'当前条件下暂无可靠的对应装备资料。':'等待连接真实对局后生成本局出装。'}</p>`}</section>${preview?'':`<section class="live-next-augments" aria-label="后续关注海克斯"><h3>后续关注的海克斯</h3><p class="live-build-caption">根据当前构筑列出最多 6 个方向。下轮是否出现，以游戏实际选项为准。</p>${usable&&list(plan.nextAugments).length?`<div class="live-next-grid">${plan.nextAugments.slice(0,6).map(a=>`<article>${visual(a.icon,'','live-next-icon')}<div><h4>${esc(a.name)}<span>${esc(rarityNames[a.rarity]||'')}</span></h4><p>${esc(sentence(a.reason))}</p>${!preview&&list(a.cautions)[0]?`<small>${esc(sentence(a.cautions[0]))}</small>`:''}</div></article>`).join('')}</div>`:`<p class="live-build-empty">${usable?'等待更多可确认的海克斯联动条件。':'进入真实对局并确认选择后更新。'}</p>`}</section>`}`;
}

// The short lived token stays inside this local WebView session.
let token='';
if(location.hash.startsWith('#session=')){
  token=decodeURIComponent(location.hash.slice(9));
  sessionStorage.setItem('hexguide-local-session',token);
  history.replaceState(null,'','#live');
}else token=sessionStorage.getItem('hexguide-local-session')||'';

export function createLiveController(context){
  let live=emptyLive,follow=true,paused=false,lastGame='',timer=null,busy=false,catalog={};
  let authoritativeModel=null,pendingState=null,pendingBusy='',pendingEpochFloor=0;
  let sample=false,ocrAuto=false,ocrBusy=false,ocrResult=null,lastOcr=0,lastProposalAt=0,ocrNotice='',epoch=0,lastPhase='',lastTime=null,publishedOfferKey='';
  let manualRecognition=null,recognitionGeneration=0,toolsExpanded=false;
  // One opportunity per game, shared by loading and the first valid live plan.
  // Request cancellation (pause/demo) must not reopen a user's collapsed plan.
  let initialPlanHandled=false,loadingPresentation=false,offerRankingKey='';
  try{const boundary=JSON.parse(sessionStorage.getItem('hexguide-game-boundary')||'{}');lastGame=context.getGameId?.()||boundary.gameId||'';lastPhase=boundary.phase||'';lastTime=boundary.gameTime??null;}catch{}
  const phaseNames={None:'客户端未连接',Lobby:'游戏大厅',Matchmaking:'匹配中',ReadyCheck:'确认对局',ChampSelect:'英雄选择',InProgress:'对局进行中',GameStart:'正在载入',WaitingForStats:'等待结算',EndOfGame:'对局已结束'};
  fetch('./items.json').then(r=>r.ok?r.json():{}).then(x=>{catalog=x;refresh();}).catch(()=>{});
  function expireOffers(){if(!pendingState&&ocrResult?.proposals?.length&&Date.now()-lastProposalAt>=60000){ocrResult={status:'waiting',message:'识别结果已过期，等待当前三选一卡片。',proposals:[]};ocrNotice='';context.onOffersExpired?.();}}
  function refresh(){expireOffers();const nextLoading=!sample&&live.stage==='loading';if(nextLoading!==loadingPresentation){loadingPresentation=nextLoading;context.onStageChange?.();}if(location.hash==='#live')context.renderLive();}
  function ownedIds(values){if(!Array.isArray(values))return null;const ids=values.map(value=>typeof value==='string'?value:value?.id);return ids.every(id=>typeof id==='string'&&id.length>0)&&new Set(ids).size===ids.length?[...ids]:null;}
  function matchingAuthority({champion,owned,route,live:current}){
    const model=authoritativeModel,plan=model?.plan,session=context.getSessionContext?.();
    const actualOwned=ownedIds(owned),plannedOwned=ownedIds(plan?.ownedIds),serverOwned=ownedIds(model?.owned),sessionOwned=ownedIds(session?.owned);
    const fresh=value=>{const time=Date.parse(value||'');return Number.isFinite(time)&&Date.now()-time>=-5000&&Date.now()-time<=30000;};
    const revision=value=>Number.isSafeInteger(value)&&value>=0;
    const sameOwned=actualOwned&&[plannedOwned,serverOwned,sessionOwned].every(ids=>ids&&JSON.stringify(ids)===JSON.stringify(actualOwned));
    const valid=!paused&&!sample&&current.connection?.status==='connected'&&current.mode?.known===true&&current.mode.isMayhem===true
      &&typeof current.gameId==='string'&&current.gameId.length>0&&[model?.gameId,plan?.gameId,session?.gameId].every(id=>id===current.gameId)
      &&champion?.id===current.championId&&model?.champion?.id===current.championId&&plan?.championId===current.championId
      &&revision(session?.revision)&&model?.sessionRevision===session.revision&&plan?.sessionRevision===session.revision
      &&revision(session?.gameEpoch)&&model?.gameEpoch===session.gameEpoch&&plan?.gameEpoch===session.gameEpoch
      &&model?.stage===current.stage&&model?.phase===current.phase
      &&(current.stage==='loading'&&plan?.stage==='loading-preview'||current.stage==='live'&&current.phase==='InProgress'&&plan?.stage==='live')
      &&sameOwned&&route===session?.route&&model?.route===route&&plan?.route===route
      &&fresh(model?.updatedAt)&&fresh(plan?.generatedAt);
    if(!valid){authoritativeModel=null;return null;}
    return plan;
  }
  function currentPlan(options){return matchingAuthority(options)||buildLivePlan(options);}
  function pendingPrimary(){return pendingState?.groups.find(group=>group.pendingId===pendingState.primaryId)||null;}
  function showPending(){
    const group=pendingPrimary();
    if(group){const createdAt=typeof group.createdAt==='number'?group.createdAt:Date.parse(group.createdAt);ocrResult={status:'recognized',message:group.previousRound===true?`上一轮待确认 · 第 ${group.sequence} 轮；这里显示的是之前保留的候选，请补充确认。`:'本轮选项待确认；确认前会保留，并继续观察你打开的强化符文面板。',proposals:group.offers};lastProposalAt=Number.isFinite(createdAt)?createdAt:Date.now();publishOffers();}
    else{ocrResult=null;lastProposalAt=0;publishedOfferKey='';context.onOffersExpired?.();}
  }
  function acceptPending(model){
    if(!Array.isArray(model?.pendingOffers))return false;
    const revision=model.sessionRevision,pendingRevision=model.pendingRevision,gameEpoch=model.gameEpoch,gameId=model.gameId??null;
    const currentId=live.gameId||lastGame||context.getGameId?.()||null,session=context.getSessionContext?.();
    if(!Number.isSafeInteger(revision)||revision<0||!Number.isSafeInteger(pendingRevision)||pendingRevision<0||!Number.isSafeInteger(gameEpoch)||gameEpoch<pendingEpochFloor||gameId!==currentId)return false;
    if(session&&(session.gameId!==gameId||session.gameEpoch!==gameEpoch||revision<session.revision))return false;
    if(pendingState&&(pendingState.gameId!==gameId||gameEpoch<pendingState.gameEpoch||gameEpoch===pendingState.gameEpoch&&(revision<pendingState.revision||pendingRevision<pendingState.pendingRevision)))return false;
    const validOffers=offers=>Array.isArray(offers)&&offers.length===3&&offers.every(offer=>typeof offer?.id==='string'&&offer.id)&&new Set(offers.map(offer=>offer.id)).size===3;
    if(model.pendingOffers.some(group=>typeof group?.pendingId!=='string'||!group.pendingId||!Number.isSafeInteger(group.sequence)||!validOffers(group.offers)))return false;
    const offers=list(model.offers);
    if(offers.length&&!validOffers(offers))return false;
    const sameOffers=(a,b)=>JSON.stringify(a.map(offer=>offer.id))===JSON.stringify(b.map(offer=>offer.id));
    const matching=model.pendingOffers.filter(group=>sameOffers(group.offers,offers)),primary=matching.find(group=>group.active===true)||matching.at(-1);
    if(offers.length&&!primary)return false;
    const groups=model.pendingOffers.map(group=>({...group,offers:group.offers.map(offer=>({...offer}))}));
    pendingEpochFloor=gameEpoch;
    pendingState={gameId,gameEpoch,revision,pendingRevision,groups,primaryId:groups.some(group=>group.pendingId===primary?.pendingId)?primary.pendingId:null};
    showPending();return true;
  }
  function publishOffers(){
    const group=pendingPrimary(),proposals=pendingState?group?.offers||[]:ocrResult?.proposals||[],ids=proposals.map(x=>x.id);
    if(live.stage==='loading'||live.mode?.known&&live.mode.isMayhem===false||proposals.length!==3||new Set(ids).size!==3)return;
    if(!pendingState&&(ocrResult?.status!=='recognized'||live.phase!=='InProgress'||Date.now()-lastProposalAt>=60000))return;
    const key=JSON.stringify(pendingState?[pendingState.gameId,pendingState.gameEpoch,pendingState.revision,group.pendingId,...ids]:[epoch,...ids]);
    if(key===publishedOfferKey)return;
    if(context.onOffers(ids,{source:'ocr',pendingId:group?.pendingId,sequence:group?.sequence,previousRound:group?.previousRound===true,gameId:pendingState?.gameId,revision:pendingState?.revision,observedAt:new Date(lastProposalAt).toISOString()})!==false)publishedOfferKey=key;
  }
  function acceptManualRecognition(value){
    if(value===undefined)return manualRecognition===null;
    if(typeof value?.active!=='boolean'||!Number.isSafeInteger(value.requestId)||value.requestId<0)return false;
    // Ignore an older poll arriving after completion. A restarted backend can
    // reuse request numbers, so a later start time establishes a new request.
    const previous=manualRecognition,newerStart=Number.isFinite(value.startedAt)&&value.startedAt>(previous?.startedAt||0);
    if(previous&&!newerStart&&(value.requestId<previous.requestId||value.requestId===previous.requestId&&!previous.active&&value.active))return false;
    const changed=!previous||['requestId','startedAt','active','status','message'].some(key=>previous[key]!==value[key]);
    manualRecognition={...value};
    if(changed&&value.requestId>0)ocrNotice=typeof value.message==='string'?value.message:'';
    return true;
  }
  function sharedRecognitionActive(){
    return manualRecognition?.active===true&&(!Number.isFinite(manualRecognition.expiresAt)||Date.now()<manualRecognition.expiresAt);
  }
  function acceptSidebar(model){
    if(typeof model?.ocr?.enabled==='boolean')ocrAuto=model.ocr.enabled;
    authoritativeModel=model?.plan?model:null;
    if(live.stage==='loading'||['ChampSelect','WaitingForStats','EndOfGame'].includes(live.phase)){offerRankingKey='';return;}
    const observed=model?.ocr||{};
    if(Array.isArray(model?.pendingOffers)){
      if(!acceptPending(model))return;
      acceptManualRecognition(model.manualRecognition);
      const offers=list(model.offers),key=JSON.stringify([model.gameId,model.sessionRevision,model.champion?.id,offers]);
      if(offers.length===3&&key!==offerRankingKey&&matchingAuthority({champion:context.getChampion(),owned:context.getOwned(),route:context.getRoute(),live})){
        offerRankingKey=key;context.onOffers(offers.map(offer=>offer.id),{source:'ocr',pendingId:pendingPrimary()?.pendingId,sequence:pendingPrimary()?.sequence,previousRound:pendingPrimary()?.previousRound===true,gameId:model.gameId,revision:model.sessionRevision,forceRerank:true});
      }
      return;
    }
    // A legacy scan has a short display lifetime. Server pending groups are
    // scoped above and survive unreadable frames, death and temporary outages.
    if(pendingState)return;
    const observedAt=Date.parse(observed.observedAt||'');
    if(observed.proposals?.length&&Number.isFinite(observedAt)&&Date.now()-observedAt<60000){
      if(observedAt>lastProposalAt&&observedAt<=Date.now()+5000){ocrResult={status:observed.status||'recognized',message:observed.message||'已识别本轮选项；屏幕自动确认为实验功能，未记录时可手动确认。',proposals:observed.proposals};lastProposalAt=observedAt;ocrNotice='';publishOffers();}
      const offers=list(model?.offers),key=JSON.stringify([model?.gameId,model?.sessionRevision,model?.champion?.id,
        offers.map(offer=>[offer.id,offer.rank,offer.rankingEvidence?.trusted,offer.rankingEvidence?.winRate,offer.rankingEvidence?.source])]);
      if(offers.length===3&&key!==offerRankingKey&&matchingAuthority({champion:context.getChampion(),owned:context.getOwned(),route:context.getRoute(),live})){
        offerRankingKey=key;context.onOffers(offers.map(offer=>offer.id),{source:'ocr',forceRerank:true});
      }
    }else if(!ocrResult?.proposals?.length&&observed.message){offerRankingKey='';ocrResult={status:observed.status,message:observed.message,proposals:[]};}
  }
  async function syncSidebar(){
    const started=epoch;
    try{
      const r=await fetch('/api/sidebar',{headers:{'X-Hexguide-Session':token},signal:AbortSignal.timeout(4500),cache:'no-store'});
      if(r.ok){const model=await r.json();if(started===epoch&&!sample&&!paused){acceptSidebar(model);refresh();}}
      else if(started===epoch){authoritativeModel=null;refresh();}
    }catch{if(started===epoch){authoritativeModel=null;refresh();}/* Live observations remain usable when the sidebar is unavailable. */}
  }
  async function setAuto(enabled){
    const previous=ocrAuto,started=epoch;ocrAuto=enabled;refresh();
    try{
      const r=await fetch('/api/sidebar/ocr',{method:'POST',headers:{'X-Hexguide-Session':token,'Content-Type':'application/json'},body:JSON.stringify({enabled}),signal:AbortSignal.timeout(4500)});
      if(!r.ok)throw Error('后台扫描设置未能保存，请重试。');
      const model=await r.json();if(started!==epoch||sample||paused)return;
      acceptSidebar(model);ocrNotice=enabled?'后台扫描已开启，收进托盘后仍会运行。':'后台扫描已关闭。';
    }catch(e){if(started===epoch&&!sample&&!paused){ocrAuto=previous;ocrNotice=e.message;}}
    refresh();
  }
  async function confirmPending(pendingId,id,renderedScope){
    const group=pendingState?.groups.find(value=>value.pendingId===pendingId);
    if(!group?.offers.some(offer=>offer.id===id)||pendingBusy||sample||live.stage==='loading')return;
    if(paused){ocrNotice='请先恢复同步，再确认待选海克斯。';refresh();return;}
    if(renderedScope&&(renderedScope.gameId!==pendingState.gameId||renderedScope.revision!==pendingState.revision)){ocrNotice='本局选择已变化，已重新同步；请核对后再确认。';void syncSidebar();refresh();return;}
    const started=epoch,scope={gameId:pendingState.gameId,revision:pendingState.revision};recognitionGeneration++;pendingBusy=pendingId;ocrNotice='';refresh();
    try{
      const response=await fetch('/api/session/confirm',{method:'POST',headers:{'X-Hexguide-Session':token,'Content-Type':'application/json'},body:JSON.stringify({id,pendingId,...scope}),signal:AbortSignal.timeout(4500)});
      if(started!==epoch||sample||paused)return;
      if(!response.ok)throw Error(response.status===409?'本局选择已变化，已重新同步；请核对后再确认。':`记录暂不可用（${response.status}）`);
      const model=await response.json();
      if(started!==epoch||sample||paused)return;
      acceptSidebar(model);context.onPendingConfirmed?.();
    }catch(error){if(started===epoch&&!sample&&!paused){ocrNotice=error.message;void syncSidebar();}}
    finally{pendingBusy='';refresh();}
  }
  async function resetPending(scope){
    if(pendingBusy)return;
    const started=epoch;recognitionGeneration++;pendingBusy='reset';ocrNotice='';refresh();
    try{
      const response=await fetch('/api/session/reset',{method:'POST',headers:{'X-Hexguide-Session':token,'Content-Type':'application/json'},body:JSON.stringify(scope),signal:AbortSignal.timeout(4500)});
      if(started!==epoch||sample)return;
      if(!response.ok)throw Error(response.status===409?'本局选择已变化，已重新同步；请核对后再重置。':`重置暂不可用（${response.status}）`);
      const model=await response.json();if(started!==epoch||sample)return;
      acceptSidebar(model);context.onSessionReset?.();
    }catch(error){if(started===epoch&&!sample){ocrNotice=error.message;if(!paused)void syncSidebar();}}
    finally{pendingBusy='';refresh();}
  }
  function apply(next){
    const newId=next.gameId&&lastGame&&next.gameId!==lastGame;
    const newSelect=next.phase==='ChampSelect'&&lastPhase&&lastPhase!=='ChampSelect';
    const timeReset=next.phase==='InProgress'&&Number.isFinite(next.gameTime)&&next.gameTime>0&&Number.isFinite(lastTime)&&next.gameTime<lastTime-40;
    const enteredLoading=next.stage==='loading'&&live.stage!=='loading';
    live=next;
    if(newId||newSelect||timeReset){if(pendingState)pendingEpochFloor=pendingState.gameEpoch+1;epoch++;manualRecognition=null;initialPlanHandled=false;lastTime=null;pendingState=null;pendingBusy='';ocrResult=null;lastProposalAt=0;ocrNotice='';publishedOfferKey='';authoritativeModel=null;context.onNewGame();}
    if(enteredLoading)authoritativeModel=null;
    if(next.phase&&next.phase!=='None')lastPhase=next.phase;
    if(Number.isFinite(next.gameTime)&&(next.gameTime>0||!Number.isFinite(lastTime)))lastTime=next.gameTime;
    const ended=['WaitingForStats','EndOfGame'].includes(next.phase);
    if(enteredLoading||ended){manualRecognition=null;recognitionGeneration++;}
    if(enteredLoading||ended||!pendingState&&(next.phase!=='InProgress'||next.stage==='loading')&&ocrResult?.proposals?.length){if(pendingState)pendingEpochFloor=pendingState.gameEpoch+1;pendingState=null;ocrResult=null;lastProposalAt=0;publishedOfferKey='';context.onOffersExpired?.();}
    if(next.gameId){lastGame=next.gameId;context.onGameId?.(next.gameId);}
    try{sessionStorage.setItem('hexguide-game-boundary',JSON.stringify({gameId:lastGame,phase:lastPhase,gameTime:lastTime}));}catch{}
    if(follow&&next.championId)context.onChampion(String(next.championId));
    if(!initialPlanHandled&&!paused&&!sample){
      const isLoading=next.stage==='loading',owned=isLoading?[]:context.getOwned();
      const initialPlan=currentPlan({champion:context.getChampion(),owned,route:isLoading?'auto':context.getRoute(),live:next,augments:context.getAugments(),itemsCatalog:catalog,champions:context.getChampions?.()||[]});
      const earlyLive=next.mode?.known===true&&next.mode.isMayhem===true&&next.connection?.status==='connected'&&next.phase==='InProgress'&&next.championSource==='live-client'&&next.championId===context.getChampion()?.id&&Number.isFinite(next.gameTime)&&next.gameTime>=0&&next.gameTime<=30&&!owned.length&&initialPlan.stage==='live'&&initialPlan.enemyContext?.status==='detected'&&initialPlan.enemyContext.source==='live-client'&&list(initialPlan.enemyContext.champions).length&&list(initialPlan.buildItems).length;
      if(initialPlan.stage==='loading-preview'||earlyLive){
        initialPlanHandled=true;
        // Existing callback only expands the plan; early live keeps its live title.
        context.onLoadingPreview?.();
      }else if(owned.length||next.championSource==='live-client'&&Number.isFinite(next.gameTime)&&next.gameTime>30)initialPlanHandled=true;
    }
    refresh();
  }
  async function poll(){
    if(busy||paused||sample)return;
    busy=true;const requestEpoch=epoch;
    try{
      if(!token)throw Error('请通过桌面程序启动，以连接本机游戏。');
      const r=await fetch('/api/live',{headers:{'X-Hexguide-Session':token},signal:AbortSignal.timeout(4500),cache:'no-store'});
      if(!r.ok)throw Error(r.status===401?'本机会话已失效，请重新打开桌面程序。':`连接暂不可用（${r.status}）`);
      const next=await r.json();if(requestEpoch===epoch&&!paused&&!sample){apply(next);await syncSidebar();}
    }catch(e){if(requestEpoch===epoch&&!paused&&!sample){authoritativeModel=null;live={...emptyLive,connection:{status:'waiting',message:e.message.includes('桌面程序')||e.message.includes('会话')?e.message:'本地助手暂未连接，正在重试'}};if(!pendingState){ocrResult=null;context.onOffersExpired?.();}refresh();}}
    finally{busy=false;}
  }
  async function scan(delay=false){
    if(ocrBusy||sharedRecognitionActive()||pendingBusy||sample||paused||live.stage==='loading')return;
    ocrBusy=true;lastOcr=Date.now();const scanEpoch=epoch,generation=recognitionGeneration;
    // Manual choices/reset take precedence over an in-flight capture response.
    const current=()=>scanEpoch===epoch&&generation===recognitionGeneration&&!sample&&!paused&&live.stage!=='loading';
    refresh();
    try{
      if(delay){ocrNotice='请在 3 秒内切回游戏，并保持三选一卡片或六格强化符文栏展开。';refresh();await new Promise(resolve=>setTimeout(resolve,3000));}
      if(!current())return;
      if(sharedRecognitionActive()){ocrNotice=manualRecognition.message||'正在识别当前画面，请保持待识别内容可见。';return;}
      ocrNotice='正在识别当前画面，请保持三选一卡片或六格强化符文栏展开。';refresh();
      const r=await fetch('/api/recognize-once',{method:'POST',headers:{'X-Hexguide-Session':token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
      if(!r.ok)throw Error(`识别暂不可用（${r.status}）`);
      const result=await r.json();if(current()){
        if(!acceptManualRecognition(result.manualRecognition))return;
        const proposals=result.status==='recognized'?list(result.proposals):[];
        ocrNotice=result.message||'本次未识别到可确认的海克斯；待确认选项仍会保留。';
        if(result.status==='confirmed')context.onPendingConfirmed?.();
        if(!pendingState&&proposals.length){ocrResult={status:'recognized',message:ocrNotice,proposals};lastProposalAt=Date.now();publishOffers();}
        else if(!pendingState&&!ocrResult?.proposals?.length)ocrResult={status:result.status,message:ocrNotice,proposals:[]};
      }
    }catch(e){if(current()){ocrNotice=e.name==='TimeoutError'?'本次识别超时，请重试或手动填入。':e.message;if(!ocrResult?.proposals?.length)ocrResult={status:'unavailable',message:ocrNotice,proposals:[]};}}
    finally{if(current())await syncSidebar();ocrBusy=false;refresh();}
  }
  timer=setInterval(poll,2200);poll();
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  document.addEventListener('click',e=>{
    const target=e.target.closest('[data-live-action]'),action=target?.dataset.liveAction;
    if(action==='refresh')poll();
    if(action==='tools-toggle'){toolsExpanded=!toolsExpanded;refresh();}
    if(action==='pause'){epoch++;paused=!paused;authoritativeModel=null;refresh();if(!paused)poll();}
    if(action==='follow'){follow=!follow;context.onStatusChange?.();if(follow&&live.championId)context.onChampion(live.championId);refresh();}
    if(action==='ocr-scan')scan(true);
    if(action==='ocr-auto')void setAuto(!ocrAuto);
    if(action==='ocr-confirm')publishOffers();
    if(action==='pending-confirm')void confirmPending(target.dataset.pendingId,target.dataset.id,{gameId:target.dataset.gameId||null,revision:Number(target.dataset.revision)});
    if(action==='build-toggle'){context.onBuildToggle?.();refresh();}
    if(action==='sample'){
      epoch++;sample=!sample;manualRecognition=null;pendingState=null;pendingBusy='';ocrResult=null;lastProposalAt=0;ocrNotice='';publishedOfferKey='';authoritativeModel=null;context.onOffersExpired?.();
      if(sample){
        live={connection:{status:'connected',message:'演示数据，未连接真实对局'},phase:'InProgress',championId:'Ahri',level:11,gameTime:660,currentGold:1450,stats:{abilityPower:175,attackDamage:72,abilityHaste:35,armor:55,maxHealth:1850},items:[{id:6655,name:'卢登的回声',count:1}],augments:{status:'unavailable',ids:[]},mode:{known:true,isMayhem:true,queueId:2400},observedAt:new Date().toISOString()};
      }else{live=emptyLive;poll();}
      refresh();
    }
  });
  return {
    isLoadingPreview(){return !sample&&live.stage==='loading';},
    manualChampion(){follow=false;},
    resetSession(){const session=context.getSessionContext?.(),scope=session&&(!pendingState||session.gameEpoch!==pendingState.gameEpoch||session.revision>=pendingState.revision)?session:pendingState;if(sample||!scope||!Number.isSafeInteger(scope.revision))return false;void resetPending({gameId:scope.gameId,revision:scope.revision});return true;},
    confirmCandidate(id,pendingId,renderedScope){if(!pendingId){if(!pendingState)return false;ocrNotice='待确认选项已更新，请核对后再确认。';void syncSidebar();refresh();return true;}void confirmPending(pendingId,id,renderedScope);return true;},
    confirmedSelection(){
      recognitionGeneration++;authoritativeModel=null;publishedOfferKey='';ocrNotice='';
      // Only the server knows which round was confirmed. A candidate that is
      // already owned can also occur in a different unresolved round.
      if(!pendingState){ocrResult=null;lastProposalAt=0;}
      if(!paused&&!sample)void syncSidebar();
    },
    getOfferRanking(ids){
      if(!Array.isArray(ids)||ids.length!==3||new Set(ids).size!==3)return null;
      if(!matchingAuthority({champion:context.getChampion(),owned:context.getOwned(),route:context.getRoute(),live}))return null;
      const offers=list(authoritativeModel?.offers);
      if(offers.length!==3||!offers.every(offer=>ids.includes(offer.id)))return null;
      return offers.map(offer=>({id:offer.id,rankingEvidence:offer.rankingEvidence?{...offer.rankingEvidence}:null}));
    },
    html(){
      const c=sample?context.getChampionById('Ahri'):context.getChampion(),loading=!sample&&live.stage==='loading',owned=sample||loading?[]:context.getOwned(),route=sample||loading?'auto':context.getRoute();
      expireOffers();
      const olderPending=sample||loading?[]:list(pendingState?.groups).filter(group=>group.pendingId!==pendingState.primaryId);
      const connected=live.connection?.status==='connected';
      const usable=connected&&!sample&&!paused&&live.championId===c?.id&&live.championSource==='live-client'&&Number.isFinite(live.gameTime);
      const loadingUsable=connected&&!sample&&!paused&&live.championId===c?.id&&live.championSource==='loading-screen'&&loading;
      const planLive=sample?live:usable||loadingUsable?live:{...emptyLive,mode:live.mode,phase:live.phase,connection:{status:'waiting'}};
      const plan=currentPlan({champion:c,owned,route,live:planLive,augments:context.getAugments(),itemsCatalog:catalog,champions:context.getChampions?.()||[]});
      const preview=loading,expanded=Boolean(context.getBuildExpanded?.()),selected=loading?null:context.getSelectedAugment?.();
      if(sample){plan.label='演示数据 · 机制参考';plan.summary='虚构阿狸对局示例，独立于你的英雄与已选海克斯。'+plan.summary.replace('已结合当前英雄、自身面板与装备','使用示例面板与装备');plan.context=(plan.context||[]).map(x=>'演示：'+x.replace('本局自动读取','示例英雄').replace('已读取装备','示例装备'));}
      const stats=usable||sample?live.stats||{}:{};
      const status=sample?'演示模式':paused?'同步已暂停':connected?'已连接本机游戏':'等待连接';
      const mode=live.mode?.known?(live.mode.isMayhem?'海克斯大乱斗':'当前模式不是海克斯大乱斗'):'游戏模式待确认';
      const recognitionBusy=ocrBusy||sharedRecognitionActive(),notice=!ocrBusy&&sharedRecognitionActive()?manualRecognition.message||'正在识别当前画面，请保持待识别内容可见。':ocrNotice;
      const recognitionNotice=notice===ocrResult?.message?'':notice;
      const previewItems=!sample&&(usable||loadingUsable)&&['live','loading-preview'].includes(plan.stage)?list(plan.buildItems).slice(0,2):[];
      return `<div class="page-intro live-intro" data-ui-id="live-intro" data-ui-label="实战页开场区域" data-ui-container="live-intro"><div data-ui-id="live-intro-copy" data-ui-label="实战页标题文案" data-ui-container="live-intro-copy"><h1 data-ui-id="live-title" data-ui-label="实战页大标题">我的这一局</h1><span class="live-kicker" data-ui-id="live-kicker" data-ui-label="桌面版版本提示">Windows 桌面版 1.18.1 · 测试版</span><p data-ui-id="live-subtitle" data-ui-label="实战页说明文字">${sample?'演示布局 · 不代表正在读取你的对局。':paused?'同步已暂停；恢复后继续更新本局状态。':loading?'正在载入：先看双方阵容与开局出装。':connected?'本局状态自动同步，选择确认后更新推荐。':'打开英雄联盟后自动尝试同步；当前英雄仅作离线参考。'}</p></div><span class="local-badge" data-ui-id="live-local-badge" data-ui-label="仅在本机处理标签">仅在本机处理</span></div>
      <section class="live-connection ${connected?'connected':''}" aria-label="游戏连接状态" data-ui-id="live-connection" data-ui-label="游戏连接状态栏" data-ui-container="live-connection"><div class="connection-symbol" data-ui-id="live-connection-symbol" data-ui-label="连接状态图标">${connected?'◉':'◌'}</div><div data-ui-id="live-connection-copy" data-ui-label="连接状态文字" data-ui-container="live-connection-copy"><strong data-ui-id="live-connection-title" data-ui-label="连接状态标题">${esc(status)}</strong><p data-ui-id="live-connection-message" data-ui-label="连接状态详情">${esc(live.connection?.message||'等待英雄联盟游戏启动')} · ${esc(phaseNames[live.phase]||live.phase||'等待对局')}</p></div><button class="text-button" data-live-action="pause" data-ui-id="live-pause" data-ui-label="暂停恢复同步按钮">${paused?'恢复同步':'暂停同步'}</button><button class="secondary-button" data-live-action="refresh" data-ui-id="live-refresh" data-ui-label="重新检测按钮" ${sample?'disabled':''}>重新检测</button></section>
      <section class="live-champion" data-ui-id="live-champion" data-ui-label="实战英雄信息" data-ui-container="live-champion"><div class="live-champion-name" data-ui-id="live-champion-identity" data-ui-label="英雄头像与名称" data-ui-container="live-champion-identity">${c?`<img src="${esc(c.icon)}" alt="" onerror="this.style.display='none'" data-ui-id="live-champion-avatar" data-ui-label="英雄头像">`:''}<div data-ui-id="live-champion-copy" data-ui-label="英雄名称文字" data-ui-container="live-champion-copy"><span data-ui-id="live-champion-mode" data-ui-label="英雄模式标签">${sample?'演示英雄 · '+esc(mode):preview?'本局英雄 · 正在载入':usable?esc(mode):connected?'参考英雄 · 等待对局核验':'离线参考英雄 · 未同步对局'}</span><h2 data-ui-id="live-champion-name" data-ui-label="英雄姓名与称号">${esc(c?.name||'请选择英雄')}<small>${esc(c?.title||'')}</small></h2></div></div><div class="live-follow" data-ui-id="live-follow" data-ui-label="自动跟随英雄设置" data-ui-container="live-follow"><button class="follow-button ${follow?'on':''}" data-live-action="follow" aria-pressed="${follow}" data-ui-id="live-follow-button" data-ui-label="自动跟随英雄按钮">${follow?'✓ 自动跟随英雄':'手动选择英雄'}</button><small data-ui-id="live-follow-hint" data-ui-label="跟随英雄说明">${follow?'选人阶段与进入游戏后同步':'切换为自动后跟随真实英雄'}</small>${loading?'':'<button class="text-button live-session-link" data-action="focus-session">手动修正 / 离线参考</button>'}</div></section>
      ${sample?'<div class="live-notice" data-ui-id="live-sample-notice" data-ui-label="演示模式提示">这是一组虚构示例，用于预览实战布局，不代表正在读取你的对局。退出演示后恢复本机检测。</div>':''}
      ${connected&&!live.mode?.isMayhem?`<div class="live-notice" data-ui-id="live-mode-notice" data-ui-label="当前模式提示">${esc(mode)}。${loading?'先查看本局阵容与装备资料。':'仍可查看自身数据；下方海克斯建议仅作为模式资料参考。'}</div>`:''}
      <section id="live-build" class="live-plan ${expanded?'expanded':'collapsed'}${preview?' loading-preview':''}" tabindex="-1" aria-label="${loading?'开局出装推荐':'本局出装与后续海克斯'}" data-ui-id="live-plan" data-ui-label="推荐玩法区域" data-ui-container="live-plan"><div class="section-heading" data-ui-id="live-plan-heading" data-ui-label="推荐玩法标题栏" data-ui-container="live-plan-heading"><div data-ui-id="live-plan-copy" data-ui-label="推荐玩法标题文字" data-ui-container="live-plan-copy"><h2 data-ui-id="live-plan-title" data-ui-label="推荐玩法标题">${loading?'开局前预览':live.mode?.known&&live.mode.isMayhem===false?esc(plan.title):'本局出装与后续海克斯'}</h2><p class="section-subtitle" data-ui-id="live-plan-summary" data-ui-label="推荐玩法说明">${sample?esc(plan.title)+' · 演示预览':paused?'同步已暂停，恢复后更新推荐。':loading?'已读取本局阵容，先查看开局出装；入场后自动更新。':!usable?'连接对局后，结合本局装备与已确认海克斯更新。':selected?'已选择「'+esc(selected.name)+'」，推荐随本局状态更新。':'在候选卡或侧栏确认后，展开查看对应的装备与后续联动。'}</p></div><span class="subtle-tag" data-ui-id="live-plan-badge" data-ui-label="推荐依据标签">${esc(plan.label||'机制参考')}</span><button class="text-button live-build-toggle" data-live-action="build-toggle" aria-expanded="${expanded}" aria-controls="live-build-details">${expanded?'收起推荐':'展开推荐'}</button></div>
      <div class="live-build-preview" aria-label="当前出装参考">
        ${previewItems.length?`<p class="live-build-preview-label">${loading?'开局装备参考':'当前出装参考'} · 完整理由见展开详情</p><div class="live-build-preview-items">${previewItems.map(item=>`<div>${visual(item.icon,'','live-item-icon')}<strong>${esc(item.name)}</strong></div>`).join('')}</div>`:`<p class="live-build-preview-empty">${sample?'演示预览不作为本局装备建议。':paused?'同步已暂停，恢复后更新本局装备参考。':!usable&&!loadingUsable?'等待连接真实对局后生成本局出装。':'当前条件下暂无可靠的对应装备资料。'}</p>`}
      </div>
      <div class="plan-context" ${expanded&&!preview?'':'hidden'} data-ui-id="live-plan-context" data-ui-label="推荐参考条件">${(loading?[]:plan.context||[]).map(x=>`<span>${esc(x)}</span>`).join('')}</div>
      <div class="live-routes" hidden data-ui-id="live-plan-routes" data-ui-label="推荐玩法卡片" data-ui-container="live-plan-routes">${(loading?[]:plan.choices||[]).map((choice,index)=>`<article class="live-route" data-ui-id="live-route-${index+1}" data-ui-label="推荐玩法卡片 ${index+1}"><h3>${esc(choice.title)}</h3><ul>${(choice.why||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>${choice.items?.length?`<div class="route-items">${choice.items.map(i=>`<div><strong>${esc(i.name)}</strong><span>${esc(i.reason)}</span></div>`).join('')}</div>`:''}<p class="route-watch">${(choice.watch||[]).map(esc).join(' ')}</p></article>`).join('')}</div><div id="live-build-details" class="live-build-details" ${expanded?'':'hidden'}>${buildContent({plan,live,context,catalog,owned,usable:(usable||preview)&&!sample,inferredIds:!loading&&matchingAuthority({champion:c,owned,route,live})?list(authoritativeModel?.owned).filter(a=>a.inferred===true).map(a=>a.id):[]})}</div></section>
      ${olderPending.length?`<details class="ocr-panel live-pending-rounds" data-disclosure-key="pending-rounds" aria-label="较早轮次待确认"><summary id="live-pending-summary">较早轮次待确认 · ${olderPending.length} 轮</summary><p>新一轮显示在本轮三选一；旧轮次会保留到你补记已选。</p>${olderPending.map(group=>`<div class="ocr-result" data-pending-id="${esc(group.pendingId)}"><strong>第 ${esc(group.sequence)} 轮 · 待确认</strong><div class="ocr-proposals">${group.offers.map(offer=>`<button class="secondary-button" data-live-action="pending-confirm" data-pending-id="${esc(group.pendingId)}" data-id="${esc(offer.id)}" data-game-id="${esc(pendingState.gameId||'')}" data-revision="${pendingState.revision}" ${pendingBusy||paused||owned.some(augment=>augment.id===offer.id)?'disabled':''}>${owned.some(augment=>augment.id===offer.id)?'已在本局 · ':'我选了'}「${esc(offer.name||offer.id)}」</button>`).join('')}</div></div>`).join('')}</details>`:''}
      <button type="button" class="live-tools-toggle text-button" data-live-action="tools-toggle" aria-expanded="${toolsExpanded}" aria-controls="live-observed-stats live-observed-equipment${loading?'':' live-recorded-augments live-recognition-tools live-additional-actions'}">${toolsExpanded?'收起实战信息与工具':'实战信息与识别工具'}<span aria-hidden="true">${toolsExpanded?'−':'+'}</span></button>
      <dl id="live-observed-stats" class="live-stats" ${toolsExpanded?'':'hidden'} data-ui-id="live-stats" data-ui-label="实战数据面板" data-ui-container="live-stats">${stat('level','等级',usable||sample?number(live.level):'—')}${stat('time','游戏时间',usable||sample?`${Math.floor((live.gameTime||0)/60)}:${String(Math.floor((live.gameTime||0)%60)).padStart(2,'0')}`:'—')}${stat('ap','法术强度',number(stats.abilityPower))}${stat('ad','攻击力',number(stats.attackDamage))}${stat('haste','技能急速',number(stats.abilityHaste))}${stat('gold','当前金币',usable||sample?number(live.currentGold):'—')}</dl>
      <div id="live-observed-equipment" class="live-equipment" ${toolsExpanded?'':'hidden'} data-ui-id="live-equipment" data-ui-label="当前装备区域" data-ui-container="live-equipment"><span data-ui-id="live-equipment-label" data-ui-label="当前装备标题">当前装备</span><div data-ui-id="live-equipment-items" data-ui-label="装备列表">${(usable||sample)&&live.items?.length?live.items.map(i=>`<span class="equipped-item">${esc(i.name||`物品 ${i.id}`)}${i.count>1?` ×${number(i.count)}`:''}</span>`).join(''):'<small>进入对局后自动显示；未连接时不填入示例装备。</small>'}</div></div>
      ${loading?'':`<div id="live-recorded-augments" class="live-augment-note" ${toolsExpanded?'':'hidden'} data-ui-id="live-owned-note" data-ui-label="已确认海克斯说明" data-ui-container="live-owned-note"><span data-ui-id="live-owned-symbol" data-ui-label="已确认海克斯图标">◇</span><div data-ui-id="live-owned-copy" data-ui-label="已确认海克斯文字" data-ui-container="live-owned-copy"><strong data-ui-id="live-owned-title" data-ui-label="已确认海克斯数量">已确认 ${owned.length} 个海克斯</strong><p data-ui-id="live-owned-text" data-ui-label="海克斯自动确认与手动纠正说明">后台识别升级的三个选项。实验性屏幕观察会核对游戏内点击、选择反馈和卡片收起，证据完整时记录并更新推荐；未记录时可在侧栏手动确认。</p></div><button class="secondary-button" data-action="pick-owned" data-ui-id="live-owned-button" data-ui-label="确认已选海克斯按钮" ${loading?'disabled':''}>确认已选</button></div>`}
      ${loading?'':`<section id="live-recognition-tools" class="ocr-panel" ${toolsExpanded?'':'hidden'} aria-label="三选一卡片识别" data-ui-id="live-ocr" data-ui-label="三选一卡片识别区域" data-ui-container="live-ocr"><div data-ui-id="live-ocr-copy" data-ui-label="卡片识别说明" data-ui-container="live-ocr-copy"><strong data-ui-id="live-ocr-title" data-ui-label="卡片识别标题">识别海克斯 <small>实验功能</small></strong><p data-ui-id="live-ocr-help" data-ui-label="后台识别说明">点击识别一次后有 3 秒切回游戏，请保持三选一卡片或六格强化符文栏展开。候选仅用于比较；六格核对确认后才更新已选。自动扫描可单独开启，图片不保留。</p></div><div class="ocr-actions" data-ui-id="live-ocr-actions" data-ui-label="卡片识别操作按钮" data-ui-container="live-ocr-actions"><button class="secondary-button" data-live-action="ocr-scan" data-ui-id="live-ocr-scan" data-ui-label="手动扫描按钮" ${recognitionBusy||pendingBusy||sample||paused||loading?'disabled':''}>${recognitionBusy?'正在识别…':'识别一次'}</button><button class="text-button" data-live-action="ocr-auto" aria-pressed="${ocrAuto}" data-ui-id="live-ocr-auto" data-ui-label="自动扫描开关">${ocrAuto?'✓ 自动扫描已开':'开启自动扫描'}</button></div>${ocrResult||recognitionNotice?`<div class="ocr-result" role="status" data-ui-id="live-ocr-result" data-ui-label="卡片识别结果" data-ui-container="live-ocr-result">${recognitionNotice?`<p data-ui-id="live-ocr-notice" data-ui-label="识别操作反馈">${esc(recognitionNotice)}</p>`:''}<p data-ui-id="live-ocr-message" data-ui-label="识别结果说明">${esc(ocrResult?.message||'')}</p>${ocrResult?.proposals?.length?`<small data-ui-id="live-ocr-age" data-ui-label="识别结果时间">最近识别 · ${Math.max(0,Math.floor((Date.now()-lastProposalAt)/1000))} 秒前${pendingState?' · 待确认，已保留':'，请核对仍是本轮选项'}</small>`:''}${ocrResult?.proposals?.length?`<div class="ocr-proposals" data-ui-id="live-ocr-proposals" data-ui-label="识别到的候选海克斯">${ocrResult.proposals.map(x=>`<span>${esc(x.name)}</span>`).join('')}</div>`:''}${ocrResult?.proposals?.length?`<button class="primary-button" data-action="focus-home-compare" data-ui-id="live-ocr-confirm" data-ui-label="查看已识别候选按钮">${ocrResult.proposals.length===3?'查看本轮推荐':'更正识别结果'}</button>`:'<a class="text-button" href="#live" data-action="focus-home-compare" data-ui-id="live-ocr-manual" data-ui-label="手动填入三选一入口">手动填入三个选项</a>'}</div>`:''}</section>`}
      ${loading?'':`<div id="live-additional-actions" class="live-next" ${toolsExpanded?'':'hidden'} data-ui-id="live-next" data-ui-label="实战页后续操作" data-ui-container="live-next"><a class="primary-button" href="#live" data-action="focus-home-compare" data-ui-id="live-next-compare" data-ui-label="实战三选一入口">比较本轮三个选项</a><button class="text-button" data-live-action="sample" data-ui-id="live-next-demo" data-ui-label="演示数据开关">${sample?'退出演示':'预览一组演示数据'}</button></div>`}
      <details class="background-guide" data-disclosure-key="background" data-ui-id="live-background-guide" data-ui-label="后台与快捷键提示" data-ui-container="live-background-guide"><summary id="live-background-summary">侧栏快捷键与后台使用方式</summary><strong data-ui-id="live-shortcut" data-ui-label="侧栏快捷键提示">游戏或助手前台：Alt + Shift + H</strong><span data-ui-id="live-tray-hint" data-ui-label="收进托盘说明">最小化保留任务栏入口；点击窗口右上角 × 可收进托盘继续运行。托盘菜单可完全退出。</span><small data-ui-id="live-window-hint" data-ui-label="窗口模式说明">侧栏适用于无边框或窗口模式。游戏画面仍有露出时侧栏可继续显示；完全遮挡或最小化时暂时隐藏，恢复可见或返回游戏/助手时恢复原状态。主窗口工具栏提供“返回游戏”。</small></details>
      <details class="live-help" data-disclosure-key="connection-help" data-ui-id="live-help" data-ui-label="连接与数据说明" data-ui-container="live-help"><summary id="live-help-summary" data-ui-id="live-help-summary" data-ui-label="连接说明折叠标题">连接与数据说明</summary><p data-ui-id="live-help-intro" data-ui-label="连接软件使用说明">先打开本软件，再正常进入英雄联盟。选人阶段尝试识别英雄，进入对局后约每 2 秒同步自身等级、装备与面板。主窗口隐藏后由后台服务继续同步；已开启的卡片扫描也会继续。部分客户端版本可能不支持选人阶段接口。</p><p data-ui-id="live-help-limitations" data-ui-label="数据与推荐限制说明">${loading?'只读取本机接口，不操作游戏。加载阶段展示实际读到的英雄阵容，装备推荐会随本局状态更新。':'只读取本机接口与游戏窗口，不操作游戏。完整三选一识别后自动比较，已选海克斯由你点选确认。敌方英雄与装备仅展示实际读到的内容；装备和后续海克斯为机制参考，未经过实战准确率验证。'}</p><p data-ui-id="live-help-privacy" data-ui-label="本机数据与退出说明">对局数据和客户端认证信息不会上传到 GitHub 或网站。英雄图标等静态素材可能从资料源加载。托盘菜单“完全退出”才会停止本机同步。</p></details>`;
    }
  };
}

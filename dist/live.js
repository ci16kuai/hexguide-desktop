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

function buildContent({plan,live,context,catalog,owned,usable}){
  const preview=plan.stage==='loading-preview';
  const enemy=plan.enemyContext||{},fresh=usable&&live.teams?.status==='detected'&&enemy.status==='detected';
  const enemies=fresh?list(enemy.champions).map(player=>({...player,championId:player.id||player.championId,championName:player.name||player.championName})):[];
  const entry=item=>catalog?.data?.[String(item.id??item.itemID)];
  const roster=enemies.length?`<div class="live-enemy-grid${preview?' loading-roster':''}">${enemies.map(player=>{const c=context.getChampionById(player.championId);return `<article class="live-enemy"><div class="live-enemy-name">${visual(c?.icon||player.icon,'','live-enemy-avatar')}<div><strong>${esc(c?.name||player.championName||player.championId||'英雄待识别')}</strong>${preview?'':`<small>${Number.isFinite(player.level)&&player.level>0?`${number(player.level)} 级`:'等级未知'}</small>`}</div></div>${preview?'':`<div class="live-enemy-items">${list(player.items).length?list(player.items).map(item=>{const definition=entry(item),name=definition?.name||item.name||`装备 ${item.id??item.itemID}`;return `<span title="${esc(name)}">${visual(definition?.icon,name)}<small>${esc(name)}</small></span>`;}).join(''):'<small>尚未读取到装备</small>'}</div>`}</article>`;}).join('')}</div>`:'<p class="live-build-empty">等待读取本局敌方阵容与装备；读取前不推断对面抗性或治疗量。</p>';
  return `${preview?'':`<div class="live-build-current"><h3>已选海克斯</h3><div class="live-build-owned">${owned.length?owned.map(a=>`<span>${visual(a.icon)}${esc(a.name)}</span>`).join(''):'<p>等待你在候选卡或侧栏确认选择。</p>'}</div></div>`}<section class="live-enemy-context" aria-label="敌方阵容与装备"><h3>${preview?'本局对方阵容':'敌方阵容与当前装备'}</h3><p class="live-build-caption">${esc(preview?'已读取对方英雄；等级与装备将在入场后同步。':enemy.summary||'进入对局并确认本机英雄后自动更新。')}</p>${roster}${!preview&&list(enemy.signals).length?`<ul class="live-enemy-signals">${enemy.signals.map(signal=>`<li>${esc(typeof signal==='string'?signal:signal.summary||signal.reason||signal.label||'')}</li>`).join('')}</ul>`:''}</section><section class="live-build-items" aria-label="本局推荐装备"><h3>${preview?'开局出装预设':'本局装备选择'}</h3><p class="live-build-caption">${preview?'根据当前英雄与对方阵容准备；开局后随装备和已选海克斯调整。':'结合已选海克斯、已有装备与读取到的敌方构筑更新。'}</p>${usable&&list(plan.buildItems).length?`<div class="live-item-grid">${plan.buildItems.map(item=>`<article class="live-item-card">${visual(item.icon,'','live-item-icon')}<div><h4>${esc(item.name)}</h4><p>${esc(item.effect||shortItemEffect(entry(item)?.description)||'装备效果资料待补充。')}</p><small>${esc(sentence(item.reason))}</small></div></article>`).join('')}</div>`:`<p class="live-build-empty">${usable?'当前条件下暂无可靠的对应装备资料。':'等待连接真实对局后生成本局出装。'}</p>`}</section><section class="live-next-augments" aria-label="后续关注海克斯"><h3>${preview?'开局可关注的海克斯':'后续关注的海克斯'}</h3><p class="live-build-caption">${preview?'先看适配方向，出现三选一后再比较实际选项。':'根据当前构筑列出最多 6 个方向。下轮是否出现，以游戏实际选项为准。'}</p>${usable&&list(plan.nextAugments).length?`<div class="live-next-grid">${plan.nextAugments.slice(0,6).map(a=>`<article>${visual(a.icon,'','live-next-icon')}<div><h4>${esc(a.name)}<span>${esc(rarityNames[a.rarity]||'')}</span></h4><p>${esc(sentence(a.reason))}</p>${!preview&&list(a.cautions)[0]?`<small>${esc(sentence(a.cautions[0]))}</small>`:''}</div></article>`).join('')}</div>`:`<p class="live-build-empty">${usable?'等待更多可确认的海克斯联动条件。':'进入真实对局并确认选择后更新。'}</p>`}</section>`;
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
  let sample=false,ocrAuto=false,ocrBusy=false,ocrResult=null,lastOcr=0,lastProposalAt=0,ocrNotice='',epoch=0,lastPhase='',lastTime=null,publishedOfferKey='';
  // One opportunity per game, shared by loading and the first valid live plan.
  // Request cancellation (pause/demo) must not reopen a user's collapsed plan.
  let initialPlanHandled=false;
  try{const boundary=JSON.parse(sessionStorage.getItem('hexguide-game-boundary')||'{}');lastGame=context.getGameId?.()||boundary.gameId||'';lastPhase=boundary.phase||'';lastTime=boundary.gameTime??null;}catch{}
  const phaseNames={None:'客户端未连接',Lobby:'游戏大厅',Matchmaking:'匹配中',ReadyCheck:'确认对局',ChampSelect:'英雄选择',InProgress:'对局进行中',GameStart:'正在载入',WaitingForStats:'等待结算',EndOfGame:'对局已结束'};
  fetch('./items.json').then(r=>r.ok?r.json():{}).then(x=>{catalog=x;refresh();}).catch(()=>{});
  function expireOffers(){if(ocrResult?.proposals?.length&&Date.now()-lastProposalAt>=60000){ocrResult={status:'waiting',message:'识别结果已过期，等待当前三选一卡片。',proposals:[]};ocrNotice='';context.onOffersExpired?.();}}
  function refresh(){expireOffers();if(location.hash==='#live')context.renderLive();}
  function publishOffers(){const proposals=ocrResult?.proposals||[],ids=proposals.map(x=>x.id);if(ocrResult?.status!=='recognized'||live.stage==='loading'||live.phase!=='InProgress'||live.mode?.known&&live.mode.isMayhem===false||proposals.length!==3||new Set(ids).size!==3||Date.now()-lastProposalAt>=60000)return;const key=JSON.stringify([epoch,...ids]);if(key===publishedOfferKey)return;publishedOfferKey=key;context.onOffers(ids,{source:'ocr',observedAt:new Date(lastProposalAt).toISOString()});}
  function acceptSidebar(model){
    if(typeof model?.ocr?.enabled==='boolean')ocrAuto=model.ocr.enabled;
    if(live.stage==='loading')return;
    const observed=model?.ocr||{};
    const observedAt=Date.parse(observed.observedAt||'');
    if(observed.proposals?.length&&Number.isFinite(observedAt)&&Date.now()-observedAt<60000){
      if(observedAt>lastProposalAt&&observedAt<=Date.now()+5000){ocrResult={status:observed.status||'recognized',message:observed.message||'后台已识别本轮选项，请核对后点击你选择的一个。',proposals:observed.proposals};lastProposalAt=observedAt;ocrNotice='';publishOffers();}
    }else if(!ocrResult?.proposals?.length&&observed.message){ocrResult={status:observed.status,message:observed.message,proposals:[]};}
  }
  async function syncSidebar(){
    const started=epoch;
    try{
      const r=await fetch('/api/sidebar',{headers:{'X-Hexguide-Session':token},signal:AbortSignal.timeout(4500),cache:'no-store'});
      if(r.ok){const model=await r.json();if(started===epoch&&!sample&&!paused){acceptSidebar(model);refresh();}}
    }catch{/* Live observations remain usable when the sidebar is unavailable. */}
  }
  async function setAuto(enabled){
    const previous=ocrAuto;ocrAuto=enabled;refresh();
    try{
      const r=await fetch('/api/sidebar/ocr',{method:'POST',headers:{'X-Hexguide-Session':token,'Content-Type':'application/json'},body:JSON.stringify({enabled}),signal:AbortSignal.timeout(4500)});
      if(!r.ok)throw Error('后台扫描设置未能保存，请重试。');
      acceptSidebar(await r.json());ocrNotice=enabled?'后台扫描已开启，收进托盘后仍会运行。':'后台扫描已关闭。';
    }catch(e){ocrAuto=previous;ocrNotice=e.message;}
    refresh();
  }
  function apply(next){
    const newId=next.gameId&&lastGame&&next.gameId!==lastGame;
    const newSelect=next.phase==='ChampSelect'&&lastPhase&&lastPhase!=='ChampSelect';
    const timeReset=next.phase==='InProgress'&&Number.isFinite(next.gameTime)&&next.gameTime>0&&Number.isFinite(lastTime)&&next.gameTime<lastTime-40;
    const enteredLoading=next.stage==='loading'&&live.stage!=='loading';
    live=next;
    if(newId||newSelect||timeReset){epoch++;initialPlanHandled=false;lastTime=null;ocrResult=null;lastProposalAt=0;ocrNotice='';publishedOfferKey='';context.onNewGame();}
    if(next.phase&&next.phase!=='None')lastPhase=next.phase;
    if(Number.isFinite(next.gameTime)&&(next.gameTime>0||!Number.isFinite(lastTime)))lastTime=next.gameTime;
    if(enteredLoading||(next.phase!=='InProgress'||next.stage==='loading')&&ocrResult?.proposals?.length){ocrResult=null;lastProposalAt=0;context.onOffersExpired?.();}
    if(next.gameId){lastGame=next.gameId;context.onGameId?.(next.gameId);}
    try{sessionStorage.setItem('hexguide-game-boundary',JSON.stringify({gameId:lastGame,phase:lastPhase,gameTime:lastTime}));}catch{}
    if(follow&&next.championId)context.onChampion(String(next.championId));
    if(!initialPlanHandled&&!paused&&!sample){
      const isLoading=next.stage==='loading',owned=isLoading?[]:context.getOwned();
      const initialPlan=buildLivePlan({champion:context.getChampion(),owned,route:isLoading?'auto':context.getRoute(),live:next,augments:context.getAugments(),itemsCatalog:catalog,champions:context.getChampions?.()||[]});
      const earlyLive=next.mode?.known===true&&next.mode.isMayhem===true&&next.connection?.status==='connected'&&next.phase==='InProgress'&&next.championSource==='live-client'&&next.championId===context.getChampion()?.id&&Number.isFinite(next.gameTime)&&next.gameTime>=0&&next.gameTime<=30&&!owned.length&&initialPlan.stage==='live'&&initialPlan.enemyContext?.status==='detected'&&initialPlan.enemyContext.source==='live-client'&&list(initialPlan.enemyContext.champions).length&&list(initialPlan.buildItems).length&&list(initialPlan.nextAugments).length;
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
    }catch(e){if(requestEpoch===epoch&&!paused&&!sample){live={...emptyLive,connection:{status:'waiting',message:e.message.includes('桌面程序')||e.message.includes('会话')?e.message:'本地助手暂未连接，正在重试'}};ocrResult=null;context.onOffersExpired?.();refresh();}}
    finally{busy=false;}
  }
  async function scan(delay=false){
    if(ocrBusy||sample||paused||live.stage==='loading')return;
    ocrBusy=true;lastOcr=Date.now();const scanEpoch=epoch;refresh();
    try{
      if(delay){ocrNotice='请在 3 秒内切回游戏，并保持三选一卡片可见。';refresh();await new Promise(resolve=>setTimeout(resolve,3000));}
      if(scanEpoch!==epoch||sample||paused)return;
      const r=await fetch('/api/ocr',{method:'POST',headers:{'X-Hexguide-Session':token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(18000)});
      if(!r.ok)throw Error(`识别暂不可用（${r.status}）`);
      const result=await r.json();if(scanEpoch===epoch&&!sample&&!paused&&live.stage!=='loading'){
        if(result.proposals?.length){ocrResult=result;lastProposalAt=Date.now();ocrNotice='';publishOffers();}
        else if(ocrResult?.proposals?.length&&Date.now()-lastProposalAt<60000){ocrNotice=result.message||'本次未发现三选一卡片；保留最近一次识别，带入前请核对。';}
        else{ocrResult=result;ocrNotice='';}
      }
    }catch(e){if(scanEpoch===epoch&&!sample&&!paused){ocrNotice=e.name==='TimeoutError'?'本次识别超时，请重试或手动填入。':e.message;if(!ocrResult?.proposals?.length)ocrResult={status:'unavailable',message:ocrNotice,proposals:[]};}}
    finally{ocrBusy=false;refresh();}
  }
  timer=setInterval(poll,2200);poll();
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  document.addEventListener('click',e=>{
    const action=e.target.closest('[data-live-action]')?.dataset.liveAction;
    if(action==='refresh')poll();
    if(action==='pause'){epoch++;paused=!paused;refresh();if(!paused)poll();}
    if(action==='follow'){follow=!follow;context.onStatusChange?.();if(follow&&live.championId)context.onChampion(live.championId);refresh();}
    if(action==='ocr-scan')scan(true);
    if(action==='ocr-auto')void setAuto(!ocrAuto);
    if(action==='ocr-confirm')publishOffers();
    if(action==='build-toggle'){context.onBuildToggle?.();refresh();}
    if(action==='sample'){
      epoch++;sample=!sample;ocrResult=null;lastProposalAt=0;ocrNotice='';publishedOfferKey='';context.onOffersExpired?.();
      if(sample){
        live={connection:{status:'connected',message:'演示数据，未连接真实对局'},phase:'InProgress',championId:'Ahri',level:11,gameTime:660,currentGold:1450,stats:{abilityPower:175,attackDamage:72,abilityHaste:35,armor:55,maxHealth:1850},items:[{id:6655,name:'卢登的回声',count:1}],augments:{status:'unavailable',ids:[]},mode:{known:true,isMayhem:true,queueId:2400},observedAt:new Date().toISOString()};
      }else{live=emptyLive;poll();}
      refresh();
    }
  });
  return {
    manualChampion(){follow=false;},
    confirmedSelection(){ocrResult=null;lastProposalAt=0;ocrNotice='';},
    html(){
      const c=sample?context.getChampionById('Ahri'):context.getChampion(),loading=!sample&&live.stage==='loading',owned=sample||loading?[]:context.getOwned(),route=sample||loading?'auto':context.getRoute();
      if(ocrResult?.proposals?.length&&Date.now()-lastProposalAt>=60000){ocrResult={status:'waiting',message:'识别结果已过期，请重新扫描本轮卡片。',proposals:[]};ocrNotice='';}
      const connected=live.connection?.status==='connected';
      const usable=connected&&!sample&&!paused&&live.championId===c?.id&&live.championSource==='live-client'&&Number.isFinite(live.gameTime);
      const loadingUsable=connected&&!sample&&!paused&&live.championId===c?.id&&live.championSource==='loading-screen'&&loading;
      const planLive=sample?live:usable||loadingUsable?live:{...emptyLive,mode:live.mode,phase:live.phase,connection:{status:'waiting'}};
      const plan=buildLivePlan({champion:c,owned,route,live:planLive,augments:context.getAugments(),itemsCatalog:catalog,champions:context.getChampions?.()||[]});
      const preview=plan.stage==='loading-preview',expanded=Boolean(context.getBuildExpanded?.()),selected=loading?null:context.getSelectedAugment?.();
      if(sample){plan.label='演示数据 · 机制参考';plan.summary='虚构阿狸对局示例，独立于你的英雄与已选海克斯。'+plan.summary.replace('已结合当前英雄、自身面板与装备','使用示例面板与装备');plan.context=(plan.context||[]).map(x=>'演示：'+x.replace('本局自动读取','示例英雄').replace('已读取装备','示例装备'));}
      const stats=usable||sample?live.stats||{}:{};
      const status=sample?'演示模式':paused?'同步已暂停':connected?'已连接本机游戏':'等待连接';
      const mode=live.mode?.known?(live.mode.isMayhem?'海克斯大乱斗':'当前模式不是海克斯大乱斗'):'游戏模式待确认';
      return `<div class="page-intro live-intro" data-ui-id="live-intro" data-ui-label="实战页开场区域" data-ui-container="live-intro"><div data-ui-id="live-intro-copy" data-ui-label="实战页标题文案" data-ui-container="live-intro-copy"><span class="live-kicker" data-ui-id="live-kicker" data-ui-label="桌面版版本提示">Windows 桌面版 1.9.6</span><h1 data-ui-id="live-title" data-ui-label="实战页大标题">我的这一局</h1><p data-ui-id="live-subtitle" data-ui-label="实战页说明文字">加载时先看对方阵容与开局预设，入场后识别海克斯并随选择更新推荐。</p></div><span class="local-badge" data-ui-id="live-local-badge" data-ui-label="仅在本机处理标签">仅在本机处理</span></div><div class="background-guide" data-ui-id="live-background-guide" data-ui-label="后台与快捷键提示" data-ui-container="live-background-guide"><strong data-ui-id="live-shortcut" data-ui-label="侧栏快捷键提示">游戏或助手前台：Alt + Shift + H</strong><span data-ui-id="live-tray-hint" data-ui-label="收进托盘说明">点击窗口右上角 × 或最小化，可收进托盘继续运行；托盘菜单可完全退出。</span><small data-ui-id="live-window-hint" data-ui-label="窗口模式说明">侧栏适用于无边框或窗口模式。游戏画面仍有露出时侧栏可继续显示；完全遮挡或最小化时暂时隐藏，恢复可见或返回游戏/助手时恢复原状态。主窗口工具栏提供“返回游戏”。</small></div>
      <section class="live-connection ${connected?'connected':''}" aria-label="游戏连接状态" data-ui-id="live-connection" data-ui-label="游戏连接状态栏" data-ui-container="live-connection"><div class="connection-symbol" data-ui-id="live-connection-symbol" data-ui-label="连接状态图标">${connected?'◉':'◌'}</div><div data-ui-id="live-connection-copy" data-ui-label="连接状态文字" data-ui-container="live-connection-copy"><strong data-ui-id="live-connection-title" data-ui-label="连接状态标题">${esc(status)}</strong><p data-ui-id="live-connection-message" data-ui-label="连接状态详情">${esc(live.connection?.message||'等待英雄联盟游戏启动')} · ${esc(phaseNames[live.phase]||live.phase||'等待对局')}</p></div><button class="text-button" data-live-action="pause" data-ui-id="live-pause" data-ui-label="暂停恢复同步按钮">${paused?'恢复同步':'暂停同步'}</button><button class="secondary-button" data-live-action="refresh" data-ui-id="live-refresh" data-ui-label="重新检测按钮" ${sample?'disabled':''}>重新检测</button></section>
      ${sample?'<div class="live-notice" data-ui-id="live-sample-notice" data-ui-label="演示模式提示">这是一组虚构示例，用于预览实战布局，不代表正在读取你的对局。退出演示后恢复本机检测。</div>':''}
      ${connected&&!live.mode?.isMayhem?`<div class="live-notice" data-ui-id="live-mode-notice" data-ui-label="当前模式提示">${esc(mode)}。仍可查看自身数据；下方海克斯建议仅作为模式资料参考。</div>`:''}
      <section class="live-champion" data-ui-id="live-champion" data-ui-label="实战英雄信息" data-ui-container="live-champion"><div class="live-champion-name" data-ui-id="live-champion-identity" data-ui-label="英雄头像与名称" data-ui-container="live-champion-identity">${c?`<img src="${esc(c.icon)}" alt="" onerror="this.style.display='none'" data-ui-id="live-champion-avatar" data-ui-label="英雄头像">`:''}<div data-ui-id="live-champion-copy" data-ui-label="英雄名称文字" data-ui-container="live-champion-copy"><span data-ui-id="live-champion-mode" data-ui-label="英雄模式标签">${preview?'本局英雄 · 正在载入':usable||sample?esc(mode):'当前参考英雄'}</span><h2 data-ui-id="live-champion-name" data-ui-label="英雄姓名与称号">${esc(c?.name||'请选择英雄')}<small>${esc(c?.title||'')}</small></h2></div></div><div class="live-follow" data-ui-id="live-follow" data-ui-label="自动跟随英雄设置" data-ui-container="live-follow"><button class="follow-button ${follow?'on':''}" data-live-action="follow" aria-pressed="${follow}" data-ui-id="live-follow-button" data-ui-label="自动跟随英雄按钮">${follow?'✓ 自动跟随英雄':'手动选择英雄'}</button><small data-ui-id="live-follow-hint" data-ui-label="跟随英雄说明">${follow?'选人阶段与进入游戏后同步':'切换为自动后跟随真实英雄'}</small></div></section>
      <dl class="live-stats" data-ui-id="live-stats" data-ui-label="实战数据面板" data-ui-container="live-stats">${stat('level','等级',usable||sample?number(live.level):'—')}${stat('time','游戏时间',usable||sample?`${Math.floor((live.gameTime||0)/60)}:${String(Math.floor((live.gameTime||0)%60)).padStart(2,'0')}`:'—')}${stat('ap','法术强度',number(stats.abilityPower))}${stat('ad','攻击力',number(stats.attackDamage))}${stat('haste','技能急速',number(stats.abilityHaste))}${stat('gold','当前金币',usable||sample?number(live.currentGold):'—')}</dl>
      <div class="live-equipment" data-ui-id="live-equipment" data-ui-label="当前装备区域" data-ui-container="live-equipment"><span data-ui-id="live-equipment-label" data-ui-label="当前装备标题">当前装备</span><div data-ui-id="live-equipment-items" data-ui-label="装备列表">${(usable||sample)&&live.items?.length?live.items.map(i=>`<span class="equipped-item">${esc(i.name||`物品 ${i.id}`)}${i.count>1?` ×${number(i.count)}`:''}</span>`).join(''):'<small>进入对局后自动显示；未连接时不填入示例装备。</small>'}</div></div>
      <div class="live-augment-note" data-ui-id="live-owned-note" data-ui-label="已确认海克斯说明" data-ui-container="live-owned-note"><span data-ui-id="live-owned-symbol" data-ui-label="已确认海克斯图标">◇</span><div data-ui-id="live-owned-copy" data-ui-label="已确认海克斯文字" data-ui-container="live-owned-copy"><strong data-ui-id="live-owned-title" data-ui-label="已确认海克斯数量">已确认 ${owned.length} 个海克斯</strong><p data-ui-id="live-owned-text" data-ui-label="手动确认海克斯说明">后台识别升级的三个选项。你在候选卡或侧栏点击“我选了这个”后，才会记录为已选并更新推荐。</p></div><button class="secondary-button" data-action="pick-owned" data-ui-id="live-owned-button" data-ui-label="确认已选海克斯按钮" ${loading?'disabled':''}>确认已选</button></div>
      <section class="ocr-panel" aria-label="三选一卡片识别" data-ui-id="live-ocr" data-ui-label="三选一卡片识别区域" data-ui-container="live-ocr"><div data-ui-id="live-ocr-copy" data-ui-label="卡片识别说明" data-ui-container="live-ocr-copy"><strong data-ui-id="live-ocr-title" data-ui-label="卡片识别标题">识别屏幕上的三个选项 <small>实验功能</small></strong><p data-ui-id="live-ocr-help" data-ui-label="后台识别说明">自动扫描开启时，识别结果直接显示在本轮三选一；主窗口收进托盘仍可运行。图片不保留。</p></div><div class="ocr-actions" data-ui-id="live-ocr-actions" data-ui-label="卡片识别操作按钮" data-ui-container="live-ocr-actions"><button class="secondary-button" data-live-action="ocr-scan" data-ui-id="live-ocr-scan" data-ui-label="手动扫描按钮" ${ocrBusy||sample||loading?'disabled':''}>${ocrBusy?'正在识别…':'3 秒后扫描'}</button><button class="text-button" data-live-action="ocr-auto" aria-pressed="${ocrAuto}" data-ui-id="live-ocr-auto" data-ui-label="自动扫描开关">${ocrAuto?'✓ 自动扫描已开':'开启自动扫描'}</button></div>${ocrResult||ocrNotice?`<div class="ocr-result" role="status" data-ui-id="live-ocr-result" data-ui-label="卡片识别结果" data-ui-container="live-ocr-result">${ocrNotice?`<p data-ui-id="live-ocr-notice" data-ui-label="识别操作反馈">${esc(ocrNotice)}</p>`:''}<p data-ui-id="live-ocr-message" data-ui-label="识别结果说明">${esc(ocrResult?.message||'')}</p>${ocrResult?.proposals?.length?`<small data-ui-id="live-ocr-age" data-ui-label="识别结果时间">最近识别 · ${Math.max(0,Math.floor((Date.now()-lastProposalAt)/1000))} 秒前，请核对仍是本轮选项</small>`:''}${ocrResult?.proposals?.length?`<div class="ocr-proposals" data-ui-id="live-ocr-proposals" data-ui-label="识别到的候选海克斯">${ocrResult.proposals.map(x=>`<span>${esc(x.name)}</span>`).join('')}</div>`:''}${ocrResult?.proposals?.length?`<button class="primary-button" data-action="focus-home-compare" data-ui-id="live-ocr-confirm" data-ui-label="查看已识别候选按钮">${ocrResult.proposals.length===3?'查看本轮推荐':'更正识别结果'}</button>`:'<a class="text-button" href="#live" data-action="focus-home-compare" data-ui-id="live-ocr-manual" data-ui-label="手动填入三选一入口">手动填入三个选项</a>'}</div>`:''}</section>
      <section id="live-build" class="live-plan ${expanded?'expanded':'collapsed'}${preview?' loading-preview':''}" tabindex="-1" aria-label="本局出装与后续海克斯" data-ui-id="live-plan" data-ui-label="推荐玩法区域" data-ui-container="live-plan"><div class="section-heading" data-ui-id="live-plan-heading" data-ui-label="推荐玩法标题栏" data-ui-container="live-plan-heading"><div data-ui-id="live-plan-copy" data-ui-label="推荐玩法标题文字" data-ui-container="live-plan-copy"><h2 data-ui-id="live-plan-title" data-ui-label="推荐玩法标题">${preview?'开局前预览':live.mode?.known&&live.mode.isMayhem===false?esc(plan.title):'本局出装与后续海克斯'}</h2><p class="section-subtitle" data-ui-id="live-plan-summary" data-ui-label="推荐玩法说明">${preview?'已读取本局阵容，先查看出装与海克斯方向；入场后自动更新。':sample?esc(plan.title)+' · 演示预览':selected?'已选择「'+esc(selected.name)+'」，推荐随本局状态更新。':'在候选卡或侧栏确认后，展开查看对应的装备与后续联动。'}</p></div><span class="subtle-tag" data-ui-id="live-plan-badge" data-ui-label="推荐依据标签">${esc(plan.label||'机制参考')}</span><button class="text-button live-build-toggle" data-live-action="build-toggle" aria-expanded="${expanded}" aria-controls="live-build-details">${expanded?'收起推荐':'展开推荐'}</button></div>
      <div class="plan-context" ${expanded&&!preview?'':'hidden'} data-ui-id="live-plan-context" data-ui-label="推荐参考条件">${(plan.context||[]).map(x=>`<span>${esc(x)}</span>`).join('')}</div>
      <div class="live-routes" hidden data-ui-id="live-plan-routes" data-ui-label="推荐玩法卡片" data-ui-container="live-plan-routes">${(plan.choices||[]).map((choice,index)=>`<article class="live-route" data-ui-id="live-route-${index+1}" data-ui-label="推荐玩法卡片 ${index+1}"><h3>${esc(choice.title)}</h3><ul>${(choice.why||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>${choice.items?.length?`<div class="route-items">${choice.items.map(i=>`<div><strong>${esc(i.name)}</strong><span>${esc(i.reason)}</span></div>`).join('')}</div>`:''}<p class="route-watch">${(choice.watch||[]).map(esc).join(' ')}</p></article>`).join('')}</div><div id="live-build-details" class="live-build-details" ${expanded?'':'hidden'}>${buildContent({plan,live,context,catalog,owned,usable:(usable||preview)&&!sample})}</div></section>
      <div class="live-next" data-ui-id="live-next" data-ui-label="实战页后续操作" data-ui-container="live-next"><a class="primary-button" href="#live" data-action="focus-home-compare" data-ui-id="live-next-compare" data-ui-label="实战三选一入口">比较本轮三个选项</a><button class="text-button" data-live-action="sample" data-ui-id="live-next-demo" data-ui-label="演示数据开关">${sample?'退出演示':'预览一组演示数据'}</button></div>
      <details class="live-help" data-ui-id="live-help" data-ui-label="连接与数据说明" data-ui-container="live-help"><summary data-ui-id="live-help-summary" data-ui-label="连接说明折叠标题">连接与数据说明</summary><p data-ui-id="live-help-intro" data-ui-label="连接软件使用说明">先打开本软件，再正常进入英雄联盟。选人阶段尝试识别英雄，进入对局后约每 2 秒同步自身等级、装备与面板。主窗口隐藏后由后台服务继续同步；已开启的卡片扫描也会继续。部分客户端版本可能不支持选人阶段接口。</p><p data-ui-id="live-help-limitations" data-ui-label="数据与推荐限制说明">只读取本机接口与游戏窗口，不操作游戏。完整三选一识别后自动比较，已选海克斯由你点选确认。敌方英雄与装备仅展示实际读到的内容；装备和后续海克斯为机制参考，未经过实战准确率验证。</p><p data-ui-id="live-help-privacy" data-ui-label="本机数据与退出说明">对局数据和客户端认证信息不会上传到 GitHub 或网站。英雄图标等静态素材可能从资料源加载。托盘菜单“完全退出”才会停止本机同步。</p></details>`;
    }
  };
}

import {createStatistics,getChampionRows,getAugmentRows} from './statistics.js';
import {createConditionalStatisticsClient,selectConditionalStatistics} from './conditional-statistics.js';
import {replacePreservingFocus} from './focus-preservation.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value).toLocaleString('zh-CN'):'—';
const percent=value=>Number.isFinite(value)?`${value.toFixed(2)}%`:'暂无统计';
const delta=value=>Number.isFinite(value)?`${value>0?'+':''}${value.toFixed(2)}`:'—';
const link=value=>/^https:\/\//i.test(value||'')?esc(value):'#';
const rarityNames={silver:'白银',gold:'黄金',prismatic:'棱彩'};
const target=(id,label,container=false)=>`data-ui-id="${id}" data-ui-label="${label}"${container?` data-ui-container="${id}"`:''}`;
const icon=(url,alt='',className='')=>/^https:\/\//i.test(url||'')?`<img class="${className}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" onerror="this.onerror=null;this.src='./assets/mark.svg'">`:`<img class="${className}" src="./assets/mark.svg" alt="${esc(alt)}" loading="lazy">`;
export function shortItemEffect(description){
  const lines=String(description||'').replace(/<\/?(?:br|p|div|li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')
    .replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/[（(]\s*0(?:\.0+)?(?:秒|伤害|生命值|法力值)?\s*[）)]/g,'')
    .replace(/(?<![\d.])0(?:\.0+)?(?=(?:额外)?(?:物理伤害|魔法伤害|真实伤害|伤害|生命值|法力值|护盾))/g,'')
    .split(/\n+/).map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean);
  // Official static descriptions can contain unresolved formulas. Omit those
  // sentences instead of presenting their placeholder as a real item value.
  const known=line=>!/{{|}}|@[\w]+@|%i:|\b(?:NaN|undefined)\b|(?<!\d)0秒/.test(line);
  const effectLines=lines.filter(line=>!/^[-+]?\d/.test(line)&&/获得|造成|提供|提升|提高|降低|缩短|减少|回复|治疗|护盾|施放|使用|攻击|进入|减速|显形|灼烧|暴击|伤害|持续|触发|格挡/.test(line));
  const sentences=effectLines.join('').match(/[^。！？]+[。！？]?/gu)?.filter(known)||[];
  const summary=[];
  for(const sentence of sentences){
    if(summary.length===2||Array.from(summary.join('')+sentence).length>100)break;
    summary.push(sentence);
  }
  if(summary.length)return summary.join('');
  // A stat-only item still has a useful exact description; never substitute a
  // route's recommendation reason for a missing catalog effect.
  return lines.filter(line=>/^[-+]?\d/.test(line)&&known(line)).slice(0,4).join('、').slice(0,100);
}

export function equipmentCards(advice,itemsCatalog){
  const seen=new Set(),items=[];
  for(const choice of advice.choices||[]){
    for(const item of choice.items||[]){
      const id=String(typeof item==='string'?item:item?.id||''),entry=itemsCatalog.data?.[id];
      if(!id||seen.has(id)||!entry||String(entry.id)!==id||!entry.name||!/^https:\/\//i.test(entry.icon||''))continue;
      seen.add(id);
      const effect=shortItemEffect(entry.description);
      if(!effect)continue;
      items.push({id,name:entry.name,icon:entry.icon,effect});
      if(items.length===6)return items;
    }
  }
  return items;
}

// This page only browses statistics and equipment catalog entries.
export function createStatisticsView({catalog,fetcher=(...args)=>fetch(...args),conditionalClient}={}){
  let index=null,itemsCatalog={},loading=false,error='',loaded=false;
  const conditional=conditionalClient||createConditionalStatisticsClient({fetcher});
  const observations=new Map();
  const state={query:'',sort:'winRate',championId:'',augmentQuery:'',rarity:'all',includeLowSample:false,includeUnavailable:false,expanded:''};
  const champion=()=>index?.championById.get(String(state.championId));
  const rows=()=>getAugmentRows(index,state.championId,{query:state.augmentQuery,rarity:state.rarity,includeLowSample:state.includeLowSample,includeUnavailable:state.includeUnavailable});

  async function load(){
    if(loading||loaded)return;
    loading=true;error='';
    try{
      const response=await fetcher('./statistics.json',{cache:'no-store'});
      if(!response.ok)throw Error(`统计资料请求失败（${response.status}）`);
      index=createStatistics(await response.json(),catalog);
      try{const items=await fetcher('./items.json');if(items.ok)itemsCatalog=await items.json();}catch{}
      loaded=true;
    }catch(cause){error=cause?.message||'未能读取统计资料';}
    finally{loading=false;redraw();}
  }
  function provenance(){
    const meta=index.meta||{},source=meta.sourceName||meta.source?.name||'AramHex',sourceUrl=meta.sourceUrl||meta.source?.url||'https://aramhex.com/';
    const cohorts=Array.isArray(meta.cohorts)?meta.cohorts:[],cohort=cohorts.find(c=>c.id===meta.defaultCohortId)||cohorts[0]||{};
    const patch=meta.patch||meta.statsPatch||cohort.patch||'16.21',date=meta.statsUpdatedAt||meta.sourceUpdatedAt||meta.sourceDate||meta.statsDate||meta.sampleDate||cohort.updatedAt||'';
    const imported=meta.fetchedAt||meta.importedAt||'';
    const formatDate=value=>{if(!value)return '来源未注明';const parsed=new Date(value);return Number.isNaN(parsed.getTime())?String(value):parsed.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});};
    return `<section class="stats-provenance" ${target('stats-provenance','英雄胜率数据来源')}><div><b>${esc(source)} 正式服统计</b><span>统计版本 ${esc(patch)}</span><span>${esc(meta.region||'国服 7 区合并')}</span><span>${number(meta.validGames||meta.totalMatches)} 场有效对局</span></div><div><span>来源统计更新：${esc(formatDate(date))}</span><span>本站同步：${esc(formatDate(imported))}（北京时间）</span></div><div><a href="${link(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看统计来源 ↗</a><a href="${link(meta.source?.licenseUrl||'https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans')}" target="_blank" rel="noopener noreferrer">数据许可 CC BY-NC 4.0</a><span>经整理与中文目录映射；统计版本独立于 4.0 规则资料。</span></div></section>`;
  }
  function list(){
    const champions=getChampionRows(index,{query:state.query,sort:state.sort}),available=index.champions.filter(c=>c.hasStats).length;
    const rankMap=new Map(getChampionRows(index,{sort:state.sort}).map((c,i)=>[c.id,i+1]));
    return `<div class="stats-heading" ${target('stats-heading','英雄胜率榜标题')}><div><h1>英雄胜率榜</h1><p>先看英雄整体表现，再比较持有海克斯的胜率差。</p></div><span class="stats-count">${available} / ${index.champions.length} 位英雄有统计</span></div>${provenance()}<div class="stats-controls" ${target('stats-filters','英雄胜率搜索与排序')}><label class="search-field"><span aria-hidden="true">⌕</span><input id="stats-champion-search" type="search" value="${esc(state.query)}" placeholder="搜索英雄名称、称号、英文或昵称" aria-label="搜索胜率榜英雄" autocomplete="off"></label><label class="stats-sort"><span>排序</span><select id="stats-champion-sort" aria-label="英雄胜率排序"><option value="winRate" ${state.sort==='winRate'?'selected':''}>胜率从高到低</option><option value="games" ${state.sort==='games'?'selected':''}>样本从多到少</option><option value="name" ${state.sort==='name'?'selected':''}>英雄名称</option></select></label></div><section class="stats-list" ${target('stats-leaderboard','全部英雄胜率列表')}><div class="stats-list-note"><strong>${champions.length} 位英雄</strong><span>点击英雄查看海克斯胜率、联动与实战出装</span></div><div class="stats-table-scroll"><table class="stats-table stats-champion-table"><caption class="stats-sr-only">英雄整体胜率，按所选方式排序</caption><thead><tr><th scope="col">排名</th><th scope="col">英雄</th><th scope="col" class="stats-number">胜率</th><th scope="col" class="stats-number">英雄样本</th><th scope="col" class="stats-number stats-optional">海克斯记录</th><th scope="col"><span class="stats-sr-only">查看</span></th></tr></thead><tbody>${champions.map((c,i)=>`<tr><td class="stats-rank">${c.hasStats?rankMap.get(c.id):'—'}</td><td><button class="stats-hero-button" data-stats-action="champion" data-stats-id="${esc(c.id)}">${icon(c.icon)}<span><strong>${esc(c.name)}</strong><small>${esc(c.title||c.enName||'')}</small></span></button></td><td class="stats-number"><strong class="${c.winRate>=50?'stats-positive':''}">${percent(c.winRate)}</strong></td><td class="stats-number">${c.hasStats?number(c.games):'—'}</td><td class="stats-number stats-optional">${number(c.augments?.length||0)}</td><td><button class="stats-row-open" data-stats-action="champion" data-stats-id="${esc(c.id)}" aria-label="查看${esc(c.name)}的海克斯胜率">查看 <span aria-hidden="true">›</span></button></td></tr>`).join('')||'<tr><td colspan="6" class="stats-empty">没有符合条件的英雄。试试更短的名称。</td></tr>'}</tbody></table></div></section>`;
  }
  const observationKey=c=>`${index?.meta?.patch||''}:${c?.sourceChampionId||''}`;
  function ensureObservations(retry=false){
    const c=champion(),row=rows().find(entry=>String(entry.id)===state.expanded);
    if(!c||!state.expanded||!row||!/^\d+$/.test(c.sourceChampionId||'')||!/^\d+$/.test(row.sourceAugmentId||'')||!row.canAdopt)return;
    const key=observationKey(c),previous=observations.get(key);
    if(previous&&(!retry||previous.status==='loading'||previous.status==='ready'))return;
    const entry={status:'loading',data:null,error:''};
    observations.set(key,entry);
    // Requests belong to a hero snapshot, never to the augment selected when
    // they started. Only the current row is selected at render time.
    Promise.resolve().then(()=>conditional.load({championId:c.sourceChampionId,patch:String(index.meta.patch||'')}))
      .then(data=>{entry.status='ready';entry.data=data;})
      .catch(cause=>{entry.status='error';entry.error=cause?.message||'暂时无法连接统计来源。';})
      .finally(()=>{
        if(observations.size>3){for(const [oldKey,old] of observations){if(oldKey!==key&&old.status!=='loading'){observations.delete(oldKey);if(observations.size<=3)break;}}}
        if(champion()?.id===c.id&&state.expanded)redraw();
      });
  }
  function observedItem(id){
    const key=String(id),entry=itemsCatalog.data?.[key];
    if(!entry||String(entry.id)!==key)return {id:key,name:`装备 #${key}`,icon:'',effect:'本地目录暂未收录效果，未按名称猜测替换。'};
    return {id:key,name:entry.name||`装备 #${key}`,icon:entry.icon||'',effect:shortItemEffect(entry.description)||'本地目录暂未提供可展示的效果说明。'};
  }
  function itemMarkup(id){
    const item=observedItem(id);
    return `${icon(item.icon)}<div><strong>${esc(item.name)}</strong><p>${esc(item.effect)}</p></div>`;
  }
  function build(row,c){
    const wrapper=body=>`<tr class="stats-build-row"><td colspan="6"><section class="stats-build stats-observations" aria-label="实战联动与出装" ${target('stats-build','实战联动与出装')}><div class="stats-observation-heading"><h3>${esc(c.name)} · ${esc(row.name)}</h3><span>实战联动与出装</span></div>${body}</section></td></tr>`;
    if(!row.canAdopt||!/^\d+$/.test(c.sourceChampionId||'')||!/^\d+$/.test(row.sourceAugmentId||''))return wrapper('<p class="stats-build-empty">这条记录尚未映射到当前正式服英雄与海克斯，暂不查询条件出装。</p>');
    const entry=observations.get(observationKey(c));
    if(!entry||entry.status==='loading')return wrapper('<p class="stats-build-empty" role="status">正在查询这个英雄选择该海克斯后的实战数据…</p>');
    const sourceLink='<a href="https://aramkit.com/zh-CN/champions" target="_blank" rel="noopener noreferrer">查看 ARAMKit 原站 ↗</a>';
    if(entry.status==='error')return wrapper(`<div class="stats-observation-error" role="alert"><p>实战数据暂未载入：${esc(entry.error)}</p><button class="secondary-button" data-stats-action="retry-build">重新查询</button>${sourceLink}</div>`);
    let data;
    try{data=selectConditionalStatistics(entry.data,{augmentId:row.sourceAugmentId});}
    catch{return wrapper(`<p class="stats-build-empty">来源数据格式暂不兼容，未以通用装备补齐。</p>${sourceLink}`);}
    const meta=entry.data.meta||{},catalogMeta=itemsCatalog.meta||{};
    const definitions=new Map(catalog.augments.filter(a=>a.gameDataId!=null).map(a=>[String(a.gameDataId),a]));
    const pairs=data.pairs||[],profiles=data.builds?.profiles||[],items=(data.items?.rows||[]).slice().sort((a,b)=>b.sampleCount-a.sampleCount).slice(0,6);
    const sourceUpdated=Number.isFinite(meta.buildTimeUnixMs)?new Date(meta.buildTimeUnixMs).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):meta.dataDate||'来源未注明';
    const metadata=`<div class="stats-observation-source"><span>ARAMKit · ${esc(meta.patch||'')} · 全分段 · 来源更新 ${esc(sourceUpdated)}（北京时间）</span>${sourceLink}</div>`;
    const combinations=`<section class="stats-observation-group"><h4>共同出现的海克斯</h4>${pairs.length?`<ul class="stats-pair-list">${pairs.map(pair=>{const a=definitions.get(String(pair.otherAugmentId));return `<li>${icon(a?.icon)}<div><strong>${esc(a?.name||`海克斯 #${pair.otherAugmentId}`)}</strong></div><span>组合胜率 <b>${percent(pair.winRate)}</b></span></li>`;}).join('')}</ul>`:'<p class="stats-build-empty">来源已发布的组合中暂无该海克斯。</p>'}</section>`;
    const builds=`<section class="stats-observation-group"><h4>选「${esc(row.name)}」时的常见三件套</h4>${profiles.length?`<ol class="stats-observed-builds">${profiles.map((profile,i)=>`<li><div class="stats-build-caption"><strong>三件套 ${i+1}</strong><span>胜率 ${percent(profile.winRate)}</span></div><ul class="stats-build-items">${profile.items.map(id=>`<li class="stats-build-item">${itemMarkup(id)}</li>`).join('')}</ul>${profile.routes?.length?`<p class="stats-purchase-order">常见购买顺序：${profile.routes[0].items.map(id=>esc(observedItem(id).name)).join(' → ')}<small>胜率 ${percent(profile.routes[0].winRate)}</small></p>`:'<p class="stats-observation-note">来源未发布购买顺序。</p>'}</li>`).join('')}</ol>`:'<p class="stats-build-empty">暂无该英雄选择这条海克斯后的三件套数据。</p>'}</section>`;
    const equipment=`<section class="stats-observation-group"><h4>同条件常用单件装备</h4>${items.length?`<ul class="stats-build-items">${items.map(item=>`<li class="stats-build-item">${itemMarkup(item.id)}<small class="stats-observed-metric">持有胜率 ${percent(item.winRate)}</small></li>`).join('')}</ul>`:'<p class="stats-build-empty">暂无该英雄选择这条海克斯后的装备数据。</p>'}</section>`;
    return wrapper(`${combinations}${builds}${equipment}<details class="stats-observation-method"><summary>数据说明</summary>${metadata}<p class="stats-observation-note">装备来自“${esc(c.name)}＋${esc(row.name)}”的真实聚合统计，未限定上方第二个海克斯，不是逐场玩家战绩。三件套图标排列不表示购买顺序；购买顺序另列。单件装备各自统计，不能拼作六件套。</p><p class="stats-observation-note">海克斯组合仅筛选来源为该英雄发布的 10 组，按共同样本数排列；不代表全部组合中关联最强，未发布不代表没有联动。装备与三件套也按样本数排列。</p><p class="stats-observation-note">组合、三件套与单件装备的样本范围各自独立，不与榜单的 AramHex 胜率混算增幅。统计关联不代表必然收益，较小样本的胜率可能波动较大。</p><p class="stats-equipment-source">装备图标与效果 ${esc(catalogMeta.version||'')} · <a href="${link(catalogMeta.sourceUrl)}" target="_blank" rel="noopener noreferrer">Riot Data Dragon ↗</a></p></details>`);
  }
  function detail(){
    const c=champion();if(!c){state.championId='';return list();}
    const augments=rows(),threshold=index.meta?.lowSampleThreshold||3000;
    return `<div class="stats-detail-heading" ${target('stats-detail-heading','英雄统计详情标题')}><button class="stats-back" data-stats-action="back">‹ 返回全部英雄</button></div><section class="stats-profile" ${target('stats-profile','英雄基础胜率')}><div class="stats-profile-identity">${icon(c.icon)}<div><h1>${esc(c.name)}</h1><p>${esc(c.title||'')} <span>${esc(c.enName||'')}</span></p></div></div><dl><div><dt>英雄整体胜率</dt><dd>${percent(c.winRate)}</dd></div><div><dt>英雄样本</dt><dd>${c.hasStats?number(c.games):'—'}</dd></div><div><dt>胜场</dt><dd>${c.hasStats?number(c.wins):'—'}</dd></div></dl><a href="${link(c.sourceUrl||index.meta?.sourceUrl||'https://aramhex.com/')}" target="_blank" rel="noopener noreferrer">英雄统计原文 ↗</a></section>${provenance()}<div class="stats-explainer" ${target('stats-comparison-note','胜率差比较说明')}><strong>胜率增幅 = 局末持有该海克斯的胜率 − 英雄整体胜率</strong><p>来源按对局结束时持有该海克斯统计，任一槽位持有即计入、同一玩家去重。差值单位是“百分点”，只比较同来源、同版本、同统计范围；它是统计关联，不是每次三选一的实验结果，也不保证实际胜率提升。</p></div><section class="stats-augment-filters" ${target('stats-augment-filters','海克斯胜率筛选')}><div class="stats-controls"><label class="search-field"><span aria-hidden="true">⌕</span><input id="stats-augment-search" type="search" value="${esc(state.augmentQuery)}" placeholder="搜索海克斯名称或效果" aria-label="搜索英雄海克斯统计" autocomplete="off"></label><select id="stats-rarity" aria-label="海克斯统计品质"><option value="all">全部品质</option>${Object.entries(rarityNames).map(([key,name])=>`<option value="${key}" ${state.rarity===key?'selected':''}>${name}</option>`).join('')}</select></div><div class="stats-toggles"><label><input id="stats-low-sample" type="checkbox" ${state.includeLowSample?'checked':''}> 包含低样本（&lt;${number(threshold)} 场）</label><label><input id="stats-unavailable" type="checkbox" ${state.includeUnavailable?'checked':''}> 包含非当前 / 测试服参考项</label></div></section><section class="stats-augments" ${target('stats-augment-table','海克斯胜率增幅列表')}><div class="stats-list-note"><strong>${augments.length} 项海克斯统计</strong><span>可比项按胜率增幅从高到低；点击展开联动与实战出装</span></div><div class="stats-table-scroll"><table class="stats-table stats-augment-table"><caption class="stats-sr-only">${esc(c.name)}选中各海克斯的胜率与相对英雄基线的百分点差</caption><thead><tr><th scope="col">海克斯</th><th scope="col" class="stats-number">持有胜率</th><th scope="col" class="stats-number">胜率增幅</th><th scope="col" class="stats-number">海克斯样本</th><th scope="col" class="stats-optional">样本状态</th><th scope="col">出装</th></tr></thead><tbody>${augments.map(row=>`<tr class="${state.expanded===String(row.id)?'stats-is-expanded':''}"><td><button class="stats-augment-button" data-stats-action="expand" data-stats-id="${esc(row.id)}" aria-expanded="${state.expanded===String(row.id)}">${icon(row.icon)}<span><strong>${esc(row.name)}</strong><small class="stats-rarity-${esc(row.rarity)}">${esc(rarityNames[row.rarity]||'品质待核对')}</small></span></button></td><td class="stats-number">${percent(row.winRate)}</td><td class="stats-number"><strong class="${row.deltaPp>0?'stats-positive':row.deltaPp<0?'stats-negative':''}">${delta(row.deltaPp)}${Number.isFinite(row.deltaPp)?'<small class="stats-unit"> 个百分点</small>':''}</strong>${!row.comparable?`<small class="stats-uncomparable" title="${esc(row.comparisonReason||'与英雄基线统计范围不同，不能计算差值')}">不可比较</small>`:''}</td><td class="stats-number">${row.hasStats?number(row.games):'—'}</td><td class="stats-optional"><div class="stats-row-badges">${row.lowSample?'<span class="stats-badge stats-warning">低样本</span>':''}${row.provisional?'<span class="stats-badge stats-warning">测试服参考</span>':''}${row.outdated?'<span class="stats-badge stats-warning">旧版</span>':''}${!row.isCurrent&&!row.provisional&&!row.outdated?'<span class="stats-badge">非当前可选</span>':''}${row.comparable&&!row.lowSample?'<span class="stats-badge">同口径</span>':''}</div></td><td><button class="stats-row-open" data-stats-action="expand" data-stats-id="${esc(row.id)}" aria-expanded="${state.expanded===String(row.id)}">${state.expanded===String(row.id)?'收起':'出装'} <span aria-hidden="true">${state.expanded===String(row.id)?'⌃':'⌄'}</span></button></td></tr>${state.expanded===String(row.id)?build(row,c):''}`).join('')||'<tr><td colspan="6" class="stats-empty">暂无符合条件的统计。可缩短搜索词或开启“包含低样本”查看参考资料。</td></tr>'}</tbody></table></div></section>`;
  }
  function content(){
    if(error)return `<div class="stats-empty" role="alert"><h1>统计资料暂未载入</h1><p>${esc(error)}</p><button class="secondary-button" data-stats-action="retry">重新载入统计</button><p>海克斯库与联动查询仍可继续使用。</p></div>`;
    if(!index)return '<div class="stats-empty" role="status"><h1>正在读取英雄胜率</h1><p>首次打开需要载入统计快照…</p></div>';
    return state.championId?detail():list();
  }
  function html(){if(!loaded&&!loading&&!error)load();return `<div id="statistics-root" class="statistics-page" ${target('stats-content','英雄胜率统计内容',true)}>${content()}</div>`;}
  function redraw(){
    const root=document.getElementById('statistics-root');if(!root)return;
    replacePreservingFocus(root,()=>{root.innerHTML=content();});
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-stats-action]');if(!button||!button.closest('#statistics-root'))return;
    const action=button.dataset.statsAction,id=button.dataset.statsId;
    if(action==='retry'){error='';load();redraw();return;}
    if(!index)return;
    if(action==='champion'){state.championId=String(id);state.augmentQuery='';state.rarity='all';state.expanded='';redraw();document.getElementById('statistics-root')?.scrollIntoView({block:'start',behavior:'instant'});}
    else if(action==='back'){state.championId='';state.expanded='';redraw();}
    else if(action==='expand'){state.expanded=state.expanded===String(id)?'':String(id);ensureObservations();redraw();}
    else if(action==='retry-build'){ensureObservations(true);redraw();}
  });
  document.addEventListener('input',event=>{
    if(event.target.id==='stats-champion-search'){state.query=event.target.value;redraw();}
    else if(event.target.id==='stats-augment-search'){state.augmentQuery=event.target.value;state.expanded='';redraw();}
  });
  document.addEventListener('change',event=>{
    if(event.target.id==='stats-champion-sort')state.sort=event.target.value;
    else if(event.target.id==='stats-rarity'){state.rarity=event.target.value;state.expanded='';}
    else if(event.target.id==='stats-low-sample'){state.includeLowSample=event.target.checked;state.expanded='';}
    else if(event.target.id==='stats-unavailable'){state.includeUnavailable=event.target.checked;state.expanded='';}
    else return;
    redraw();
  });
  return Object.freeze({html});
}

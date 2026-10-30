import {renderOfficialSections} from './official-announcements.js';
const token=()=>sessionStorage.getItem('hexguide-local-session')||(location.hash.startsWith('#session=')?decodeURIComponent(location.hash.slice(9)):'');
const make=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
const announcementDate=row=>row.official?`官网公告 ${row.official.date.replaceAll('-','/')}`:'官网公告日期待确认';
const counts=row=>[row.championCount?`${row.championCount} 位英雄`:'',row.itemCount?`${row.itemCount} 件装备`:'',row.augmentCount?`${row.augmentCount} 个海克斯`:''].filter(Boolean).join(' · ')||`${row.changeCount} 项改动`;
const formatValue=value=>Array.isArray(value)?(value.every(v=>v===value[0])?formatValue(value[0]):value.map(formatValue).join(' / ')):new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6,useGrouping:false}).format(value);
const numberText=(value,row)=>`${formatValue(Array.isArray(value)?value.map(v=>v*row.scale):value*row.scale)}${row.unit}`;
let list={entries:[],unreadCount:0},busy=false,selectedId=null,selection=0,opener;
const button=make('button','appearance-button announcement-open','更新公告');
button.type='button';button.id='announcement-open';button.setAttribute('aria-controls','announcement-panel');button.setAttribute('aria-expanded','false');
button.dataset.uiId='site-announcements';button.dataset.uiLabel='更新公告入口';
const badge=make('span','announcement-badge');badge.hidden=true;button.append(badge);
const header=document.querySelector('.topbar');header?.insertBefore(button,header.querySelector('.source-button'));
const banner=make('div','announcement-banner');banner.hidden=true;banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');
const bannerText=make('span'),bannerOpen=make('button','announcement-link','查看公告');bannerOpen.type='button';banner.append(bannerText,bannerOpen);header?.after(banner);
const panel=make('section','announcement-panel');panel.id='announcement-panel';panel.hidden=true;panel.setAttribute('aria-labelledby','announcement-title');
const panelHeader=make('header','announcement-header'),title=make('h2',null,'更新公告');title.id='announcement-title';title.tabIndex=-1;
const close=make('button','secondary-button','关闭');close.type='button';panelHeader.append(title,close);
const toolbar=make('div','announcement-toolbar'),check=make('button','secondary-button','检查更新'),status=make('p','announcement-status');check.type='button';status.setAttribute('role','status');
toolbar.append(status,check);
const content=make('div','announcement-content');panel.append(panelHeader,toolbar,content);document.body.append(panel);
async function api(route,body) {
  const auth=token();if(!auth)throw Error('desktop-required');
  const response=await fetch(`/api/announcements${route}`,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(18000),
    headers:{'x-hexguide-session':auth,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error('request-failed');return response.json();
}
function updateBadge() {
  const unread=list.unreadCount;badge.hidden=!unread;badge.textContent=String(unread);button.setAttribute('aria-label',unread?`更新公告，${unread} 条未读`:'更新公告');
  banner.hidden=!unread;bannerText.textContent=`有 ${unread} 条游戏数值更新公告`;
}
function updateStatus() {
  status.textContent=list.error?'暂时无法检查新公告，已保存的历史仍可查看。':list.lastCheckedAt?`上次检查 ${new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(list.lastCheckedAt))}`:'正在检查公告…';
}
function renderList() {
  content.replaceChildren();selectedId=null;selection++;
  if(!list.entries.length) { content.append(make('p','announcement-empty','还没有数值更新公告。有装备或海克斯数值变化时，会在这里显示。'));return; }
  const items=make('ol','announcement-list');
  const archived=make('details','announcement-archived'),archiveTitle=make('summary',null,'较早的资源差异记录（已由官网公告补全）'),archiveItems=make('ol','announcement-list');archived.append(archiveTitle,archiveItems);
  for(const row of list.entries) {
    const item=make('li'),link=make('button','announcement-row');link.type='button';link.dataset.announcementId=row.id;
    const heading=make('span','announcement-row-title',row.title),meta=make('span','announcement-row-meta',`${announcementDate(row)} · ${counts(row)}`);
    if(!row.read)heading.append(make('span','announcement-unread','未读'));
    link.append(heading,meta);link.addEventListener('click',()=>void showArticle(row.id));item.append(link);(row.supersededBy?archiveItems:items).append(item);
  }
  content.append(items);if(archiveItems.children.length)content.append(archived);
}
async function refresh(force=false) {
  if(busy)return;busy=true;check.disabled=true;
  if(force)status.textContent='正在检查更新…';
  try { list=await api(force?'/check':'',force?{}:undefined);updateBadge();updateStatus();if(!panel.hidden&&!selectedId)renderList(); }
  catch(error) { if(!panel.hidden)status.textContent=error.message==='desktop-required'?'请在海克斯指南桌面版中查看自动更新公告。':'公告暂时无法载入，请稍后重试。'; }
  finally{busy=false;check.disabled=false;}
}
function openPanel(event) {
  if(window.hexguideLayout?.isEditing()){window.hexguideLayout.notify?.('请先保存或取消界面编辑，再查看公告。');return;}
  opener=event?.currentTarget??button;panel.hidden=false;button.setAttribute('aria-expanded','true');renderList();updateStatus();title.focus({preventScroll:true});void refresh();
}
function closePanel(){selection++;selectedId=null;panel.hidden=true;button.setAttribute('aria-expanded','false');(opener?.offsetParent?opener:document.querySelector('#main'))?.focus({preventScroll:true});}
async function showArticle(id) {
  const request=++selection;selectedId=id;content.replaceChildren(make('p','announcement-empty','正在载入公告…'));
  try {
    const article=await api(`/${id}`);if(request!==selection||panel.hidden)return;
    const back=make('button','announcement-link','返回公告列表');back.type='button';back.addEventListener('click',()=>{renderList();content.querySelector('button')?.focus({preventScroll:true});});
    const articleElement=make('article','announcement-article'),heading=make('h3',null,article.title);heading.tabIndex=-1;
    articleElement.append(heading,make('p','announcement-row-meta',`${announcementDate(article)}${article.schemaVersion===2?'':` · ${article.fromVersion} → ${article.toVersion}`}`));
    if(article.official){const link=make('a','announcement-official','查看联盟官网原文 ↗');link.href=article.official.url;link.target='_blank';link.rel='noopener noreferrer';articleElement.append(link);}
    articleElement.append(make('p','announcement-summary',article.summary));
    if(article.schemaVersion===2)articleElement.append(renderOfficialSections(article));
    else for(const [kind,label] of [['champion','英雄技能'],['item','装备'],['augment','海克斯']]) {
      const rows=article.changes.filter(row=>row.kind===kind);if(!rows.length)continue;
      articleElement.append(make('h4',null,label));
      const table=make('table','announcement-table'),caption=make('caption','announcement-sr-only',`${label}数值变化`),thead=make('thead'),tr=make('tr');
      for(const label of ['属性','调整前','调整后']){const th=make('th',null,label);th.scope='col';tr.append(th);}thead.append(tr);table.append(caption,thead);
      const groups=new Map();
      for(const row of rows){const key=JSON.stringify([row.entityId,row.ability?.slot??'']);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
      for(const changes of groups.values()) {
        const row=changes[0],tbody=make('tbody'),groupHeading=make('tr','announcement-entity-heading'),name=make('th');name.scope='rowgroup';name.colSpan=3;
        const identity=make('div','announcement-identity'),copy=make('div','announcement-identity-copy');
        if(row.icon){const icon=make('img','announcement-icon');icon.src=row.icon;icon.alt='';icon.title=row.ability?`${row.name} · ${row.ability.slot} ${row.ability.name}`:row.name;icon.width=40;icon.height=40;icon.loading='lazy';icon.decoding='async';icon.referrerPolicy='no-referrer';icon.addEventListener('error',()=>{icon.hidden=true;},{once:true});identity.append(icon);}
        copy.append(make('span','announcement-entity',row.name));
        if(row.ability)copy.append(make('span','announcement-ability',`${row.ability.slot} · ${row.ability.name}`));
        identity.append(copy);name.append(identity);groupHeading.append(name);tbody.append(groupHeading);
        for(const change of changes){
          const tr=make('tr','announcement-adjustment'),property=make('th','announcement-property',change.label);property.scope='row';
          tr.append(property,make('td','announcement-number',numberText(change.before,change)),make('td','announcement-number',numberText(change.after,change)));tbody.append(tr);
        }
        table.append(tbody);
      }
      articleElement.append(table);
    }
    articleElement.append(make('p','announcement-scope',article.scopeNote),make('h4',null,'资料来源'));
    const sources=make('ul','announcement-sources');
    for(const source of article.sources) {const item=make('li'),link=make('a',null,source.name);link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';item.append(link);sources.append(item);}
    articleElement.append(sources);content.replaceChildren(back,articleElement);content.scrollTop=0;heading.focus({preventScroll:true});
    try{list=await api('/read',{id});updateBadge();}catch{status.textContent='已打开公告，未读状态未能保存。下次可重试。';}
  }catch{
    if(request!==selection||panel.hidden)return;
    const back=make('button','announcement-link','返回公告列表');back.type='button';back.addEventListener('click',renderList);
    content.replaceChildren(make('p','announcement-empty','这条公告尚未缓存，当前无法下载。请联网后重试。'),back);
  }
}
button.addEventListener('click',openPanel);bannerOpen.addEventListener('click',openPanel);close.addEventListener('click',closePanel);check.addEventListener('click',()=>void refresh(true));
panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closePanel();}});
void refresh();setInterval(()=>{if(!document.hidden)void refresh();},60000);

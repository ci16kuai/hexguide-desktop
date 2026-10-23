import {createDefaultLayout,validateLayout,UI_ELEMENTS} from './layout-config.js';

// The editor stores appearance only. Hero choices, game data and recommendations
// continue to belong to the existing application and are never changed here.
const STORAGE_KEY='hexguide-layout-v1';
const registry=new Map(UI_ELEMENTS.map(item=>[item.id,item]));
const fonts={system:'"Microsoft YaHei","PingFang SC",system-ui,sans-serif',yahei:'"Microsoft YaHei","PingFang SC",sans-serif',dengxian:'DengXian,"Microsoft YaHei",sans-serif',simsun:'SimSun,"Songti SC",serif'};
const fontNames={system:'跟随系统',yahei:'微软雅黑',dengxian:'等线',simsun:'宋体'};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const copy=value=>validateLayout(value);
const token=()=>sessionStorage.getItem('hexguide-local-session')||(location.hash.startsWith('#session=')?decodeURIComponent(location.hash.slice(9)):'');
let saved=createDefaultLayout(),draft=null,editing=false,saving=false,selectedId='',hoverId='',drag=null,notice='',loading,scheduled=false;
let history=[],historyIndex=0,fieldTransaction='',baselineOrders=new WeakMap(),lastRuleText='';
let trigger=null;
try{saved=copy(JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'));}catch{/* Invalid or outdated settings use the supported defaults. */}

const root=document.createElement('div');
root.id='layout-editor';
root.dataset.layoutEditor='';
root.innerHTML=`<button type="button" class="layout-launcher" data-layout-action="open" aria-label="编辑整个界面"><span aria-hidden="true">▦</span> 编辑界面</button><div class="layout-editor-chrome" hidden><div class="layout-editbar" role="toolbar" aria-label="界面编辑操作"><span class="layout-mode-mark" aria-hidden="true">▦</span><div class="layout-editbar-title"><strong>正在编辑界面</strong><small>点击模块修改；拖动选中框的抓手调整排列。</small></div><div class="layout-history"><button type="button" data-layout-action="undo" aria-label="撤销修改" title="撤销 Ctrl+Z">↶</button><button type="button" data-layout-action="redo" aria-label="重做修改" title="重做 Ctrl+Shift+Z">↷</button></div><button type="button" class="layout-quiet" data-layout-action="cancel">取消</button><button type="button" class="layout-save" data-layout-action="save">保存并退出</button></div><aside class="layout-inspector" aria-label="界面编辑器"><header class="layout-inspector-head"><span class="layout-eyebrow">手动安排你的助手</span><h2>编辑整个界面</h2><p>只修改显示方式。删除的模块随时能恢复。</p></header><div class="layout-inspector-scroll"><label class="layout-page-field">正在编辑<select aria-label="切换要编辑的页面" data-layout-page><option value="live">实战助手</option><option value="library">海克斯库</option><option value="champions">英雄适配</option><option value="synergy">联动查询</option><option value="compare">三选一推荐</option></select></label><div id="layout-selection-panel"></div><details class="layout-module-tree"><summary>当前页面的模块 <span id="layout-module-count"></span></summary><div id="layout-modules"></div></details><details class="layout-hidden-list" open><summary>已删除的模块 <span id="layout-hidden-count"></span></summary><div id="layout-hidden-elements"></div></details><div class="layout-reset-area"><button type="button" data-layout-action="reset">恢复整个界面默认布局</button><small>先预览默认布局，保存后生效。</small></div></div><footer class="layout-inspector-footer"><p id="layout-editor-status" role="status" aria-live="polite"></p></footer></aside><div class="layout-selection-tools" hidden><button type="button" class="layout-drag-handle" data-layout-drag aria-label="拖动选中模块调整排列" title="按住拖动，在同组模块之间排列"><span aria-hidden="true">⠿</span><span class="layout-selection-name"></span></button><button type="button" data-layout-action="parent" title="选择上层模块" aria-label="选择上层模块">↰</button><button type="button" data-layout-action="hide" title="删除选中模块，可以恢复" aria-label="从界面删除选中模块">×</button></div><div class="layout-drop-marker" hidden></div></div>`;
document.body.append(root);
const rules=document.createElement('style');rules.id='layout-custom-styles';document.head.append(rules);
const chrome=root.querySelector('.layout-editor-chrome');
const inspector=root.querySelector('.layout-inspector');
const panel=root.querySelector('#layout-selection-panel');
const tools=root.querySelector('.layout-selection-tools');
const marker=root.querySelector('.layout-drop-marker');
const current=()=>editing?draft:saved;
const find=id=>document.querySelector(`[data-ui-id="${id}"]`);
const label=id=>registry.get(id)?.label||find(id)?.dataset.uiLabel||id;
const cache=value=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify(value));return true;}catch{return false;}};
const dirty=()=>editing&&JSON.stringify(draft)!==JSON.stringify(saved);
const parentId=element=>element?.parentElement?.dataset.uiContainer||element?.parentElement?.dataset.uiId||'';
const siblings=element=>[...(element?.parentElement?.children||[])].filter(child=>registry.has(child.dataset.uiId));

function buildRules(value){
  // Ancestors are written first so that an explicitly styled child wins.
  const depth=id=>{let n=registry.get(id),count=0;while(n?.parent&&count<30){count++;n=registry.get(n.parent);}return count;};
  const orderRules=Object.entries(value.orders).flatMap(([parentId,ids])=>{
    const ordered=[...ids],parent=find(parentId),baseline=parent?baselineOrders.get(parent):null;
    for(const id of baseline||UI_ELEMENTS.filter(item=>item.parent===parentId).map(item=>item.id))if(!ordered.includes(id))ordered.push(id);
    return ordered.map((id,index)=>`:root [data-ui-id="${id}"]{order:${index}!important;grid-column:auto!important;grid-row:auto!important}`);
  }).join('\n');
  return orderRules+'\n'+Object.entries(value.elements).sort(([a],[b])=>depth(a)-depth(b)).map(([id,s])=>{
    const selector=`:root [data-ui-id="${id}"]`;
    const properties=[],text=[];
    if(s.fontFamily)text.push(`font-family:${fonts[s.fontFamily]}!important`);
    if(s.fontSize!==undefined)text.push(`font-size:${s.fontSize}px!important`);
    if(s.color)text.push(`color:${s.color}!important`);
    if(s.background)properties.push(`background:${s.background}!important`);
    if(s.padding!==undefined)properties.push(`padding:${s.padding}px!important`);
    if(s.align)properties.push(`text-align:${s.align}!important`);
    if(s.width!==undefined)properties.push(`width:${s.width?s.width+'px':'auto'}!important`,'max-width:100%!important','min-width:0!important');
    if(s.height!==undefined)properties.push(`min-height:${s.height}px!important`);
    if(s.borderRadius!==undefined)properties.push(`border-radius:${s.borderRadius}px!important`);
    if(s.columns!==undefined)properties.push('display:grid!important',`grid-template-columns:repeat(${s.columns},minmax(0,1fr))!important`,'align-items:start!important');
    if(s.gap!==undefined)properties.push(`gap:${s.gap}px!important`);
    if(s.span!==undefined){const parent=registry.get(id)?.parent,columns=value.elements[parent]?.columns;if(columns!==undefined)properties.push(`grid-column:span ${Math.min(s.span,columns)}!important`);}
    if(s.hidden)properties.push('display:none!important');
    return `${properties.length?selector+'{'+properties.join(';')+'}':''}${text.length?selector+','+selector+' :where(*){'+text.join(';')+'}':''}`;
  }).join('\n');
}
function applyOrders(value){
  for(const definition of UI_ELEMENTS){
    if(!definition.container)continue;
    const parent=find(definition.id);if(!parent)continue;
    const children=[...parent.children].filter(child=>registry.get(child.dataset.uiId)?.parent===definition.id);
    if(children.length<2)continue;
    if(!baselineOrders.has(parent))baselineOrders.set(parent,children.map(child=>child.dataset.uiId));
    const baseline=baselineOrders.get(parent),wanted=[...(value.orders[definition.id]||[])];
    for(const id of baseline)if(!wanted.includes(id))wanted.push(id);
    for(const child of children)if(!wanted.includes(child.dataset.uiId))wanted.push(child.dataset.uiId);
    const sorted=[...children].sort((a,b)=>wanted.indexOf(a.dataset.uiId)-wanted.indexOf(b.dataset.uiId));
    if(sorted.every((child,index)=>child===children[index]))continue;
    // Comments preserve the positions of uneditable children and text nodes.
    const slots=children.map(child=>{const slot=document.createComment('layout-slot');child.replaceWith(slot);return slot;});
    slots.forEach((slot,index)=>slot.replaceWith(sorted[index]));
  }
}
function apply(){
  const value=current();
  const css=buildRules(value);if(css!==lastRuleText){rules.textContent=css;lastRuleText=css;}
  applyOrders(value);
  document.querySelectorAll('[data-layout-selected]').forEach(element=>{if(!editing||element.dataset.uiId!==selectedId)element.removeAttribute('data-layout-selected');});
  document.querySelectorAll('[data-layout-hover]').forEach(element=>{if(!editing||element.dataset.uiId!==hoverId)element.removeAttribute('data-layout-hover');});
  if(editing){
    const selected=find(selectedId);if(selected&&!selected.hasAttribute('data-layout-selected'))selected.dataset.layoutSelected='';
    const hover=find(hoverId);if(hover&&hoverId!==selectedId&&!hover.hasAttribute('data-layout-hover'))hover.dataset.layoutHover='';
    positionTools();
  }
}
function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;apply();if(editing)renderLists();});}
const observer=new MutationObserver(records=>{if(records.some(record=>!root.contains(record.target)&&record.target!==rules))schedule();});
observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-ui-id','data-ui-container','hidden']});

function status(message,error=false){const element=root.querySelector('#layout-editor-status');element.textContent=message;element.classList.toggle('layout-error',error);}
function updateState(){
  const isDirty=dirty();
  root.querySelector('[data-layout-action="undo"]').disabled=saving||historyIndex===0;
  root.querySelector('[data-layout-action="redo"]').disabled=saving||historyIndex>=history.length-1;
  root.querySelector('[data-layout-action="save"]').disabled=saving;
  root.querySelector('.layout-editbar-title strong').textContent=isDirty?'正在编辑界面 · 未保存':'正在编辑界面';
  status(notice||(token()?'设置保存在这台电脑，重新打开后仍有效。':'网页预览：设置保存在当前浏览器。'));
}
function pushHistory(){
  const value=JSON.stringify(draft);if(history[historyIndex]===value)return;
  history=history.slice(0,historyIndex+1);history.push(value);
  if(history.length>80)history.shift();historyIndex=history.length-1;
}
function changed({render=false,message=''}={}){
  draft=copy(draft);pushHistory();notice=message;apply();if(render)renderPanel();renderLists();updateState();
}
function choose(id,{scroll=false}={}){
  if(!registry.has(id))return;selectedId=id;hoverId='';fieldTransaction='';apply();renderPanel();
  if(scroll)find(id)?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});
}
function field(key,title,type='number',min=0,max=64,unit='px'){
  const value=draft.elements[selectedId]?.[key],id=`layout-field-${key}`;
  return `<label class="layout-field" for="${id}"><span>${title}<button type="button" data-layout-reset-field="${key}" aria-label="还原${title}" title="还原默认${title}"${value===undefined?' disabled':''}>↺</button></span><div class="layout-input-unit"><input id="${id}" name="${key}" type="${type}" ${type==='number'?`min="${min}" max="${max}" step="1" inputmode="numeric"`:''} value="${esc(value??'')}" placeholder="默认" autocomplete="off">${unit?`<small>${unit}</small>`:''}</div></label>`;
}
function selectField(key,title,values,{disabled=false}={}){
  const value=draft.elements[selectedId]?.[key];
  const needsParentColumns=key==='span'&&draft.elements[registry.get(selectedId)?.parent]?.columns===undefined;
  disabled=disabled||needsParentColumns;
  return `<label class="layout-field"><span>${title}<button type="button" data-layout-reset-field="${key}" aria-label="还原${title}" title="还原默认${title}"${value===undefined?' disabled':''}>↺</button></span><select name="${key}"${disabled?' disabled':''}><option value="">默认</option>${Object.entries(values).map(([id,name])=>`<option value="${id}"${String(value)===id?' selected':''}>${name}</option>`).join('')}</select></label>${needsParentColumns?'<p class="layout-field-hint">先选择上层模块并设置布局列数，再调整占据列数。恢复上层默认布局后，占列效果也会还原。</p>':''}`;
}
function computedHex(value,fallback){if(/^#[\da-f]{6}$/i.test(value||''))return value;const match=String(value).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);return match?'#'+match.slice(1).map(n=>Number(n).toString(16).padStart(2,'0')).join(''):fallback;}
function colorField(key,title,fallback){const value=draft.elements[selectedId]?.[key],computed=find(selectedId)?getComputedStyle(find(selectedId))[key==='background'?'backgroundColor':'color']:'',hex=computedHex(value||computed,fallback);return `<label class="layout-field layout-color-field"><span>${title}<button type="button" data-layout-reset-field="${key}" aria-label="还原${title}" title="还原默认${title}"${value===undefined?' disabled':''}>↺</button></span><div><input type="color" name="${key}" value="${esc(hex)}" aria-label="${title}"><span data-layout-color-label="${key}">${value==='transparent'?'透明':value||'默认'}</span>${key==='background'?'<button type="button" data-layout-action="transparent">透明</button>':''}</div></label>`;}
function renderPanel(){
  const definition=registry.get(selectedId),element=find(selectedId);
  if(!definition||!element){panel.innerHTML='<div class="layout-pick-hint"><span aria-hidden="true">⌖</span><h3>先点击要修改的地方</h3><p>标题、提示、数据栏和卡片都可以选择。也可以从下方模块列表中选择。</p></div>';tools.hidden=true;return;}
  const style=draft.elements[selectedId]||{},group=siblings(element),index=group.indexOf(element),canOrder=group.length>1&&registry.get(parentId(element))?.container;
  const ancestors=[];let ancestor=element.parentElement?.closest('[data-ui-id]');while(ancestor){if(registry.has(ancestor.dataset.uiId))ancestors.unshift(ancestor.dataset.uiId);ancestor=ancestor.parentElement?.closest('[data-ui-id]');}
  panel.innerHTML=`<div class="layout-selected-head"><div class="layout-breadcrumbs">${ancestors.map(id=>`<button type="button" data-layout-select="${id}" title="选择${esc(label(id))}">${esc(label(id))}</button>`).join('<span>›</span>')}</div><h3>${esc(definition.label)}</h3><span class="layout-selected-kind">${definition.container?'布局容器':'界面模块'}</span></div><div class="layout-move-controls"><button type="button" data-layout-action="up"${!canOrder||index<1?' disabled':''}>↑ 上移</button><button type="button" data-layout-action="down"${!canOrder||index===group.length-1?' disabled':''}>↓ 下移</button><button type="button" class="layout-delete" data-layout-action="hide">× 删除</button></div><p class="layout-field-hint">${canOrder?'也可按住选中框上方的 ⠿ 抓手，拖到同组模块之间。':'可调整外观；从上方路径选择父模块可调整整个区域。'}</p><form id="layout-style-form"><fieldset><legend>文字</legend>${selectField('fontFamily','字体',fontNames)}<div class="layout-two-fields">${field('fontSize','文字大小','number',10,60)}${selectField('align','文字对齐',{left:'左对齐',center:'居中',right:'右对齐'})}</div>${colorField('color','文字颜色','#e8edf3')}</fieldset><fieldset><legend>外观与尺寸</legend>${colorField('background','模块底色','#111e2d')}<div class="layout-two-fields">${field('padding','内部留白','number',0,64)}${field('borderRadius','圆角','number',0,32)}${field('width','宽度','number',0,1600)}${field('height','最小高度','number',0,900)}</div><p class="layout-field-hint">留空使用原设计；宽度 0 表示自动。内容过多时高度会自动延长。</p></fieldset>${definition.container?`<fieldset><legend>模块排列</legend><div class="layout-two-fields">${selectField('columns','布局列数',{'1':'一列','2':'两列','3':'三列'})}${field('gap','模块间距','number',0,48)}</div><p class="layout-field-hint">将这个区域排成一至三列。选中内部模块，可以调整它占据的列数。</p></fieldset>`:''}${registry.get(definition.parent)?.container?`<fieldset><legend>在上层布局中</legend>${selectField('span','占据列数',{'1':'一列','2':'两列','3':'三列'})}</fieldset>`:''}</form><button class="layout-reset-selected" type="button" data-layout-action="reset-selected">还原这个模块的外观</button>${style.hidden?'<p class="layout-field-hint">此模块已删除，可在下方清单恢复。</p>':''}`;
  positionTools();
}
function renderLists(){
  const available=UI_ELEMENTS.filter(item=>find(item.id)),hidden=Object.entries(draft.elements).filter(([,s])=>s.hidden).map(([id])=>id);
  const modules=root.querySelector('#layout-modules');
  const moduleMarkup=available.map(item=>{let depth=0,parent=item.parent;while(parent&&depth<8){depth++;parent=registry.get(parent)?.parent;}return `<div class="layout-tree-item${selectedId===item.id?' is-selected':''}"><button type="button" data-layout-select="${item.id}" style="--layout-depth:${Math.min(depth,4)}" title="选择${esc(item.label)}"><span aria-hidden="true">${item.container?'▤':'·'}</span>${esc(item.label)}${draft.elements[item.id]?.hidden?'<small>已删除</small>':''}</button></div>`;}).join('');
  if(modules.innerHTML!==moduleMarkup)modules.innerHTML=moduleMarkup;
  root.querySelector('#layout-module-count').textContent=String(available.length);
  const list=root.querySelector('#layout-hidden-elements');
  const hiddenMarkup=hidden.length?hidden.map(id=>`<div class="layout-hidden-item"><span>${esc(label(id))}${find(id)?'':'<small>其他页面</small>'}</span><button type="button" data-layout-restore="${id}">恢复</button></div>`).join(''):'<p class="layout-list-empty">还没有删除任何模块。</p>';
  if(list.innerHTML!==hiddenMarkup)list.innerHTML=hiddenMarkup;
  root.querySelector('#layout-hidden-count').textContent=String(hidden.length);
}
function positionTools(){
  const element=find(selectedId);if(!editing||!element||!element.getClientRects().length||draft.elements[selectedId]?.hidden){tools.hidden=true;return;}
  const rect=element.getBoundingClientRect(),editorRect=inspector.getBoundingClientRect(),right=innerWidth>800?editorRect.left:innerWidth;
  if(rect.bottom<60||rect.top>innerHeight||rect.left>right){tools.hidden=true;return;}
  tools.hidden=false;tools.querySelector('.layout-selection-name').textContent=label(selectedId);
  const maxLeft=Math.max(8,right-tools.offsetWidth-8);
  tools.style.left=`${Math.min(Math.max(8,rect.left),maxLeft)}px`;
  tools.style.top=`${Math.max(59,Math.min(rect.top-33,innerHeight-tools.offsetHeight-8))}px`;
  tools.querySelector('[data-layout-action="parent"]').disabled=!element.parentElement?.closest('[data-ui-id]');
  const group=siblings(element),canDrag=group.length>1&&registry.get(parentId(element))?.container;
  tools.querySelector('[data-layout-drag]').disabled=!canDrag;
}
function move(direction){const element=find(selectedId),group=siblings(element),index=group.indexOf(element),next=index+direction,id=parentId(element);if(!registry.get(id)?.container||index<0||next<0||next>=group.length)return;const order=group.map(child=>child.dataset.uiId);[order[index],order[next]]=[order[next],order[index]];draft.orders[id]=order;fieldTransaction='';changed({render:true,message:`已将“${label(selectedId)}”${direction<0?'上移':'下移'}。`});}
function hide(){if(!selectedId)return;draft.elements[selectedId]={...draft.elements[selectedId],hidden:true};fieldTransaction='';changed({render:true,message:`已从界面删除“${label(selectedId)}”，可在清单中恢复。`});}
function restore(id){if(!registry.has(id))return;const value={...draft.elements[id]};delete value.hidden;if(Object.keys(value).length)draft.elements[id]=value;else delete draft.elements[id];fieldTransaction='';changed({render:true,message:`已恢复“${label(id)}”。`});}
function undo(direction){const next=historyIndex+direction;if(next<0||next>=history.length)return;historyIndex=next;draft=copy(JSON.parse(history[next]));fieldTransaction='';notice=direction<0?'已撤销上一步修改。':'已重做修改。';apply();renderPanel();renderLists();updateState();}
async function open(){
  await loading;if(editing)return;
  const appearance=document.querySelector('#appearance-dialog[open]');
  if(appearance){const cancel=appearance.querySelector('[data-appearance-action="cancel"]');if(cancel)cancel.click();else appearance.close();}
  trigger=document.activeElement;draft=copy(saved);editing=true;selectedId='';hoverId='';fieldTransaction='';history=[JSON.stringify(draft)];historyIndex=0;
  chrome.hidden=false;root.querySelector('.layout-launcher').hidden=true;document.documentElement.classList.add('layout-editing');
  root.querySelector('[data-layout-page]').value=['live','library','champions','synergy','compare'].includes(location.hash.slice(1))?location.hash.slice(1):'library';
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
  apply();renderPanel();renderLists();updateState();root.querySelector('[data-layout-action="save"]').focus({preventScroll:true});
}
function close({restoreFocus=true}={}){
  if(saving)return;editing=false;draft=null;drag=null;hoverId='';selectedId='';chrome.hidden=true;root.querySelector('.layout-launcher').hidden=false;document.documentElement.classList.remove('layout-editing','layout-dragging');marker.hidden=true;tools.hidden=true;apply();if(restoreFocus)trigger?.focus({preventScroll:true});
}
async function load(){
  if(!token()){apply();return;}
  try{const response=await fetch('/api/layout',{headers:{'X-Hexguide-Session':token()},cache:'no-store',signal:AbortSignal.timeout(4500)});if(!response.ok)throw Error('未能读取已保存的布局。保存时会重试。');saved=copy(await response.json());cache(saved);notice='';if(!editing)apply();}
  catch(error){notice=error.name==='TimeoutError'?'读取布局超时，可继续调整；保存时会重试。':error.message;}
}
async function save(){
  if(saving||!editing)return;let value;
  const form=panel.querySelector('#layout-style-form');if(form&&!form.reportValidity()){status('请先修正超出范围的数值，再保存布局。',true);return;}
  try{value=copy(draft);}catch{status('有不支持的布局值，请还原当前模块后重试。',true);return;}
  saving=true;root.querySelectorAll('button,input,select').forEach(element=>element.disabled=true);status('正在保存布局…');
  try{
    if(token()){
      const response=await fetch('/api/layout',{method:'POST',headers:{'Content-Type':'application/json','X-Hexguide-Session':token()},body:JSON.stringify(value),signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error(response.status===401?'本机会话已失效，请重新打开软件后保存。':'保存失败，你的调整仍保留在编辑器中，请重试。');
      value=copy(await response.json());cache(value);
    }else if(!cache(value))throw Error('浏览器无法保存布局，请允许本地存储后重试。');
    saved=value;saving=false;root.querySelectorAll('button,input,select').forEach(element=>element.disabled=false);notice='';close();
    window.dispatchEvent(new CustomEvent('hexguide-layout-saved',{detail:copy(saved)}));
    const toast=document.querySelector('#toast');if(toast){toast.textContent='界面布局已保存';toast.classList.add('visible');setTimeout(()=>toast.classList.remove('visible'),3000);}
  }catch(error){saving=false;root.querySelectorAll('button,input,select').forEach(element=>element.disabled=false);notice=error.name==='TimeoutError'?'保存超时，你的调整仍保留，请重试。':error.message;renderPanel();updateState();status(notice,true);}
}

root.addEventListener('click',event=>{
  const select=event.target.closest('[data-layout-select]');if(select){choose(select.dataset.layoutSelect,{scroll:true});return;}
  const restoreButton=event.target.closest('[data-layout-restore]');if(restoreButton){restore(restoreButton.dataset.layoutRestore);return;}
  const reset=event.target.closest('[data-layout-reset-field]');if(reset&&selectedId){const key=reset.dataset.layoutResetField;delete draft.elements[selectedId]?.[key];if(!Object.keys(draft.elements[selectedId]||{}).length)delete draft.elements[selectedId];fieldTransaction='';changed({render:true});return;}
  const button=event.target.closest('[data-layout-action]');if(!button||saving)return;
  switch(button.dataset.layoutAction){
    case 'open':void open();break;
    case 'cancel':notice='';close();break;
    case 'save':void save();break;
    case 'undo':undo(-1);break;
    case 'redo':undo(1);break;
    case 'up':move(-1);break;
    case 'down':move(1);break;
    case 'hide':hide();break;
    case 'parent':{const parent=find(selectedId)?.parentElement?.closest('[data-ui-id]');if(parent)choose(parent.dataset.uiId);break;}
    case 'transparent':draft.elements[selectedId]={...draft.elements[selectedId],background:'transparent'};fieldTransaction='';changed({render:true});break;
    case 'reset-selected':delete draft.elements[selectedId];fieldTransaction='';changed({render:true,message:'已还原这个模块的外观。'});break;
    case 'reset':draft=createDefaultLayout();fieldTransaction='';changed({render:true,message:'已预览整个界面的默认布局。保存后生效。'});break;
  }
});
root.addEventListener('submit',event=>event.preventDefault());
root.addEventListener('input',event=>{
  const input=event.target;if(!editing||saving||!selectedId||!input.closest('#layout-style-form')||!input.name)return;
  const key=input.name,value=input.value,next={...draft.elements[selectedId]};
  if(value==='')delete next[key];else next[key]=input.type==='number'||['columns','span'].includes(key)?Number(value):value;
  const candidate={...draft,elements:{...draft.elements,[selectedId]:next}};
  if(!Object.keys(next).length)delete candidate.elements[selectedId];
  try{validateLayout(candidate);input.setCustomValidity('');}catch{input.setCustomValidity('请填写允许范围内的整数。');return;}
  const transaction=`${selectedId}:${key}`;
  // A slider/color-picker gesture is one undo step, not hundreds of steps.
  if(fieldTransaction===transaction&&historyIndex===history.length-1&&historyIndex>0){draft=candidate;history[historyIndex]=JSON.stringify(copy(candidate));}
  else{draft=candidate;pushHistory();fieldTransaction=transaction;}
  notice='';apply();updateState();
  const reset=panel.querySelector(`[data-layout-reset-field="${key}"]`);if(reset)reset.disabled=next[key]===undefined;
  const colorLabel=panel.querySelector(`[data-layout-color-label="${key}"]`);if(colorLabel)colorLabel.textContent=next[key]||'默认';
});
root.addEventListener('change',event=>{if(event.target.matches('[data-layout-page]')){fieldTransaction='';selectedId='';location.hash=event.target.value;schedule();renderPanel();}});
root.addEventListener('focusout',event=>{if(event.target.closest('#layout-style-form'))fieldTransaction='';});

// Capture normal app actions during editing: clicking "delete" here only hides
// a component; it cannot accidentally select a hero or adopt a game augment.
document.addEventListener('click',event=>{
  const opener=event.target.closest('[data-open-layout]');if(opener&&!root.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();void open();return;}
  if(!editing||root.contains(event.target))return;
  event.preventDefault();event.stopImmediatePropagation();
  const element=event.target.closest('[data-ui-id]');if(element&&registry.has(element.dataset.uiId))choose(element.dataset.uiId);
},true);
for(const type of ['pointerdown','mousedown','touchstart','dblclick','contextmenu','change','input','submit'])document.addEventListener(type,event=>{
  if(!editing||root.contains(event.target))return;
  if(type==='pointerdown'||type==='mousedown'||type==='touchstart'){if(type!=='touchstart'&&event.target.closest('input,select,textarea,button,a'))event.preventDefault();}
  else event.preventDefault();
  event.stopImmediatePropagation();
},true);
document.addEventListener('pointermove',event=>{if(!editing||drag)return;const id=!root.contains(event.target)?event.target.closest('[data-ui-id]')?.dataset.uiId:'';if(id!==hoverId){hoverId=registry.has(id)?id:'';schedule();}},true);
document.addEventListener('keydown',event=>{
  if(!editing)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!event.target.closest('input,select,textarea')){event.preventDefault();event.stopImmediatePropagation();undo(event.shiftKey?1:-1);return;}
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(drag){finishDrag(true);return;}if(selectedId){selectedId='';hoverId='';apply();renderPanel();}else close();return;}
  if(!root.contains(event.target)&&!['Tab','Shift','Control','Alt','Meta','PageUp','PageDown','ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();}
},true);

root.addEventListener('pointerdown',event=>{
  const handle=event.target.closest('[data-layout-drag]');if(!handle||handle.disabled||event.button!==0)return;
  const element=find(selectedId),group=siblings(element),parent=parentId(element);if(group.length<2||!registry.get(parent)?.container)return;
  event.preventDefault();fieldTransaction='';drag={id:selectedId,parent,order:group.map(child=>child.dataset.uiId),before:'',pointer:event.pointerId,startX:event.clientX,startY:event.clientY,active:false,valid:false};
  handle.setPointerCapture?.(event.pointerId);document.documentElement.classList.add('layout-dragging');
});
document.addEventListener('pointermove',event=>{
  if(!drag)return;event.preventDefault();
  if(!drag.active&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<5)return;
  drag.active=true;
  const element=find(drag.id),parent=find(drag.parent);if(!element||!parent){marker.hidden=true;return;}
  const parentRect=parent.getBoundingClientRect();drag.valid=event.clientX>=parentRect.left-20&&event.clientX<=parentRect.right+20&&event.clientY>=parentRect.top-48&&event.clientY<=parentRect.bottom+40&&!inspector.contains(document.elementFromPoint(event.clientX,event.clientY));
  if(!drag.valid){marker.hidden=true;return;}
  const options=siblings(element).filter(child=>child.dataset.uiId!==drag.id&&!draft.elements[child.dataset.uiId]?.hidden&&child.getClientRects().length);
  if(!options.length)return;
  const parentStyle=getComputedStyle(parent),columns=parentStyle.display==='grid'?parentStyle.gridTemplateColumns.split(' ').length:1;
  const horizontal=columns>1||parentStyle.display.includes('flex')&&parentStyle.flexDirection.startsWith('row');
  const boxes=options.map(child=>({id:child.dataset.uiId,rect:child.getBoundingClientRect()}));
  const nearest=boxes.reduce((best,box)=>{const r=box.rect,distance=Math.hypot(event.clientX-r.left-r.width/2,event.clientY-r.top-r.height/2);return !best||distance<best.distance?{...box,distance}:best;},null);
  const anchor=nearest.rect,index=boxes.findIndex(box=>box.id===nearest.id);
  const sameRow=event.clientY>=anchor.top&&event.clientY<=anchor.bottom;
  const after=horizontal&&sameRow?event.clientX>=anchor.left+anchor.width/2:event.clientY>=anchor.top+anchor.height/2;
  drag.before=after?boxes[index+1]?.id||'':nearest.id;marker.hidden=false;
  marker.style.left=`${horizontal?(after?anchor.right:anchor.left):anchor.left}px`;
  marker.style.top=`${horizontal?anchor.top:after?anchor.bottom:anchor.top}px`;
  marker.style.width=`${horizontal?3:anchor.width}px`;
  marker.style.height=`${horizontal?anchor.height:3}px`;
  marker.dataset.layoutAxis=horizontal?'horizontal':'vertical';
  const edge=innerHeight>800?76:50;if(event.clientY<76)scrollBy(0,-12);else if(event.clientY>innerHeight-edge)scrollBy(0,12);
},true);
function finishDrag(cancel=false){
  if(!drag)return;const move=drag;drag=null;marker.hidden=true;document.documentElement.classList.remove('layout-dragging');
  if(cancel||!move.active||!move.valid)return;
  const element=find(move.id),group=siblings(element).map(child=>child.dataset.uiId).filter(id=>id!==move.id);
  const index=move.before?group.indexOf(move.before):group.length;group.splice(index<0?group.length:index,0,move.id);
  if(group.join('|')!==move.order.join('|')){draft.orders[move.parent]=group;changed({render:true,message:`已调整“${label(move.id)}”的位置。`});}
}
document.addEventListener('pointerup',()=>finishDrag(),true);
document.addEventListener('pointercancel',()=>finishDrag(true),true);
window.addEventListener('scroll',()=>{if(editing)positionTools();},{passive:true});
window.addEventListener('resize',()=>{if(editing)positionTools();},{passive:true});
window.addEventListener('hashchange',()=>{if(editing){selectedId='';hoverId='';root.querySelector('[data-layout-page]').value=location.hash.slice(1);renderPanel();schedule();}});
window.hexguideLayout=Object.freeze({open,close:()=>close(),isEditing:()=>editing,notify:message=>{if(!editing)return false;notice=String(message);updateState();return true;}});
apply();loading=load();

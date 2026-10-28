import {createDefaultAppearance,validateAppearance} from './appearance-config.js';

const STORAGE_KEY='hexguide-appearance-v1';
const fontNames={system:'跟随系统',yahei:'微软雅黑',dengxian:'等线',simsun:'宋体'};
const fonts={system:'"Microsoft YaHei","PingFang SC",system-ui,sans-serif',yahei:'"Microsoft YaHei","PingFang SC",sans-serif',dengxian:'DengXian,"Microsoft YaHei",sans-serif',simsun:'SimSun,"Songti SC",serif'};
const sectionNames={hero:'当前英雄',owned:'已选海克斯',offers:'本轮推荐',plan:'推荐玩法'};
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone=value=>validateAppearance(value);
const token=()=>sessionStorage.getItem('hexguide-local-session')||(location.hash.startsWith('#session=')?decodeURIComponent(location.hash.slice(9)):'');
let saved=createDefaultAppearance(),draft,saving=false,source='browser',notice='',trigger=null,loading;
try{saved=clone(JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'));}catch{/* Invalid old settings are replaced by the supported defaults. */}

function applyMain(value){
  const root=document.documentElement,main=value.main;
  root.dataset.appearanceFont=main.fontFamily;
  root.dataset.appearanceDensity=main.density;
  root.dataset.appearanceLayout=main.cardLayout;
  root.dataset.appearancePanel=main.panelSide;
  root.style.setProperty('--appearance-font',fonts[main.fontFamily]);
  root.style.setProperty('--appearance-scale',String(main.scale/100));
}
function cache(value){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(value));return true;}catch{return false;}}
applyMain(saved);

const options=(values,current)=>Object.entries(values).map(([value,label])=>`<option value="${value}"${value===current?' selected':''}>${label}</option>`).join('');
const select=(name,label,values,current)=>`<label class="appearance-field"><span>${label}</span><select name="${name}">${options(values,current)}</select></label>`;
const range=(name,label,value,min,max,unit,step=1)=>`<label class="appearance-field appearance-range"><span>${label}<output data-output="${name}" for="appearance-${name}">${value}${unit}</output></span><input id="appearance-${name}" name="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-unit="${unit}"><small>${min}${unit}<span>${max}${unit}</span></small></label>`;
const idleHideInput=value=>`<label class="appearance-field appearance-number"><span>自动收起等待时间（秒）</span><input id="appearance-sidebar-idleHideSeconds" name="sidebar-idleHideSeconds" type="number" min="5" max="300" step="1" required value="${value}" aria-describedby="appearance-idle-hide-help"><small id="appearance-idle-hide-help">5–300 秒；默认 10 秒。</small></label>`;
const dialog=document.createElement('dialog');
dialog.id='appearance-dialog';dialog.className='appearance-dialog';dialog.setAttribute('aria-labelledby','appearance-title');
document.body.append(dialog);

function render(){
  const m=draft.main,s=draft.sidebar;
  dialog.innerHTML=`<form id="appearance-form"><header class="appearance-head"><div><h2 id="appearance-title">界面设置</h2><p>按自己的习惯，安排每一局的信息。</p></div><button class="icon-button" type="button" data-appearance-action="cancel" aria-label="关闭界面设置">✕</button></header><div class="appearance-scroll"><p class="appearance-preview-note"><span aria-hidden="true">◈</span>主窗口即时预览；点击“保存设置”后，游戏侧栏也会更新。</p><div class="appearance-columns"><fieldset class="appearance-section"><legend>主窗口</legend><p class="appearance-section-note">调整字体、内容大小和资料排列。</p>${select('main-fontFamily','字体',fontNames,m.fontFamily)}${range('main-scale','内容缩放',m.scale,85,130,'%')}${select('main-density','内容间距',{comfortable:'舒适',compact:'紧凑'},m.density)}${select('main-cardLayout','海克斯排列',{grid:'卡片网格',list:'单列列表'},m.cardLayout)}${select('main-panelSide','“我的这一局”位置',{left:'左侧',right:'右侧'},m.panelSide)}<p class="appearance-field-note">窄窗口和手机上保持单列，方便阅读。</p></fieldset><fieldset class="appearance-section"><legend>游戏侧栏</legend><p class="appearance-section-note">保存后生效，不会改变游戏内设置。</p>${select('sidebar-fontFamily','字体',fontNames,s.fontFamily)}${range('sidebar-scale','文字大小',s.scale,85,130,'%')}${range('sidebar-width','侧栏宽度',s.width,280,460,' px')}${select('sidebar-side','显示位置',{right:'屏幕右侧',left:'屏幕左侧'},s.side)}${range('sidebar-opacity','不透明度',s.opacity,75,100,'%')}${idleHideInput(s.idleHideSeconds)}<div class="appearance-order"><span class="appearance-order-label">信息排列</span><ol id="appearance-order-list">${orderMarkup()}</ol><small>使用上下按钮调整，最上方的信息优先显示。</small></div></fieldset></div><p id="appearance-status" class="appearance-status" role="status" aria-live="polite">${escape(statusText())}</p><span class="appearance-sr-only" id="appearance-order-status" role="status" aria-live="polite"></span></div><footer class="appearance-footer"><button type="button" class="appearance-reset" data-appearance-action="reset">恢复默认</button><div><button type="button" class="secondary-button" data-appearance-action="cancel">取消</button><button type="submit" class="primary-button" id="appearance-save">保存设置</button></div></footer></form>`;
}
function orderMarkup(){return draft.sidebar.sections.map((section,index)=>`<li><span class="appearance-order-grip" aria-hidden="true">⋮⋮</span><span>${sectionNames[section]}</span><div><button type="button" data-appearance-action="up" data-section="${section}" aria-label="将${sectionNames[section]}上移"${index===0?' disabled':''}>↑</button><button type="button" data-appearance-action="down" data-section="${section}" aria-label="将${sectionNames[section]}下移"${index===3?' disabled':''}>↓</button></div></li>`).join('');}
function statusText(){return notice||(source==='desktop'?'设置保存在本机，重新打开软件后仍然有效。':'网页预览：设置保存在当前浏览器。游戏侧栏需在桌面版中使用。');}
function setStatus(message,error=false){const status=dialog.querySelector('#appearance-status');if(status){status.textContent=message;status.classList.toggle('error',error);}}
function close(){if(saving)return;applyMain(saved);dialog.close();trigger?.focus({preventScroll:true});}
function layoutIsEditing(){
  if(!window.hexguideLayout?.isEditing())return false;
  window.hexguideLayout.notify?.('请先保存或取消当前界面编辑，再打开界面设置。');
  return true;
}
async function open(){
  if(layoutIsEditing())return false;
  await loading;
  if(layoutIsEditing())return false;
  if(dialog.open)return true;
  trigger=document.activeElement;draft=clone(saved);render();dialog.showModal();
  dialog.querySelector('select')?.focus({preventScroll:true});
  return true;
}

async function load(){
  if(!token())return;
  source='desktop';
  try{
    const response=await fetch('/api/appearance',{headers:{'X-Hexguide-Session':token()},cache:'no-store',signal:AbortSignal.timeout(4500)});
    if(!response.ok)throw Error('未能读取已保存的设置，请关闭后重新打开设置，或重启软件。');
    saved=clone(await response.json());cache(saved);if(!dialog.open)applyMain(saved);
    notice='';
  }catch(error){notice=error.name==='TimeoutError'?'读取设置超时；可继续调整，保存时会重试。':error.message;}
  if(dialog.open)setStatus(statusText(),!!notice);
}
async function save(){
  if(saving)return;
  if(!dialog.querySelector('#appearance-form').reportValidity())return;
  let value;try{value=clone(draft);}catch{setStatus('设置包含不支持的值，请恢复默认后重新调整。',true);return;}
  saving=true;dialog.querySelectorAll('button,input,select').forEach(control=>control.disabled=true);setStatus('正在保存…');
  try{
    if(token()){
      const response=await fetch('/api/appearance',{method:'POST',headers:{'Content-Type':'application/json','X-Hexguide-Session':token()},body:JSON.stringify(value),signal:AbortSignal.timeout(4500)});
      if(!response.ok)throw Error(response.status===401?'本机会话已失效，请重新打开软件后保存。':'保存失败，设置尚未同步到侧栏，请重试。');
      value=clone(await response.json());source='desktop';
    }else{source='browser';if(!cache(value))throw Error('浏览器无法保存设置，请允许本地存储后重试。');}
    saved=value;cache(saved);notice='';applyMain(saved);saving=false;dialog.close();trigger?.focus({preventScroll:true});
    window.dispatchEvent(new CustomEvent('hexguide-appearance-saved',{detail:clone(saved)}));
    const toast=document.querySelector('#toast');if(toast){toast.textContent=source==='desktop'?'界面设置已保存，侧栏已更新':'界面设置已保存到当前浏览器';toast.classList.add('visible');setTimeout(()=>toast.classList.remove('visible'),3000);}
  }catch(error){
    saving=false;render();
    setStatus(error.name==='TimeoutError'?'保存超时，请重试；侧栏可能尚未更新。':error.message,true);
    dialog.querySelector('#appearance-save')?.focus({preventScroll:true});
  }
}
dialog.addEventListener('input',event=>{
  const input=event.target;if(!input.name||saving)return;
  const [part,key]=input.name.split('-');if(!draft[part]||!(key in draft[part]))return;
  draft[part][key]=input.type==='number'?input.valueAsNumber:input.type==='range'?Number(input.value):input.value;
  if(input.type==='number'){
    const invalid=!input.validity.valid;
    input.setAttribute('aria-invalid',String(invalid));
    setStatus(invalid?'自动收起等待时间请输入 5–300 之间的整数秒。':statusText(),invalid);
  }
  const output=dialog.querySelector(`[data-output="${input.name}"]`);if(output)output.value=`${input.value}${input.dataset.unit}`;
  applyMain(draft);
});
dialog.addEventListener('submit',event=>{event.preventDefault();void save();});
dialog.addEventListener('invalid',event=>{
  if(event.target.name!=='sidebar-idleHideSeconds')return;
  event.target.setAttribute('aria-invalid','true');
  setStatus('自动收起等待时间请输入 5–300 之间的整数秒。',true);
},true);
dialog.addEventListener('click',event=>{
  const button=event.target.closest('[data-appearance-action]');if(!button||saving)return;
  const action=button.dataset.appearanceAction;
  if(action==='cancel'){close();return;}
  if(action==='reset'){draft=createDefaultAppearance();render();applyMain(draft);dialog.querySelector('[data-appearance-action="reset"]')?.focus({preventScroll:true});setStatus('已预览默认设置，点击“保存设置”后生效。');return;}
  if(action==='up'||action==='down'){
    const section=button.dataset.section,index=draft.sidebar.sections.indexOf(section),next=index+(action==='up'?-1:1);
    if(next<0||next>=draft.sidebar.sections.length)return;
    [draft.sidebar.sections[index],draft.sidebar.sections[next]]=[draft.sidebar.sections[next],draft.sidebar.sections[index]];
    dialog.querySelector('#appearance-order-list').innerHTML=orderMarkup();
    const same=dialog.querySelector(`[data-section="${section}"][data-appearance-action="${action}"]`);
    const opposite=dialog.querySelector(`[data-section="${section}"][data-appearance-action="${action==='up'?'down':'up'}"]`);
    (same?.disabled?opposite:same)?.focus({preventScroll:true});
    dialog.querySelector('#appearance-order-status').textContent=`${sectionNames[section]}已移到第 ${next+1} 位`;
  }
});
dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
dialog.addEventListener('close',()=>{if(!saving)applyMain(saved);});
document.querySelector('[data-open-appearance]')?.addEventListener('click',open);
window.hexguideAppearance=Object.freeze({open});
loading=load();

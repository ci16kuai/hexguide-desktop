import {validIconUrl} from './announcements-contract.js';
const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const modeName={general:'通用改动',aram:'海克斯大乱斗',arena:'斗魂竞技场'};
const groupBy=(rows,key)=>{const groups=new Map();for(const row of rows){const id=key(row);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);}return [...groups.values()];};
function icon(url,name,large=false){
  if(!validIconUrl(url))return null;
  const node=make('img',large?'announcement-champion-portrait':'announcement-icon');node.src=url;node.alt='';node.title=name;node.width=large?80:40;node.height=large?80:40;node.loading='lazy';node.decoding='async';node.referrerPolicy='no-referrer';node.addEventListener('error',()=>{node.hidden=true;},{once:true});return node;
}
function facts(rows){
  const fragment=document.createDocumentFragment(),numerical=rows.filter(row=>row.beforeText!==undefined),other=rows.filter(row=>row.beforeText===undefined);
  if(numerical.length){
    const table=make('table','announcement-table'),caption=make('caption','announcement-sr-only',`${rows[0].name}改动`),thead=make('thead'),heading=make('tr');
    for(const label of ['属性','调整前','调整后']){const th=make('th',null,label);th.scope='col';heading.append(th);}thead.append(heading);table.append(caption,thead);
    const tbody=make('tbody');for(const row of numerical){const tr=make('tr','announcement-adjustment'),label=make('th','announcement-property',row.label);label.scope='row';tr.append(label,make('td','announcement-number',row.beforeText),make('td','announcement-number',row.afterText));tbody.append(tr);}table.append(tbody);fragment.append(table);
  }
  if(other.length){const list=make('ul','announcement-note-list');for(const row of other)list.append(make('li',null,row.text));fragment.append(list);}
  return fragment;
}
function changeGroups(rows){
  const fragment=document.createDocumentFragment();
  for(const changes of groupBy(rows,row=>JSON.stringify([row.mode,row.ability?.slot??'',row.ability?.name??'']))){
    const first=changes[0],group=make('section','announcement-change-group'),heading=make('div','announcement-change-heading');
    if(first.kind==='champion'&&first.ability){const image=icon(first.icon,`${first.ability.slot} · ${first.ability.name}`);if(image)heading.append(image);heading.append(make('h6',null,`${first.ability.slot==='P'?'被动':first.ability.slot} · ${first.ability.name}`));}
    else if(first.kind==='champion')heading.append(make('h6',null,'基础数值与其他改动'));
    heading.append(make('span','announcement-mode',modeName[first.mode]));group.append(heading,facts(changes));fragment.append(group);
  }
  return fragment;
}
export function renderOfficialSections(article){
  const fragment=document.createDocumentFragment(),navigation=make('nav','announcement-section-nav');navigation.setAttribute('aria-label','公告分类');
  const definitions=[['champion','英雄'],['item','装备'],['augment','海克斯'],['other','其他修复']];
  const sections=[];
  for(const [kind,label] of definitions){
    const rows=article.changes.filter(row=>row.kind===kind);if(!rows.length)continue;
    const groups=groupBy(rows,row=>row.entityId),section=make('section','announcement-kind-section'),title=make('h4',null,`${label}（${groups.length}）`);title.tabIndex=-1;section.append(title);
    const jump=make('button','announcement-link',`${label}（${groups.length}）`);jump.type='button';jump.addEventListener('click',()=>{const pane=section.closest('.announcement-content');if(pane)pane.scrollTo({top:pane.scrollTop+title.getBoundingClientRect().top-pane.getBoundingClientRect().top-16,behavior:'auto'});title.focus({preventScroll:true});});navigation.append(jump);
    groups.forEach((changes,index)=>{
      const first=changes[0],entity=make('section',kind==='champion'?'announcement-champion':'announcement-official-entity'),header=make('div',kind==='champion'?'announcement-champion-head':'announcement-identity');
      const image=icon(kind==='champion'?first.championIcon:first.icon,first.name,kind==='champion');if(image)header.append(image);
      const name=make('h5',null,first.name);header.append(name);
      const body=make('div','announcement-changes');body.append(changeGroups(changes));
      if(kind==='champion'){
        const control=make('button','secondary-button announcement-champion-toggle','收起');control.type='button';body.id=`announcement-${article.id}-champion-${index}`;control.setAttribute('aria-controls',body.id);control.setAttribute('aria-expanded','true');control.setAttribute('aria-label',`收起${first.name}的改动`);
        control.addEventListener('click',()=>{body.hidden=!body.hidden;control.textContent=body.hidden?'展开':'收起';control.setAttribute('aria-expanded',String(!body.hidden));control.setAttribute('aria-label',`${body.hidden?'展开':'收起'}${first.name}的改动`);});header.append(control);
      }
      entity.append(header,body);section.append(entity);
    });
    sections.push(section);
  }
  fragment.append(navigation,...sections);return fragment;
}

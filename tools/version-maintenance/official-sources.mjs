import {parse} from 'parse5';
import {fetchText,digest,plain} from './sources.mjs';
import {validIconUrl} from '../../dist/announcements-contract.js';

const attr=(node,name)=>node?.attrs?.find(row=>row.name===name)?.value;
const children=node=>node?.childNodes??[];
const clean=value=>String(value??'').replace(/[\s\u00a0\u2003]+/g,' ').trim();
function content(node){if(node.nodeName==='#text')return node.value;if(node.tagName==='br')return '\n';return children(node).map(content).join('');}
function find(node,predicate){if(predicate(node))return node;for(const child of children(node)){const result=find(child,predicate);if(result)return result;}return null;}
const image=node=>{const found=find(node,n=>n.tagName==='img'),src=attr(found,'src');if(!src)return '';const url=new URL(src,'https://lol.qq.com').href;return validIconUrl(url)?url:'';};
function* blocks(node){
  for(const child of children(node)){
    if(['script','style','blockquote'].includes(child.tagName))continue;
    if(/^h[1-6]$/.test(child.tagName??'')){yield {type:'heading',level:Number(child.tagName[1]),text:clean(content(child)),icon:image(child)};continue;}
    if(['p','li'].includes(child.tagName)){
      const strong=find(child,node=>node.tagName==='strong'),headingLike=!!strong&&clean(content(strong))===clean(content(child));
      for(const [index,line] of content(child).split('\n').entries())if(clean(line))yield {type:child.tagName,text:clean(line).replace(/^[●•]\s*/,''),bullet:/^[●•]/.test(clean(line)),headingLike,icon:index===0?image(child):''};
      continue;
    }
    yield* blocks(child);
  }
}
const normalized=value=>clean(value).replace(/[【】\[\]\s·]/g,'');
export function officialCatalog({version,champions,items,augments=[]}){
  if(champions?.version!==version||!champions.data||!items?.data)throw Error('Official announcement icon catalog unavailable.');
  return {
    champions:Object.values(champions.data).map(c=>({id:c.id,name:`${c.name} ${c.title}`,title:c.title,aliases:[c.name,c.title,c.name+c.title,c.title.split('·')[0]].filter(Boolean),icon:`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.image.full}`,spells:c.spells,passive:c.passive})),
    items:Object.entries(items.data).sort(([a],[b])=>Number(a)-Number(b)).map(([id,row])=>({id,name:row.name,icon:`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${row.image.full}`})),
    augments:augments.map(row=>({id:row.augmentNameId??row.id,name:row.nameTRA??row.name,aliases:[(row.nameTRA??row.name)?.replace(/^任务[：:]/,'')].filter(Boolean),icon:row.icon??(row.augmentSmallIconPath?`https://raw.communitydragon.org/${version.split('.').slice(0,2).join('.')}/game/${row.augmentSmallIconPath.replace(/^\/lol-game-data\/assets\//,'').toLowerCase()}`:'')}))
  };
}
function matchEntity(rows,text){const key=normalized(text);return rows.find(row=>[row.name,...row.aliases??[]].some(alias=>normalized(alias)===key))??rows.filter(row=>[row.name,...row.aliases??[]].some(alias=>normalized(alias).length>=2&&key.includes(normalized(alias)))).sort((a,b)=>b.name.length-a.name.length)[0];}
function fallback(kind,name,icon=''){return {id:`official-${digest({kind,name}).slice(0,16)}`,name,icon};}
export function parseOfficialChanges(html,{url,version,catalog}={}){
  if(!/^https:\/\/lol\.qq\.com\/(?:gicp\/news\/\d+\/\d+\.html|news\/detail\.shtml\?docid=\d+)$/.test(url))throw Error('Unexpected official announcement URL.');
  const dom=parse(html),root=find(dom,node=>attr(node,'id')==='article');if(!root)throw Error('Official article body missing.');
  const titleNode=find(dom,node=>(attr(node,'class')??'').split(' ').includes('art-tit'));
  const title=clean(content(titleNode??root)).slice(0,120),dateNode=find(dom,node=>(attr(node,'class')??'').split(' ').includes('art-time'));
  const date=(attr(dateNode,'data')??clean(content(dateNode??{}))).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Official publication date missing.');
  const patch=version.split('.').map(Number),expected=`${patch[0]+10}.${patch[1]}`;
  if(!title.includes(expected)&&!/^\d{4}年\d+月\d+日.*更新/.test(title))throw Error('Official patch title mismatch.');
  const hotfix=/^\d{4}年/.test(title);
  let mode='general',category=null,entity=null,ability=null,status='adjustment',section='',excluded=0;
  const changes=[],seen=new Set(),warnings=[];const sectionCounts={};
  function add(text,{who=entity,kind=category,spell=ability,type=status,icon=''}={}){
    if(!who||!['champion','item','augment','other'].includes(kind)||/经典模式/.test(text))return;
    const textValue=clean(text);if(!textValue)return;
    const arrowMatch=/[⇒→]|>{2,3}/u.exec(textValue),arrow=arrowMatch?.index??-1,colon=textValue.search(/[：:]/u);let label,beforeText,afterText;
    if(arrow>=0){label=colon>=0&&colon<arrow?textValue.slice(0,colon):'数值调整';beforeText=textValue.slice(colon>=0&&colon<arrow?colon+1:0,arrow).trim();afterText=textValue.slice(arrow+arrowMatch[0].length).trim();if(!beforeText||!afterText)throw Error('Incomplete official numerical change.');}
    else label=type==='added'?'新增':type==='removed'?'移除':/BUG|修复/i.test(textValue)?'BUG修复':'其他改动';
    const key=digest({kind,id:who.id,mode,slot:spell?.slot??'',label,text:textValue}).slice(0,32);
    if(seen.has(key))return;seen.add(key);
    const row={key,kind,entityId:who.id,name:who.name,mode,label:clean(label),text:textValue,changeType:type,
      ...(beforeText?{beforeText,afterText}:{}),...(validIconUrl(icon||spell?.icon||who.icon)?{icon:icon||spell?.icon||who.icon}:{}),
      ...(kind==='champion'?{championIcon:who.icon}:{}),...(spell?{ability:{slot:spell.slot,name:spell.name}}:{})};
    if(kind==='champion'&&!validIconUrl(who.icon))throw Error(`Champion portrait missing: ${who.name}`);
    if(kind==='champion'&&spell&&!row.icon)throw Error(`Skill icon missing: ${who.name}/${spell.slot}`);
    changes.push(row);sectionCounts[section]=(sectionCounts[section]??0)+1;
  }
  function identify(kind,text,icon){const rows=catalog[kind==='champion'?'champions':kind==='item'?'items':'augments'];const found=matchEntity(rows,text);return found?{...found,...(icon&&kind!=='champion'?{icon}:{})}:kind==='champion'?null:fallback(kind,text,icon);}
  for(const block of blocks(root)){
    const text=block.text;if(!text)continue;
    if(block.type==='heading'&&block.level<=3||block.headingLike&&/^(?:经典模式|海克斯大乱斗(?: BUG修复)?|斗魂竞技场|BUG修复及品质级改动)$/.test(text)){
      section=text;entity=null;ability=null;status='adjustment';category=null;
      if(/经典模式/.test(text)){mode='classic';continue;}
      mode=/斗魂竞技场|竞技场/.test(text)?'arena':/海克斯大乱斗|大乱斗/.test(text)?'aram':'general';
      if(text==='英雄')category='champion';else if(text==='装备')category='item';else if(/BUG修复/.test(text))category='bugs';
      continue;
    }
    if(mode==='classic'){excluded++;continue;}
    if(block.headingLike&&['英雄','装备','强化符文'].includes(text)){category=text==='英雄'?'champion':text==='装备'?'item':'augment';entity=null;ability=null;status='adjustment';continue;}
    if(block.type==='heading'){
      ability=null;
      if(['英雄','装备','强化符文'].includes(text)){category=text==='英雄'?'champion':text==='装备'?'item':'augment';entity=null;status='adjustment';continue;}
      if(/新增.*强化符文/.test(text)){category='augment';entity=null;status='added';continue;}
      if(/已移除.*强化符文/.test(text)){category='augment';entity=null;status='removed';continue;}
      if(mode==='aram'&&/赛季之星/.test(text)){category=null;entity=null;continue;}
      if(category==='champion'||category==='item'){entity=identify(category,text,block.icon);if(!entity)throw Error(`Unmatched official champion: ${text}`);continue;}
    }
    if(category==='bugs'){
      if(block.type!=='li'&&!(hotfix&&block.bullet))continue;
      const startCount=changes.length;
      const heroes=catalog.champions.filter(row=>[row.name,row.title].filter(Boolean).some(alias=>alias.length>=2&&text.includes(alias)));
      for(const hero of heroes){const slot=/\b([QWER])(?:技能|护盾|伤害|[)）])/.exec(text)?.[1]??(/终极技能/.test(text)?'R':null),spell=slot?hero.spells?.[['Q','W','E','R'].indexOf(slot)]:null;
        add(text,{who:hero,kind:'champion',type:'fix',spell:spell?{slot,name:spell.name,icon:`https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${spell.image.full}`}:null});}
      const mentions=[...text.matchAll(/【([^】]+)】/g)].map(match=>match[1]);
      for(const mention of mentions){
        const augment=catalog.augments.find(row=>[row.name,...row.aliases??[]].some(alias=>normalized(alias)===normalized(mention)));
        if(augment){add(text,{who:augment,kind:'augment',type:'fix',spell:null});continue;}
        const item=catalog.items.find(row=>normalized(row.name)===normalized(mention));if(item)add(text,{who:item,kind:'item',type:'fix',spell:null});
      }
      if(changes.length===startCount)add(text,{who:fallback('other',`${modeName(mode)}修复`),kind:'other',type:'fix',spell:null});
      continue;
    }
    if(!category&&hotfix&&block.headingLike){const hero=identify('champion',text,block.icon);if(hero&&[hero.name,...hero.aliases].some(alias=>normalized(alias)===normalized(text))){category='champion';entity=hero;ability=null;section='英雄';continue;}}
    if(!category)continue;
    if(text==='基础属性'||text==='基础数值'){ability=null;continue;}
    const skill=/^(被动|[QWER])\s*[-—–]\s*(.+)$/.exec(text);
    if(category==='champion'&&skill){
      const slot=skill[1]==='被动'?'P':skill[1],source=slot==='P'?entity?.passive:entity?.spells?.[['Q','W','E','R'].indexOf(slot)];
      const fallbackIcon=source?.image?.full?`https://ddragon.leagueoflegends.com/cdn/${version}/img/${slot==='P'?'passive':'spell'}/${source.image.full}`:'';
      ability={slot,name:skill[2],icon:block.icon||fallbackIcon};continue;
    }
    if(mode==='aram'&&status==='removed'&&category==='augment'&&block.type==='li'){const who=identify('augment',text,block.icon);add(`从强化符文池移除：${text}`,{who,type:'removed',spell:null});continue;}
    if((mode==='arena'||category==='augment'||hotfix)&&block.type==='p'&&block.headingLike){
      if(/^(白银|黄金|棱彩|增强|削弱|调整|英雄|装备)/.test(text)&&text.length<8)continue;
      const who=identify(category,text,block.icon);if(who){entity=who;ability=null;continue;}
      if(category==='champion')throw Error(`Unmatched official champion heading: ${text}`);
    }
    if(hotfix&&block.type==='p'&&!block.bullet)continue;
    if(entity){if(text.length>1500)throw Error('Unexpectedly long official change.');add(text);}
  }
  if(!changes.length&&!excluded)throw Error('No supported official changes parsed; refusing a false unchanged result.');
  if(changes.length>2000)throw Error('Unexpectedly large official announcement.');
  for(const row of changes)if(['item','augment'].includes(row.kind)&&!row.icon)warnings.push({kind:row.kind,name:row.name,reason:'官网及当前资源未提供可确认的对应图标。'});
  return {url,title,date,version,changes,excludedClassicBlocks:excluded,sectionCounts,warnings,sha256:digest(html)};
}
const modeName=mode=>({general:'通用',aram:'海克斯大乱斗',arena:'斗魂竞技场'})[mode];
const jsonp=body=>JSON.parse(body.replace(/^\s*\w+\(/,'').replace(/\);?\s*$/,''));
export async function fetchOfficialDocument(version,options={}){
  const [major,minor]=version.split('.').map(Number),patch=`${major+10}.${minor}`;
  let url=patch==='26.21'?'https://lol.qq.com/gicp/news/410/37099805.html':null;
  if(!url){
    const list=jsonp(await fetchText('https://apps.game.qq.com/cmc/zmMcnTargetContentList?r0=jsonp&page=1&num=16&target=24&source=web_pc',options));
    const note=list?.data?.result?.find(row=>row.sTitle===`${patch}版本更新公告`);if(!note||!/^\d+$/.test(String(note.iDocID)))throw Error('Matching official CN patch announcement not yet available.');
    const detail=jsonp(await fetchText(`https://apps.game.qq.com/cmc/zmMcnContentInfo?r0=jsonp&source=web_pc&type=0&docid=${note.iDocID}`,options));
    url=detail?.data?.result?.sRedirectURL;
  }
  if(!/^https:\/\/lol\.qq\.com\/gicp\/news\/\d+\/\d+\.html$/.test(url??''))throw Error('Official patch source URL missing.');
  return {url,html:await fetchText(url,{...options,maxBytes:4*1024*1024})};
}
export async function fetchOfficialDocuments(version,{knownSources={},...options}={}){
  const [major,minor]=version.split('.').map(Number),patch=`${major+10}.${minor}`;
  const list=jsonp(await fetchText('https://apps.game.qq.com/cmc/zmMcnTargetContentList?r0=jsonp&page=1&num=16&target=24&source=web_pc',options));
  if(String(list.status)!=='1'||!Array.isArray(list.data?.result))throw Error('Official update listing unavailable.');
  const main=await fetchOfficialDocument(version,options),dom=parse(main.html),dateNode=find(dom,node=>(attr(node,'class')??'').split(' ').includes('art-time'));
  const patchDate=(attr(dateNode,'data')??clean(content(dateNode??{}))).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(patchDate))throw Error('Official patch date unavailable for hotfix discovery.');
  const candidates=new Set(list.data.result.filter(row=>/^\d{4}年\d+月\d+日\s*不停机更新/.test(row.sTitle)&&row.sCreated?.slice(0,10)>=patchDate&&/^\d+$/.test(String(row.iDocID))).map(row=>String(row.iDocID)));
  for(const [url,row] of Object.entries(knownSources))if(row.kind==='hotfix'&&row.version.split('.').slice(0,2).join('.')===version.split('.').slice(0,2).join('.')){const id=/[?&]docid=(\d+)$/.exec(url)?.[1];if(id)candidates.add(id);}
  if(candidates.size>7)throw Error('Too many official hotfix documents; refusing unbounded API work.');
  const documents=[{...main,kind:'patch'}];
  for(const id of candidates){
    const detail=jsonp(await fetchText(`https://apps.game.qq.com/cmc/zmMcnContentInfo?r0=jsonp&source=web_pc&type=0&docid=${id}`,options)),info=detail.data?.result;
    if(String(detail.status)!=='1'||!/^\d{4}年\d+月\d+日\s*不停机更新/.test(info?.sTitle??'')||!/^\d{4}-\d{2}-\d{2} /.test(info?.sCreated??'')||typeof info.sContent!=='string')throw Error('Official hotfix metadata mismatch.');
    const url=`https://lol.qq.com/news/detail.shtml?docid=${id}`;
    const escapedTitle=info.sTitle.replace(/[<>&"']/g,'');
    documents.push({url,kind:'hotfix',html:`<h1 class="art-tit">${escapedTitle}</h1><span class="art-time" data="${info.sCreated.slice(0,10)}"></span><div id="article">${info.sContent}</div>`});
  }
  return documents;
}

// Refreshing a section may replace its focused control. Restore it only while
// this document still owns focus; a background refresh must never request it.
export function replacePreservingFocus(root, replace){
  const doc=root?.ownerDocument;
  const ownsFocus=()=>doc?.visibilityState==='visible'&&doc.hasFocus?.()===true;
  const active=doc?.activeElement;
  let selector,identifies;
  if(ownsFocus()&&root.contains(active)){
    if(active.id){const id=active.id;selector='[id]';identifies=node=>node.id===id;}
    else{
      const action=['liveAction','action','statsAction'].find(key=>active.dataset?.[key]);
      if(action){
        selector={'liveAction':'[data-live-action]',action:'[data-action]',statsAction:'[data-stats-action]'}[action];
        const keys=[action,...['id','slot','statsId'].filter(key=>active.dataset[key]!==undefined)];
        const identity=keys.map(key=>[key,active.dataset[key]]);
        identifies=node=>identity.every(([key,value])=>node.dataset?.[key]===value);
      }
    }
  }
  const selection=identifies&&typeof active.selectionStart==='number'
    ?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;
  const result=replace();
  if(!identifies||active.isConnected!==false||!ownsFocus())return result;
  // A render may deliberately focus a dialog or another control of its own.
  const current=doc.activeElement;
  if(current&&current!==active&&current!==doc.body&&current!==doc.documentElement&&current.isConnected)return result;
  const replacement=Array.from(root.querySelectorAll(selector)).find(identifies);
  if(!replacement||replacement===active||!replacement.isConnected)return result;
  replacement.focus({preventScroll:true});
  if(selection&&typeof replacement.selectionStart==='number'&&typeof replacement.setSelectionRange==='function')replacement.setSelectionRange(...selection);
  return result;
}

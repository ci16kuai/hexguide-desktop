// Small DOM fixture for replacement/focus semantics; no browser or native UI.
export function focusDocument(){
  const doc={focused:true,visibilityState:'visible',hasFocus(){return this.focused;}};
  doc.body=focusElement(doc);doc.documentElement=focusElement(doc);
  doc.activeElement=doc.body;
  return doc;
}

export function focusElement(doc,attributes={}){
  let html='';
  const node={ownerDocument:doc,id:'',dataset:{},isConnected:true,children:[],focuses:0,...attributes,
    contains(target){return this===target||this.children.some(child=>child.contains(target));},
    querySelectorAll(selector){
      const matches=child=>selector==='[id]'?Boolean(child.id):selector==='[data-live-action]'?Boolean(child.dataset.liveAction)
        :selector==='[data-action]'?Boolean(child.dataset.action):selector==='[data-stats-action]'?Boolean(child.dataset.statsAction)
        :selector==='[data-disclosure-key]'?Boolean(child.dataset.disclosureKey):false;
      return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);
    },
    replaceChildren(...children){
      const disconnect=child=>{child.isConnected=false;child.children.forEach(disconnect);};
      const removedFocus=this.children.some(child=>child.contains(doc.activeElement));
      this.children.forEach(disconnect);this.children=children;
      const connect=child=>{child.isConnected=this.isConnected;child.children.forEach(connect);};
      children.forEach(connect);
      if(removedFocus)doc.activeElement=doc.body;
    },
    focus(options){this.focuses++;this.focusOptions=options;doc.activeElement=this;},
    setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
  };
  Object.defineProperty(node,'innerHTML',{get(){return html;},set(value){
    html=value;
    const children=node.nextChildren||[];node.nextChildren=null;
    node.replaceChildren(...children);
  }});
  return node;
}

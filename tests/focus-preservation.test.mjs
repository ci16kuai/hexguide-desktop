import test from 'node:test';
import assert from 'node:assert/strict';
import {replacePreservingFocus} from '../dist/focus-preservation.js';
import {focusDocument,focusElement} from './fixtures/focus-dom.mjs';

function fixture(attributes={id:'search',type:'search',selectionStart:2,selectionEnd:4,selectionDirection:'backward'}){
  const doc=focusDocument(),root=focusElement(doc),old=focusElement(doc,attributes),next=focusElement(doc,structuredClone(attributes));
  root.replaceChildren(old);doc.activeElement=old;
  return {doc,root,old,next,replace:()=>root.replaceChildren(next)};
}

test('focused visible replacement restores its own control and selection without scrolling',()=>{
  const {doc,root,old,next,replace}=fixture();
  next.selectionStart=0;next.selectionEnd=0;next.selectionDirection='none';
  replacePreservingFocus(root,replace);
  assert.equal(old.isConnected,false);
  assert.equal(doc.activeElement,next);
  assert.equal(next.focuses,1);
  assert.deepEqual(next.focusOptions,{preventScroll:true});
  assert.deepEqual([next.selectionStart,next.selectionEnd,next.selectionDirection],[2,4,'backward']);
});

test('background, hidden, and focus-lost-during-render documents never request focus',()=>{
  for(const state of ['background','hidden','blur-during-render','hide-during-render']){
    const {doc,root,next,replace}=fixture();
    if(state==='background')doc.focused=false;
    if(state==='hidden')doc.visibilityState='hidden';
    replacePreservingFocus(root,()=>{replace();if(state==='blur-during-render')doc.focused=false;if(state==='hide-during-render')doc.visibilityState='hidden';});
    assert.equal(next.focuses,0,state);
  }
});

test('unrelated, still-connected, missing, and deliberately moved focus is not restored',()=>{
  for(const state of ['outside-root','still-connected','missing','moved-to-dialog']){
    const {doc,root,old,next,replace}=fixture(),dialog=focusElement(doc,{id:'dialog-close'});
    if(state==='outside-root')doc.activeElement=dialog;
    replacePreservingFocus(root,()=>{
      if(state==='still-connected')return;
      if(state==='missing')root.replaceChildren();else replace();
      if(state==='moved-to-dialog')doc.activeElement=dialog;
    });
    assert.equal(next.focuses,0,state);
    assert.equal(old.focuses,0,state);
    assert.equal(dialog.focuses,0,state);
  }
});

test('action restoration matches item and game slot rather than the first similar button',()=>{
  const {doc,root,next,replace}=fixture({dataset:{action:'adopt-candidate',id:'second',slot:'1'}});
  const first=focusElement(doc,{dataset:{action:'adopt-candidate',id:'first',slot:'0'}});
  const wrongSlot=focusElement(doc,{dataset:{action:'adopt-candidate',id:'second',slot:'2'}});
  replacePreservingFocus(root,()=>{replace();root.replaceChildren(first,wrongSlot,next);});
  assert.equal(first.focuses,0);assert.equal(wrongSlot.focuses,0);assert.equal(next.focuses,1);
});

test('pending confirmations restore focus only within the same unresolved round',()=>{
  const {doc,root,next}=fixture({dataset:{liveAction:'pending-confirm',id:'same-choice',pendingId:'second-round'}});
  const otherRound=focusElement(doc,{dataset:{liveAction:'pending-confirm',id:'same-choice',pendingId:'first-round'}});
  replacePreservingFocus(root,()=>root.replaceChildren(otherRound,next));
  assert.equal(otherRound.focuses,0);assert.equal(next.focuses,1);
});

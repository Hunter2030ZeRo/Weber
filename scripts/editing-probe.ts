// Standard contenteditable acceptance: OS input drives every edit.
import {defineApp} from '@weber/runtime';
const report=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
defineApp({mount(root){
 root.innerHTML=`<style>body{font:20px sans-serif;padding:24px}.editor{white-space:pre-wrap;border:1px solid;padding:12px;min-height:90px;margin:12px}#outside{height:30px}</style><h1>Native editable DOM</h1><p id="outside">Outside editor</p><div id="editor" class="editor" contenteditable="true" spellcheck="false"></div><div id="other" class="editor" contenteditable="true">Other</div><input id="field">`;
 const editor=document.getElementById('editor')!,other=document.getElementById('other')!;
 let seedNode:Node|null=null,blocked='',count=0,observe=true;
 let watched:Range|null=null;
 const eventCounts:Record<string,number>={};
 const state=()=>{const s=getSelection();return {active:document.activeElement?.id,text:editor.textContent,html:editor.innerHTML,other:other.textContent,nodeCount:editor.querySelectorAll('*').length,selection:s?.toString(),anchor:s?.anchorOffset,focus:s?.focusOffset,anchorText:s?.anchorNode?.textContent,focusText:s?.focusNode?.textContent,seedConnected:seedNode?.isConnected,seedSame:seedNode===editor.firstChild,listenerCount:count,watchedText:watched?.toString()};};
 const place=(node:Node,offset:number,end=offset)=>{const s=getSelection()!;s.setBaseAndExtent(node,offset,node,end);};
 const reset=(text='',rich=false)=>{watched=null;editor.innerHTML='';seedNode=rich?document.createElement('span'):document.createTextNode(text);if(rich)seedNode.textContent=text;editor.appendChild(seedNode);seedNode.addEventListener('weber-identity',()=>count++);blocked='';editor.focus();place(rich?seedNode.firstChild!:seedNode,text.length);report({stage:'editing-reset',...state()});};
 for(const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','selectionchange','focusin','focusout'])document.addEventListener(type,e=>{eventCounts[type]=(eventCounts[type]??0)+1;const event=e as InputEvent&KeyboardEvent;if(type==='beforeinput'&&blocked&&event.inputType===blocked)event.preventDefault();if(observe)queueMicrotask(()=>{if(observe)report({stage:'editing-event',type,key:event.key,data:event.data,inputType:event.inputType,composing:event.isComposing,trusted:event.isTrusted,cancelled:event.defaultPrevented,...state()});});});
 window.addEventListener('error',e=>report({stage:'failure',message:e.message}));
 window.addEventListener('keydown',e=>{
  if(e.key==='F2'){e.preventDefault();observe=!observe;report({stage:'editing-observation',observe,...state()});}
  if(e.key==='F1'){e.preventDefault();blocked='insertText';}
  if(e.key==='F5'){e.preventDefault();editor.textContent='external';place(editor.firstChild!,8);report({stage:'editing-external',...state()});}
  if(e.key==='F6'){e.preventDefault();reset();}
  if(e.key==='F3'){e.preventDefault();if(e.shiftKey){reset('A🙂한B');watched=document.createRange();watched.selectNodeContents(seedNode!);place(seedNode!,3,4);report({stage:'editing-range-seed',...state()});}else reset('A🙂e\u0301한B');}
  if(e.key==='F4'){e.preventDefault();reset('seed',true);if(e.shiftKey){editor.innerHTML='<span>A🙂한</span><em>글B</em>';seedNode=editor.firstChild!;seedNode.addEventListener('weber-identity',()=>count++);watched=document.createRange();watched.selectNodeContents(editor);getSelection()!.setBaseAndExtent(seedNode.firstChild!,3,editor.lastChild!.firstChild!,1);report({stage:'editing-range-seed',...state()});}}
  if(e.key==='F7'){e.preventDefault();other.focus();place(other.firstChild!,5);}
  if(e.key==='F8'){e.preventDefault();if(e.shiftKey){reset();editor.innerHTML='';seedNode=null;place(editor,0);report({stage:'editing-empty-host',...state()});}else{editor.focus();place(editor.firstChild!,0);}}
  if(e.key==='F9'){e.preventDefault();blocked='insertFromPaste';}
  if(e.key==='F10'){e.preventDefault();blocked='historyUndo';}
  if(e.key==='F11'){e.preventDefault();seedNode?.dispatchEvent(new Event('weber-identity'));report({stage:'editing-identity',eventCounts:{...eventCounts},...state()});}
  if(e.key==='F12')location.href='weber://close';
 });
 reset();requestAnimationFrame(()=>report({stage:'editing-ready',...state()}));
}});

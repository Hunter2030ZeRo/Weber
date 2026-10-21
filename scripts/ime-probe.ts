// Native acceptance fixture. No composition/input events are synthesized here.
import { defineApp } from '@weber/runtime';
import { closeWindow, currentWindow, openWindow } from '@weber/sdk/window';
const report=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
defineApp({mount(root){
 root.innerHTML=`<style>body{font:20px sans-serif;padding:20px}input,textarea{display:block;font:inherit;width:85%;margin:8px}textarea{height:100px}</style>
 <h1>Weber Korean IME acceptance</h1><form id="form"><input id="first" aria-label="First input"><input id="second" aria-label="Second input"></form>
 <textarea id="multi" aria-label="Multiline"></textarea><input id="secret" type="password" aria-label="Password"><input id="locked" readonly value="Read only"><textarea id="lockedmulti" readonly>Read only</textarea><button id="done">Done</button><output id="mirror"></output>`;
 const ids=['first','second','multi','secret','locked','lockedmulti'];
 const fields=()=>Object.fromEntries(ids.map(id=>{const field=document.getElementById(id)as HTMLInputElement;return[id,{value:field.value,start:field.selectionStart,end:field.selectionEnd}]}));
 const state=()=>({active:document.activeElement?.id,fields:fields(),mirror:document.getElementById('mirror')!.textContent});
 for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','keyup','focusin','focusout'])document.addEventListener(type,event=>{
  const e=event as InputEvent&KeyboardEvent;
  if(type==='input')document.getElementById('mirror')!.textContent=(e.target as HTMLInputElement).value;
  queueMicrotask(()=>report({stage:'ime-event',type,target:(e.target as HTMLElement).id,key:e.key,data:e.data,inputType:e.inputType,composing:e.isComposing,trusted:e.isTrusted,...state()}));
 });
 document.getElementById('form')!.addEventListener('submit',event=>{event.preventDefault();report({stage:'ime-submit',...state()});});
 window.addEventListener('error',event=>report({stage:'failure',message:event.message}));
 window.addEventListener('keydown',event=>{void(async()=>{
  if(event.key==='F6'){
   for(const id of ['first','second','multi','secret'])(document.getElementById(id)as HTMLInputElement).value='';
   document.getElementById('mirror')!.textContent='';document.getElementById('first')!.focus();report({stage:'ime-reset',...state()});
  }
  if(event.key==='F7')document.getElementById('second')!.focus();
  if(event.key==='F8')document.getElementById('multi')!.focus();
  if(event.key==='F9')document.getElementById('done')!.focus();
  if(event.key==='F2')await openWindow({title:'IME second window',width:700,height:600});
  if(event.key==='F3'){
   const first=document.getElementById('first')as HTMLInputElement;first.value='🙂x';first.focus();first.setSelectionRange(2,2);report({stage:'ime-seed',...state()});
  }
  if(event.key==='F10')closeWindow();
  if(event.key==='F12')location.href='weber://close';
 })().catch(error=>report({stage:'failure',message:String(error)}));});
 document.getElementById('first')!.focus();requestAnimationFrame(()=>report({stage:'ime-ready',id:currentWindow().id,...state()}));
}});

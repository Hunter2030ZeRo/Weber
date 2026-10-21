// Acceptance fixture only: appended to the actual Workbench source, never shipped.
import { currentWindow as alphaWindow, listWindows as alphaWindows, openWindow as alphaOpen, closeWindow as alphaClose, setWindowDecorations as alphaDecorate, setWindowResizable as alphaResizable, resizeWindow as alphaResize, setWindowMaximized as alphaMaximize, beginWindowDrag as alphaDrag, beginWindowResize as alphaDragResize, minimizeWindow as alphaMinimize, nativeRequest as alphaRequest } from '@weber/sdk/window';
import { getSystemInfo as alphaSystem, refreshSystemInfo as alphaRefresh, onSystemChanged as alphaWatch, showNotification as alphaNotify, dismissNotification as alphaDismiss, openExternal as alphaExternal } from '@weber/sdk/system';
import { getValue as alphaGet, setValue as alphaSet } from '@weber/sdk/storage';
const alphaReport=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
const alphaWait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const alphaCheck=(ok:unknown,text:string)=>{if(!ok)throw new Error(text);};
async function alphaUntil(test:()=>boolean|Promise<boolean>){const end=performance.now()+10000;while(!await test()){if(performance.now()>end)throw new Error('Alpha condition timeout '+JSON.stringify({window:alphaWindow(),width:innerWidth,height:innerHeight}));await alphaWait(30);}}
let alphaPhase=0,alphaBusy=false,alphaGesture='',alphaChild=0,alphaPending=0;
let alphaNotifications:Array<{id:number}>=[];
document.addEventListener('mousemove',event=>{if(alphaGesture)alphaReport({stage:'alpha-pointer',gesture:alphaGesture,x:event.clientX,y:event.clientY});});
const alphaId=alphaWindow().id;
window.addEventListener('resize',()=>alphaReport({stage:'alpha-size',width:innerWidth,height:innerHeight}));
void(async()=>{
 await alphaUntil(()=>document.getElementById('status')?.textContent==='Loaded');
 if(alphaId!==1){
  const owned=await alphaGet<{pending:number;notification:number}>('alpha-owned','config');alphaCheck(owned,'Ownership fixture');
  let rejected=0;for(const op of ['system.poll','system.cancel']){try{alphaRequest({op,requestId:owned!.pending});}catch{rejected++;}}
  try{await alphaDismiss({id:owned!.notification});}catch{rejected++;}
  alphaCheck(rejected===3,'Foreign system operations rejected');alphaCheck(alphaWindow().decorations===false&&!alphaWindow().resizable,'Creation options applied');
  await alphaNotify('Child lifetime notification','Must close with child');
  alphaReport({stage:'alpha-child',passed:true,rejected,id:alphaId});return;
 }
 if(await alphaGet('alpha-complete','config')){
  alphaCheck((document.getElementById('note') as HTMLTextAreaElement).value==='Alpha persisted 한글 😀','Workbench restores saved note');
  alphaReport({stage:'alpha-restored',passed:true});setTimeout(()=>alphaClose(),300);return;
 }
 alphaReport({stage:'alpha-ready'});
})().catch(error=>alphaReport({stage:'failure',message:String(error),stack:error?.stack}));
document.addEventListener('mousedown',event=>{
 if(!alphaGesture||event.button!==0)return;event.preventDefault();event.stopImmediatePropagation();
 const gesture=alphaGesture;alphaGesture='';if(gesture==='resize')alphaDragResize('south-east');else alphaDrag();
 alphaReport({stage:'alpha-gesture',gesture,trusted:event.isTrusted});
},true);
window.addEventListener('keydown',event=>{
 if(alphaId!==1)return;
 if(event.key==='F4'){alphaGesture='resize';alphaReport({stage:'alpha-gesture-ready',gesture:'resize'});return;}
 if(event.key==='F5'){alphaGesture='move';alphaReport({stage:'alpha-gesture-ready',gesture:'move'});return;}
 if(event.key!=='F6'||alphaBusy)return;alphaBusy=true;
 void(async()=>{
  const phase=alphaPhase++;alphaReport({stage:'alpha-begin',phase});
  if(phase===0){
   const system=await alphaRefresh();alphaCheck(system.os==='linux'&&system.displays.some(d=>d.width===960&&d.height===720),'Actual output snapshot');
   alphaCheck(!system.capabilities.visibility&&!system.capabilities.restoreMinimized&&!system.capabilities.alwaysOnTop,'Unsupported Wayland features are explicit');
   alphaCheck(Object.isFrozen(system)&&Object.isFrozen(system.displays)&&Object.isFrozen(system.capabilities),'Immutable snapshots');
   let callbacks=0;const stop=alphaWatch(()=>callbacks++);await alphaUntil(()=>callbacks>0);const initial=callbacks;await alphaWait(350);alphaCheck(callbacks===initial,'No idle system polling');stop();
   alphaMaximize(false);await alphaUntil(()=>alphaWindow().maximized===false);alphaResize(640,480);await alphaUntil(()=>innerWidth===640&&innerHeight===480);
   alphaDecorate(false);await alphaUntil(()=>alphaWindow().decorations===false);alphaDecorate(true);await alphaUntil(()=>alphaWindow().decorations===true);
   alphaResizable(false);await alphaUntil(()=>alphaWindow().resizable===false);alphaResizable(true);await alphaUntil(()=>alphaWindow().resizable===true);
   alphaCheck(alphaWindow().minimized===null,'No invented minimized state');
   let invalid=0;for(const action of [()=>alphaDrag(),()=>alphaRequest({op:'decorations',value:'true'}),()=>alphaRequest({op:'visibility',value:false}),()=>alphaRequest({op:'position',x:0,y:0})]){try{action();}catch{invalid++;}}alphaCheck(invalid===4,'Unsupported and synthetic drag rejected');
   const notification=await alphaNotify('Alpha notification','<b>plain & text</b> 한글 😀');alphaNotifications.push(notification);
   alphaPending=alphaRequest({op:'system.start',action:'notify',title:'Owned pending result',body:'Owned by primary'}).id;
   await alphaSet('alpha-owned',{pending:alphaPending,notification:notification.id},'config');
   alphaChild=(await alphaOpen({title:'Alpha child',width:480,height:320,decorations:false,resizable:false})).id;
  }else if(phase===1){
   let result:any;await alphaUntil(()=>{result=alphaRequest({op:'system.poll',requestId:alphaPending});return !result.pending;});alphaNotifications.push(result.value);
   alphaClose(alphaChild);await alphaUntil(()=>alphaWindows().length===1);
   for(let i=0;i<6;i++)alphaNotifications.push(await alphaNotify('Bounded notification '+i,'Private test'));
   let bounded=false;try{await alphaNotify('Over limit','Should reject');}catch(error){bounded=String(error).includes('limit');}alphaCheck(bounded,'Notification bound');
   for(const notification of alphaNotifications)await alphaDismiss(notification);alphaNotifications=[];
   let invalid=0;for(const url of ['file:///tmp/no','javascript:alert(1)','https://user:password@example.test/']){try{await alphaExternal(url);}catch{invalid++;}}alphaCheck(invalid===3,'Native URL allowlist');
   const abort=new AbortController();abort.abort();let cancelled=false;try{await alphaExternal('http://127.0.0.1:9/pre-aborted',{signal:abort.signal});}catch(error){cancelled=(error as Error).name==='AbortError';}alphaCheck(cancelled,'Pre-aborted URL');
  }else if(phase===2){
   alphaCheck(await alphaExternal('http://127.0.0.1:9/weber-alpha-owned?unicode=한글')===true,'Real desktop URL handoff');
  }else if(phase===3){
   const abort=new AbortController();const opened=alphaExternal('http://127.0.0.1:9/weber-alpha-cancel',{ask:true,signal:abort.signal});
   const handled=opened.then(()=>false,error=>(error as Error).name==='AbortError');
   await alphaWait(500);const started=performance.now();const notification=await alphaNotify('While chooser is open','Independent worker');const elapsed=performance.now()-started;
   alphaCheck(elapsed<1500,'URL confirmation does not block notification');await alphaDismiss(notification);abort.abort();alphaCheck(await handled,'Active URL request aborted');
  }else if(phase===4){alphaMinimize();
  }else if(phase===5){
   const note=document.getElementById('note') as HTMLTextAreaElement;note.value='Alpha persisted 한글 😀';note.dispatchEvent(new InputEvent('input',{bubbles:true,data:note.value,inputType:'insertText'}));note.focus();
  }else if(phase===6){
   await alphaUntil(()=>document.getElementById('status')?.textContent==='Saved');await alphaSet('alpha-complete',true,'config');
   alphaReport({stage:'alpha-pass',passed:true});setTimeout(()=>location.href='weber://close',400);
  }
  alphaReport({stage:'alpha-done',phase,passed:true});
 })().catch(error=>alphaReport({stage:'failure',message:String(error),stack:error?.stack})).finally(()=>{alphaBusy=false;});
});

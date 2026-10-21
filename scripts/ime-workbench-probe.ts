// App acceptance only. Normal Workbench rendering and input handlers are intact.
const imeWorkbenchReport=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
const imeWorkbenchState=()=>({value:(document.getElementById('note') as HTMLTextAreaElement)?.value,status:document.getElementById('status')?.textContent,dirty:document.getElementById('dirty')?.textContent});
let imeWorkbenchReady=false;
const imeWorkbenchObserve=()=>{const state=imeWorkbenchState();imeWorkbenchReport({stage:'ime-workbench-state',...state});if(!imeWorkbenchReady&&state.status==='Loaded'){imeWorkbenchReady=true;document.getElementById('note')?.focus();imeWorkbenchReport({stage:'ime-workbench-ready',...state});}};
new MutationObserver(imeWorkbenchObserve).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
for(const type of ['compositionstart','compositionupdate','compositionend','input'])document.addEventListener(type,event=>queueMicrotask(()=>imeWorkbenchReport({stage:'ime-workbench-state',type,trusted:event.isTrusted,...imeWorkbenchState()})));
imeWorkbenchObserve();

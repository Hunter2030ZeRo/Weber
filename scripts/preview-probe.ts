// Native preview fixture only. Never packaged in the normal Notes app.
const previewReport = (data: object) => (window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
const previewDelay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const previewCheck = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
let previewPhase = 0, previewBusy = false, previewState = '';
setInterval(() => {
  const value = {stage:'preview-state',status:document.getElementById('status')?.textContent,dirty:document.getElementById('dirty')?.textContent,dialog:!!document.getElementById('discard-dialog'),error:document.getElementById('weber-error-message')?.textContent};
  const key = JSON.stringify(value); if (key !== previewState) { previewState = key; previewReport(value); }
}, 20);
async function previewAdvance() {
  const phase = previewPhase++;
  previewReport({stage:'preview-begin',phase});
  const note = document.getElementById('note') as HTMLTextAreaElement;
  const type = (value: string) => { note.value=value; note.dispatchEvent(new InputEvent('input',{bubbles:true,data:value,inputType:'insertText'})); };
  if (phase === 0) {
    for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Loaded';i++)await previewDelay(20);
    document.getElementById('open-file')!.click();
  } else if (phase === 1) {
    previewCheck(note.value==='Open 한글 😀\nSecond line','Notes open file contents');
    type('Saved 한글 😀\nNew line'); document.getElementById('save-file')!.click();
  } else if (phase === 2) {
    previewCheck(document.getElementById('status')?.textContent==='File saved','Notes save completed');
    type('Unsaved note to keep');
  } else if (phase === 3) {
    previewCheck(note.value==='Unsaved note to keep'&&!document.getElementById('discard-dialog'),'Close cancellation preserves text');
    previewCheck(await openTextFile()===null,'Portal cancellation returns null');
  } else if (phase === 4) {
    let error='';try{await openTextFile();}catch(value){error=String(value);}previewCheck(error.includes('UTF-8'),'Invalid UTF-8 rejects: '+error);
    previewCheck(note.value==='Unsaved note to keep','Failed open preserves Notes');
  } else if (phase === 5) {
    const result=await saveTextFile('\u0001'.repeat(262144),'boundary.txt');previewCheck(!!result,'Save maximum escaped file');
  } else if (phase === 6) {
    let error='';try{await openTextFile();}catch(value){error=String(value);}previewCheck(error.includes('262144'),'External oversized file rejected: '+error);
    let rejected=0;for(const args of [['x'.repeat(262145),'large.txt'],['text','../bad']]){try{await saveTextFile(args[0],args[1]);}catch{rejected++;}}previewCheck(rejected===2,'SDK file validation');
  } else if (phase === 7) {
    const controller=new AbortController();const result=openTextFile({signal:controller.signal});setTimeout(()=>controller.abort(),700);
    let cancelled=false;try{await result;}catch(error){cancelled=(error as Error).name==='AbortError';}previewCheck(cancelled,'AbortSignal cancels chooser');
  } else if (phase === 8) {
    setTimeout(()=>{throw new Error('Preview synchronous application failure');},0);await previewDelay(150);
    previewCheck(document.getElementById('weber-error-message')?.textContent?.includes('Preview synchronous application failure'),'Visible script error');
  } else if (phase === 9) {
    document.getElementById('weber-error-dismiss')!.click();
    void Promise.reject(new Error('Preview rejected promise <img src=x>'));
    await previewDelay(200);
    previewCheck(document.getElementById('weber-error-message')?.textContent?.includes('Preview rejected promise <img src=x>'),'Visible unhandled rejection');
    previewCheck(!document.querySelector('#weber-error-message img'),'Error text is not HTML');
  } else if (phase === 10) {
    document.getElementById('weber-error-dismiss')!.click();
    previewCheck(note.value==='Unsaved note to keep','Note preserved across errors and cancelled/failed native requests');
  }
  previewReport({stage:'preview-done',phase,passed:true});
}
window.addEventListener('keydown',event=>{if(event.key!=='F6'||previewBusy)return;previewBusy=true;void previewAdvance().catch(error=>previewReport({stage:'failure',message:String(error),stack:error?.stack})).finally(()=>{previewBusy=false;});});

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync,existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('artifacts/foundation');await mkdir(root,{recursive:true});
async function run(name,program,args,cwd=process.cwd()){
 const path=join(root,name+'.log'),fd=openSync(path,'w');
 const child=spawn(program,args,{cwd,env:process.env,stdio:['ignore',fd,fd]});closeSync(fd);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});
 if(code!==0)throw new Error(name+': '+await readFile(path,'utf8'));
}
const cli=resolve('sdk/cli.mjs');
for(const name of ['notes','contracts']){
 const project=join(root,name);
 if(!existsSync(project))await run(name+'-init',process.execPath,[cli,'init',project,'notes']);
 await run(name+'-install','npm',['install',...(process.env.WEBER_NPM_ONLINE==='1'?['--prefer-offline']:['--offline']),'--cache',process.env.WEBER_NPM_CACHE??'/tmp/weber-vite-npm-cache','--no-audit','--no-fund'],project);
 if(name==='notes'){
  await run('notes-build','npm',['run','build'],project);
  const entry=join(project,'src/main.tsx'),original=await readFile(entry,'utf8');
  await writeFile(entry,original+String.raw`
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
const report=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
void(async()=>{
 const {currentWindow,listWindows,closeWindow}=await import('@weber/sdk/window');
 const {getAppPaths}=await import('@weber/sdk/storage');
 for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Loaded';i++)await wait(20);
 check(document.getElementById('status')?.textContent==='Loaded','note loaded');
 const input=document.getElementById('note') as HTMLTextAreaElement;
 const expected='실제 메모 저장 😀\nSecond line';
 if(currentWindow().id!==1){check(input.value===expected,'child loads saved note');await setValue('child-loaded',true);return;}
 if(input.value===expected){report({stage:'notes-restored',passed:true,paths:await getAppPaths(),text:input.value});await wait(100);closeWindow();return;}
 const type=(text:string)=>{input.value=text;input.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));};
 type(expected);document.getElementById('save')!.click();
 for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Saved';i++)await wait(20);
 check(document.getElementById('status')?.textContent==='Saved','save button completion');
 type('unsaved edit');document.getElementById('reload')!.click();
 for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Loaded';i++)await wait(20);
 check(input.value===expected,'reload button restores note');
 document.getElementById('open')!.click();
 for(let i=0;i<150&&await getValue('child-loaded')!==true;i++)await wait(20);
 check(await getValue('child-loaded')===true,'new window loads shared note');
 for(const info of listWindows())if(info.id!==1)closeWindow(info.id);
 report({stage:'notes-pass',passed:true,text:input.value,paths:await getAppPaths()});await wait(200);closeWindow();
})().catch(error=>report({stage:'failure',message:String(error),stack:error?.stack}));`);
  try {await run('notes-native-build',process.execPath,[cli,'build',project,join(project,'dist-native')],project);}
  finally {await writeFile(entry,original);}
 }
 else {
  const manifest=JSON.parse(await readFile(join(project,'weber.json'),'utf8'));manifest.id='dev.weber.storage-contracts';await writeFile(join(project,'weber.json'),JSON.stringify(manifest));
  await writeFile(join(project,'src/main.tsx'),String.raw`import {onMount} from 'solid-js';
import {defineSolidApp} from '@weber/solid';
import {getAppPaths,getValue,setValue,removeValue,listKeys} from '@weber/sdk/storage';
import {currentWindow,openWindow,closeWindow,listWindows,nativeRequest} from '@weber/sdk/window';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
const report=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
async function rejected(work:()=>unknown){try{await work();return false;}catch{return true;}}
function App(){onMount(()=>{void(async()=>{
 const id=currentWindow().id;
 if(id!==1){
  const requestId=await getValue<number>('parent-request');
  check(await rejected(()=>nativeRequest({op:'storage.poll',requestId})),'cross-window request ownership');
  check((await getValue<{text:string}>('roundtrip'))?.text==='한글 😀','shared app storage');
  for(let i=0;i<16;i++)nativeRequest({op:'storage.start',action:'paths'});
  await setValue('child-seen',true);return;
 }
 const paths=await getAppPaths(),restored=await getValue<string>('restart','data');
 if(restored==='persisted 한글 😀'){
  check((await getValue<{text:string}>('roundtrip'))?.text==='한글 😀','restart JSON roundtrip');
  report({stage:'storage-restored',passed:true,paths});await wait(100);closeWindow();return;
 }
 check(await getValue('missing')===null,'missing key');
 await setValue('roundtrip',{text:'한글 😀',nested:[true,null,42]});
 check(JSON.stringify(await getValue('roundtrip'))===JSON.stringify({text:'한글 😀',nested:[true,null,42]}),'nested JSON roundtrip');
 check(await getValue('roundtrip','data')===null,'config/data isolation');
 check((await listKeys()).includes('roundtrip'),'list keys');
 check(await removeValue('missing')===false,'missing removal');
 await setValue('temporary',true);check(await removeValue('temporary'),'removal');check(await getValue('temporary')===null,'removed value');
 let malformed=0;
 for(const work of [()=>setValue('../escape',0),()=>setValue('x','x'.repeat(8192)),()=>setValue('x',NaN),()=>setValue('x',{nested:undefined} as any),()=>setValue('x',1,'outside' as any)])if(await rejected(work))malformed++;
 check(malformed===5,'invalid request rejection');
 const queued=Array.from({length:32},()=>getAppPaths());check(await rejected(()=>getAppPaths()),'pending request limit');await Promise.all(queued);
 await Promise.all(Array.from({length:32},(_,i)=>setValue('ordered',i)));check(await getValue('ordered')===31,'serialized writes');
 const {id:requestId}=nativeRequest({op:'storage.start',action:'paths'});await setValue('parent-request',requestId);
 await openWindow({width:480,height:320});
 for(let i=0;i<150&&await getValue('child-seen')!==true;i++)await wait(20);
 check(await getValue('child-seen')===true,'second-window contract');
 for(const child of listWindows())if(child.id!==id)closeWindow(child.id);
 for(let i=0;i<100&&listWindows().length!==1;i++)await wait(20);
 check(listWindows().length===1,'child closure');
 nativeRequest({op:'storage.poll',requestId});
 await Promise.all(Array.from({length:32},()=>getAppPaths()));
 const cancelled=nativeRequest({op:'storage.start',action:'paths'}).id;nativeRequest({op:'storage.cancel',requestId:cancelled});
 check(await rejected(()=>nativeRequest({op:'storage.poll',requestId:cancelled})),'cancelled result rejected');
 await setValue('restart','persisted 한글 😀','data');
 report({stage:'storage-pass',passed:true,paths,malformed,windows:listWindows().length});await wait(200);closeWindow();
})().catch(error=>report({stage:'failure',message:String(error),stack:error?.stack}));});return <main><h1>Storage contract</h1><input placeholder="Input stays available"/></main>;}
defineSolidApp(App);`);
  await run('contracts-build','npm',['run','build'],project);
 }
 assert.equal(Boolean(JSON.parse(await readFile(join(project,'dist/app.json'),'utf8')).nativeUnit),false);
}
await writeFile('artifacts/foundation-workflow.json',JSON.stringify({passed:true,notes:join(root,'notes/dist'),contracts:join(root,'contracts/dist'),scope:'npm install/check/build; JIT-only fixtures, no runtime proof'},null,2));
console.log('Foundation workflows built');

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('artifacts/clipboard'); await mkdir(root, { recursive: true });
async function run(name, program, args, cwd = process.cwd(), extraEnv = {}) {
  const path = join(root, name + '.log'), fd = openSync(path, 'w');
  const child = spawn(program, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, ...extraEnv } }); closeSync(fd);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  assert.equal(code, 0, await readFile(path, 'utf8'));
}
const project = join(root, 'notes'); await rm(project, { recursive: true, force: true });
let cli = resolve('sdk/cli.mjs');
const installed = process.argv.includes('--installed');
const sdkVersion = JSON.parse(await readFile('sdk/package.json', 'utf8')).version;
await run('init', process.execPath, [cli, 'init', project, 'notes'], process.cwd(), installed ? { WEBER_SDK_SPEC: `file:${resolve('target/npm', `weber-sdk-${sdkVersion}.tgz`)}` } : {});
await run('install', 'npm', ['install', '--offline', '--cache', '/tmp/weber-vite-npm-cache', '--no-audit', '--no-fund'], project);
if (installed) cli = join(project, 'node_modules/@weber/sdk/cli.mjs');
await run('build', 'npm', ['run', 'build'], project);
const entry = join(project, 'src/main.tsx'), original = await readFile(entry, 'utf8');
// Build the keyboard fixture separately; never ship instrumentation in Notes.
await writeFile(entry, original + '\n' + await readFile('scripts/clipboard-browser-probe.ts', 'utf8'));
try { await run('browser-build', process.execPath, [cli, 'build', project, join(project, 'dist-browser')], project); }
finally { await writeFile(entry, original); }
await writeFile(entry, original + String.raw`
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
const report=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
let phase=0,inFlight=false;
const expected='GTK에서 복사한 텍스트 😀\nSecond line';
const copied='Weber에서 복사한 텍스트 😀\nThird line';
async function runClipboard(){
 const {currentWindow}=await import('@weber/sdk/window');
 if(!document.hasFocus()||!currentWindow().focused)return;
 if(phase===0){phase=1;
  for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Loaded';i++)await delay(20);
  document.getElementById('paste')!.click();
  for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Pasted';i++)await delay(20);
  const input=document.getElementById('note') as HTMLTextAreaElement;
  check(input.value===expected,'GTK -> Notes paste: '+input.value+' '+document.getElementById('status')?.textContent);
  input.value=copied;input.dispatchEvent(new InputEvent('input',{bubbles:true,data:copied,inputType:'insertText'}));
  document.getElementById('copy')!.click();
  for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Copied';i++)await delay(20);
  check(document.getElementById('status')?.textContent==='Copied','Notes copy button');
  report({stage:'clipboard-offered',passed:true});return;
 }
 if(phase===1){phase=2;
  let oversized=false,readSize=-1,readError='';try{readSize=(await readText()).length;}catch(error){readError=String(error);oversized=readError.includes('262144');}
  check(oversized,'external oversized read rejected: '+readSize+' '+readError);
  let rejected=0;for(const value of ['한'.repeat(87382),'\0',42]){try{await writeText(value as string);}catch{rejected++;}}
  check(rejected===3,'SDK invalid writes');
  const {nativeRequest}=await import('@weber/sdk/window');
  const capability=document.querySelector('meta[name="weber-native"]')?.getAttribute('content');
  const denied=JSON.parse((window as any).weberHostCall(JSON.stringify({action:'native',capability:'invalid',request:{op:'clipboard.start',action:'read'}})));
  check(!denied.ok,'capability rejection');
  const ids=Array.from({length:16},()=>nativeRequest({op:'clipboard.start',action:'read'}).id);
  let limited=false;try{nativeRequest({op:'clipboard.start',action:'read'});}catch{limited=true;}
  check(limited,'native pending limit');for(const requestId of ids)nativeRequest({op:'clipboard.cancel',requestId});
  await writeText('intermediate write using the same input serial');
  await writeText('\u0001'.repeat(262144));
  report({stage:'clipboard-limits',passed:true,rejected,limited});return;
 }
 if(phase===2){phase=3;
  check(await readText()==='recovered 한글 😀','worker recovered after oversize/cancellation');
  report({stage:'clipboard-pass',passed:true});
 }
}
function runOnce(){if(inFlight)return;inFlight=true;void runClipboard().catch(error=>report({stage:'failure',message:String(error),stack:error?.stack})).finally(()=>{inFlight=false;});}
window.addEventListener('keydown',event=>{if(event.key==='F6')runOnce();if(event.key==='F8')void import('@weber/sdk/window').then(({closeWindow})=>{closeWindow();setTimeout(()=>document.getElementById('discard')?.click(),100);});});
window.addEventListener('blur',()=>{void readText().then(()=>report({stage:'failure',message:'Unfocused read accepted'}),()=>report({stage:'clipboard-unfocused',passed:true}));});`);
try { await run('probe-build', process.execPath, [cli, 'build', project, join(project, 'dist-native')], project); }
finally { await writeFile(entry, original); }
await writeFile('artifacts/clipboard-workflow.json', JSON.stringify({ passed: true, installed, sdkVersion, project, application: join(project, 'dist-native'), browserApplication: join(project, 'dist-browser'), production: join(project, 'dist') }, null, 2));
console.log('Clipboard Notes workflow built');

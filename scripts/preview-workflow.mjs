import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('artifacts/preview');await mkdir(root,{recursive:true});
async function run(name,program,args,cwd=process.cwd(),extra={}){
  const log=join(root,name+'.log'),fd=openSync(log,'w');const child=spawn(program,args,{cwd,env:{...process.env,...extra},stdio:['ignore',fd,fd]});closeSync(fd);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});assert.equal(code,0,await readFile(log,'utf8'));
}
const project=join(root,'notes');await rm(project,{recursive:true,force:true});
let cli=resolve('sdk/cli.mjs');const installed=process.argv.includes('--installed');const sdkVersion=JSON.parse(await readFile('sdk/package.json','utf8')).version;
await run('init',process.execPath,[cli,'init',project,'notes'],process.cwd(),installed?{WEBER_SDK_SPEC:`file:${resolve('target/npm',`weber-sdk-${sdkVersion}.tgz`)}`} : {});
await run('install','npm',['install','--offline','--cache','/tmp/weber-vite-npm-cache','--no-audit','--no-fund'],project);
if(installed)cli=join(project,'node_modules/@weber/sdk/cli.mjs');
await run('build','npm',['run','build'],project);
const entry=join(project,'src/main.tsx'),original=await readFile(entry,'utf8');
await writeFile(entry,original+'\n'+await readFile('scripts/preview-probe.ts','utf8'));
try{await run('probe-build',process.execPath,[cli,'build',project,join(project,'dist-native')],project);}finally{await writeFile(entry,original);}
await writeFile(entry,`import {defineApp} from '@weber/runtime';import{openTextFile}from'@weber/sdk/files';import{closeWindow,currentWindow}from'@weber/sdk/window';defineApp({mount(root){root.textContent='Pending file request shutdown';void(async()=>{while(!document.hasFocus()||!currentWindow().focused)await new Promise(r=>setTimeout(r,20));void openTextFile().catch(()=>{});(window as any).weberHostCall(JSON.stringify({action:'telemetry',data:{stage:'closing-file-started'}}));setTimeout(()=>closeWindow(),1200);})();}});`);
try{await run('close-build',process.execPath,[cli,'build',project,join(project,'dist-close')],project);}finally{await writeFile(entry,original);}
await writeFile(entry,`import{defineApp}from'@weber/runtime';defineApp({mount(){throw new Error('Visible startup failure');}});setTimeout(()=>{(window as any).weberHostCall(JSON.stringify({action:'telemetry',data:{stage:'preview-error-capture',visible:!!document.getElementById('weber-error-overlay')}}));location.href='weber://close';},700);`);
try{await run('error-build',process.execPath,[cli,'build',project,join(project,'dist-error')],project);}finally{await writeFile(entry,original);}
const input=join(root,'input.txt'),output=join(root,'output.txt'),invalid=join(root,'invalid.txt'),oversized=join(root,'oversized.txt');
await writeFile(input,'Open 한글 😀\nSecond line');await rm(output,{force:true});await writeFile(invalid,Buffer.from([0xff]));await writeFile(oversized,'x'.repeat(262145));
await writeFile('artifacts/preview-workflow.json',JSON.stringify({passed:true,installed,sdkVersion,project,application:join(project,'dist-native'),closingApplication:join(project,'dist-close'),errorApplication:join(project,'dist-error'),production:join(project,'dist'),input,output,invalid,oversized},null,2));
console.log('Linux preview fixtures built');

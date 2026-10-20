import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const root=resolve('artifacts/native-transfer');await mkdir(root,{recursive:true});
async function run(name,args,cwd=process.cwd(),extra={}){
 const path=join(root,name+'.log'),fd=openSync(path,'w');const child=spawn(process.execPath,args,{cwd,env:{...process.env,...extra},stdio:['ignore',fd,fd]});closeSync(fd);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});assert.equal(code,0,await readFile(path,'utf8'));
}
const project=join(root,'app');await rm(project,{recursive:true,force:true});
const sdkVersion=JSON.parse(await readFile('sdk/package.json','utf8')).version;
await run('init',[resolve('sdk/cli.mjs'),'init',project,'notes'],process.cwd(),{WEBER_SDK_SPEC:`file:${resolve('target/npm',`weber-sdk-${sdkVersion}.tgz`)}`});
// npm has its own executable; use the same file-backed stdio as other workflows.
const fd=openSync(join(root,'install.log'),'w');const npm=spawn('npm',['install','--offline','--cache','/tmp/weber-vite-npm-cache','--no-audit','--no-fund'],{cwd:project,stdio:['ignore',fd,fd]});closeSync(fd);
assert.equal(await new Promise((done,reject)=>{npm.once('error',reject);npm.once('close',done);}),0,await readFile(join(root,'install.log'),'utf8'));
const manifest=JSON.parse(await readFile(join(project,'weber.json'),'utf8'));manifest.id='dev.weber.native-transfer';await writeFile(join(project,'weber.json'),JSON.stringify(manifest));
await writeFile(join(project,'src/main.tsx'),await readFile('scripts/native-transfer-probe.ts','utf8'));
await run('build',[join(project,'node_modules/@weber/sdk/cli.mjs'),'build',project],project);
await writeFile('artifacts/native-transfer-workflow.json',JSON.stringify({passed:true,installed:true,sdkVersion,project,application:join(project,'dist')},null,2));
console.log('Installed SDK document-transfer fixture built');

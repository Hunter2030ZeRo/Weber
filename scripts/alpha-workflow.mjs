import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const project=resolve('artifacts/alpha/app');await mkdir('artifacts/alpha',{recursive:true});await rm(project,{recursive:true,force:true});
const version=JSON.parse(await readFile('sdk/package.json','utf8')).version;
async function run(name,program,args,cwd=process.cwd(),extra={}){
 const log=resolve(`artifacts/alpha/${name}.log`),fd=openSync(log,'w');const child=spawn(program,args,{cwd,env:{...process.env,...extra},stdio:['ignore',fd,fd]});closeSync(fd);
 assert.equal(await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}),0,await readFile(log,'utf8'));
}
await run('init',process.execPath,[resolve('sdk/cli.mjs'),'init',project,'workbench'],process.cwd(),{WEBER_SDK_SPEC:`file:${resolve('target/npm',`weber-sdk-${version}.tgz`)}`});
await run('install','npm',['install','--offline','--cache','/tmp/weber-vite-npm-cache','--no-audit','--no-fund'],project);
const release=JSON.parse(await readFile('target/npm/release.json','utf8'));
const runtime=release.packages.find(pkg=>pkg.name.startsWith('@weber/runtime-'));assert.ok(runtime);
await run('runtime-install','npm',['install','--save-dev',`file:${resolve('target/npm',runtime.file)}`,'--offline','--cache','/tmp/weber-vite-npm-cache','--no-audit','--no-fund'],project);
const cli=join(project,'node_modules/@weber/sdk/cli.mjs');await run('build','npm',['run','build'],project);
await run('package',process.execPath,[cli,'package',join(project,'dist'),resolve('target/package/weber-workbench-alpha')],project);
const entry=join(project,'src/main.tsx'),original=await readFile(entry,'utf8');
try{await writeFile(entry,original+'\n'+await readFile('scripts/alpha-probe.ts','utf8'));await run('probe-build',process.execPath,[cli,'build',project,join(project,'dist-native')],project);}finally{await writeFile(entry,original);}
await writeFile('artifacts/alpha-workflow.json',JSON.stringify({passed:true,installed:true,sdkVersion:version,project,application:join(project,'dist-native'),production:join(project,'dist'),package:resolve('target/package/weber-workbench-alpha')},null,2));
console.log('Installed SDK alpha Workbench built and packaged');

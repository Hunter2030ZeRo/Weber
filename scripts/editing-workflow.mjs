import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const project=resolve('artifacts/editing/app'),installed=process.argv.includes('--installed');
await mkdir('artifacts/editing',{recursive:true});await rm(project,{recursive:true,force:true});
const version=JSON.parse(await readFile('sdk/package.json','utf8')).version;
async function run(name,args,cwd=process.cwd(),extra={}){const log=resolve('artifacts/editing/'+name+'.log'),fd=openSync(log,'w');const child=spawn(args[0],args.slice(1),{cwd,env:{...process.env,...extra},stdio:['ignore',fd,fd]});closeSync(fd);assert.equal(await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done)}),0,await readFile(log,'utf8'));}
await run('init',[process.execPath,resolve('sdk/cli.mjs'),'init',project,'dom'],process.cwd(),installed?{WEBER_SDK_SPEC:`file:${resolve('target/npm',`weber-sdk-${version}.tgz`)}`} : {});
await run('install',['npm','install','--offline','--cache',process.env.WEBER_NPM_CACHE??'/tmp/weber-vite-npm-cache','--no-audit','--no-fund'],project);
await writeFile(join(project,'src/main.ts'),await readFile('scripts/editing-probe.ts','utf8'));
const cli=installed?join(project,'node_modules/@weber/sdk/cli.mjs'):resolve('sdk/cli.mjs');
await run('build',[process.execPath,cli,'build',project],project);
await writeFile('artifacts/editing-workflow.json',JSON.stringify({passed:true,installed,sdkVersion:version,project,application:join(project,'dist')},null,2));
console.log('Native editing fixture built');

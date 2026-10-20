import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const cycles=Number(process.argv.find(arg=>arg.startsWith('--cycles='))?.split('=')[1]??50);assert.ok(Number.isInteger(cycles)&&cycles>=50&&cycles<=1000);
const styles=process.argv.includes('--styles');
const suffix='-resource-'+cycles+(styles?'-styles':'');
const root=resolve('artifacts/lifecycle'+suffix);await mkdir(root,{recursive:true});
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
const manifest=JSON.parse(await readFile(join(project,'weber.json'),'utf8'));manifest.id='dev.weber.resource'+cycles+(styles?'.styles':'');await writeFile(join(project,'weber.json'),JSON.stringify(manifest));
let probe=(await readFile('scripts/lifecycle-probe.ts','utf8')).replace('const cycleCount = 50;', 'const cycleCount = '+cycles+';').replace("report({ stage: 'lifecycle-phase', phase, cycles });", "report({ stage: 'lifecycle-phase', phase, cycles }); await wait(1200); report({stage:'memory-profile',label:phase});").replace('cycle % 10 === 0', '[10,50,100,200,500,1000].includes(cycle)').replace("const self = currentWindow().id;", "check(!(navigator as any).servo, 'Private engine APIs remain unavailable'); const self = currentWindow().id;");
if(styles)probe=probe.replace('for (let i = 0; i < 80;', 'const styleRows = currentWindow().id % 2 ? 80 : 600; for (let i = 0; i < styleRows;').replace('const self = currentWindow().id;', `const self = currentWindow().id;
  const expected = self % 2 ? 'rgb(11, 37, 101)' : 'rgb(179, 23, 61)';
  const style = document.createElement('style');
  style.textContent = '#rows > div { color: ' + expected + '; margin-left: ' + (self % 13) + 'px; }';
  document.head.appendChild(style);
  const computed = getComputedStyle(rows.firstElementChild!);
  check(computed.color === expected && computed.marginLeft === (self % 13) + 'px', 'Styles isolated after thread/cache reuse');
`);
await writeFile(join(project,'src/main.tsx'),probe);
await run('build',[join(project,'node_modules/@weber/sdk/cli.mjs'),'build',project],project);
await writeFile(`artifacts/lifecycle${suffix}-workflow.json`,JSON.stringify({passed:true,installed:true,cycles,styles,sdkVersion,project,application:join(project,'dist')},null,2));
console.log('Installed SDK resource fixture built');

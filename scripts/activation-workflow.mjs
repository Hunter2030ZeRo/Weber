import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const project = join(await mkdtemp(join(tmpdir(), 'weber-activation-')), 'project');
await mkdir('artifacts/activation-workflow', { recursive: true });
async function run(name, program, args, cwd = project) {
  const log = resolve(`artifacts/activation-workflow/${name}.log`), fd = openSync(log, 'w');
  const child = spawn(program, args, { cwd, env: process.env, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  if (code !== 0) throw new Error(name + ': ' + await readFile(log, 'utf8'));
}
await run('init', process.execPath, [resolve('sdk/cli.mjs'), 'init', project, 'windows'], process.cwd());
await run('install', 'npm', ['install', '--offline', '--cache', '/tmp/weber-vite-npm-cache', '--no-audit', '--no-fund']);
await writeFile(join(project, 'backend/main.mjs'), `export default { info() { return {pid:process.pid,tokenInherited:'XDG_ACTIVATION_TOKEN' in process.env,startupIdInherited:'DESKTOP_STARTUP_ID' in process.env}; } };`);
await writeFile(join(project, 'src/main.tsx'), `import { onMount } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { currentWindow, listWindows, openWindow, closeWindow } from '@weber/sdk/window';
import { invoke } from '@weber/sdk/backend';
const report=(data:object)=>(window as unknown as {weberHostCall:(request:string)=>string}).weberHostCall(JSON.stringify({action:'telemetry',data}));
function App(){
 const id=currentWindow().id;
 onMount(()=>{
  void invoke('info').then(backend=>report({stage:'activation-ready',id,backend})).catch(error=>report({stage:'failure',message:String(error)}));
  window.addEventListener('keydown',event=>{void(async()=>{
   if(event.key==='F6') { const child=await openWindow({title:'Activation child',width:480,height:320});report({stage:'activation-created',id,child:child.id}); }
   if(event.key==='F7') {
    const opening=openWindow();const target=listWindows().find(window=>window.id!==id);
    if(!target)throw new Error('Expected new window');closeWindow(target.id);
    let resolved=false;try{await opening;resolved=true;}catch{}
    report({stage:'activation-canceled',id,child:target.id,stateAtClose:target.state,resolved});
   }
   if(event.key==='F9') {void openWindow().catch(()=>{});closeWindow();}
   if(event.key==='F10')closeWindow();
  })().catch(error=>report({stage:'failure',message:String(error)}));});
 });
 return <main><h1>Activation test {id}</h1><p>F6 open · F7 cancel · F9 open and close owner · F10 close</p><input placeholder="Native input remains available"/></main>;
}
defineSolidApp(App);`);
await run('build', process.execPath, [resolve('sdk/cli.mjs'), 'build', project]);
assert.ok(JSON.parse(await readFile(join(project, 'dist/app.json'))).backend);
await writeFile('artifacts/activation-workflow.json', JSON.stringify({ passed: true, project, application: join(project, 'dist'), installedSdk: false, scope: 'Vite/Solid/TypeScript and Bun compiled through checkout SDK; native behavior is a separate gate.' }, null, 2));
console.log('Activation fixture compiled');

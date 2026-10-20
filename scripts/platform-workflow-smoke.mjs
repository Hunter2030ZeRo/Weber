import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const project = join(await mkdtemp(join(tmpdir(), 'weber-platform-')), 'project');
await mkdir('artifacts/platform-workflow', { recursive: true });
async function run(name, program, args, cwd = project) {
  const log = resolve('artifacts/platform-workflow/' + name + '.log'), fd = openSync(log, 'w');
  const child = spawn(program, args, { cwd, env: process.env, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  if (code !== 0) throw new Error(name + ': ' + await readFile(log, 'utf8'));
}
await run('init', process.execPath, [resolve('sdk/cli.mjs'), 'init', project, 'solid'], process.cwd());
await run('install', 'npm', ['install', ...(process.env.WEBER_NPM_ONLINE === '1' ? ['--prefer-offline'] : ['--offline']), '--cache', process.env.WEBER_NPM_CACHE ?? '/tmp/weber-vite-npm-cache', '--no-audit', '--no-fund']);
await mkdir(join(project, 'public'), { recursive: true });
await writeFile(join(project, 'public/platform-probe.js'), `(() => {
  let previous='';
  setInterval(() => {
    const text=document.querySelector('#platform-result')?.textContent;
    if (!text || text==='pending' || text===previous) return;
    previous=text;
    const data=JSON.parse(text);
    data.elements=document.querySelectorAll('#aot-dom-root *').length;
    data.viewport={width:innerWidth,height:innerHeight,scale:devicePixelRatio};
    window.weberHostCall(JSON.stringify({action:'telemetry',data}));
  }, 30);
})();`);
const shared = `import { createSignal, onMount, For } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { currentWindow, listWindows, openWindow, closeWindow, setWindowTitle, resizeWindow, setWindowMaximized, setWindowFullscreen, setWindowResizable, onWindowsChanged, type WindowSnapshot } from '@weber/sdk/window';
import './style.css';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
async function until(test:()=>boolean) {const end=performance.now()+8000;while(!test()){if(performance.now()>end)throw new Error('Condition timeout');await wait(30);}}
function probe(){const script=document.createElement('script');script.setAttribute('src','/platform-probe.js');document.body.appendChild(script);}
`;
await writeFile(join(project, 'src/main.tsx'), shared + `
function App(){
 const id=currentWindow().id,[result,setResult]=createSignal('pending'),[description,setDescription]=createSignal('waiting');
 onMount(()=>{probe();void(async()=>{
  if(id!==1){setResult(JSON.stringify({stage:'platform-child',id}));return;}
  const snapshots:WindowSnapshot[]=[];let latest:WindowSnapshot|undefined;
  const stop=onWindowsChanged(snapshot=>{snapshots.push(snapshot);latest=snapshot;setDescription(JSON.stringify(snapshot));});
  const own=()=>latest?.windows.find(window=>window.id===id);
  await until(()=>Boolean(own()));
  const initial=snapshots.length;await wait(350);check(snapshots.length===initial,'no idle snapshot polling');
  setWindowMaximized(false);await until(()=>own()?.maximized===false);
  resizeWindow(640,480);await until(()=>own()?.width===640&&own()?.height===480);
  await until(()=>innerWidth===640&&innerHeight===480);
  check(document.querySelector('#description')?.textContent?.includes('640'),'snapshot updates DOM');
  setWindowResizable(false);await until(()=>own()?.resizable===false);
  setWindowResizable(true);await until(()=>own()?.resizable===true);
  setWindowMaximized(true);await until(()=>own()?.maximized===true&&Number(own()?.width)>640);
  setWindowMaximized(false);await until(()=>own()?.maximized===false&&own()?.width===640);
  setWindowFullscreen(true);await until(()=>own()?.fullscreen===true&&own()?.width===960&&own()?.height===720);
  await until(()=>innerWidth===960&&innerHeight===720);
  setWindowFullscreen(false);await until(()=>own()?.fullscreen===false);
  await until(()=>innerWidth===own()?.width&&innerHeight===own()?.height);
  const restored={width:own()?.width,height:own()?.height};
  resizeWindow(640,480);await until(()=>own()?.width===640&&own()?.height===480);
  await until(()=>innerWidth===640&&innerHeight===480);
  const second=await openWindow({width:420,height:280});await until(()=>latest?.windows.some(window=>window.id===second.id&&window.state==='ready')===true);
  resizeWindow(460,300,second.id);await until(()=>latest?.windows.find(window=>window.id===second.id)?.width===460);
  closeWindow(second.id);await until(()=>!latest?.windows.some(window=>window.id===second.id));
  let malformed=0;
  for(const action of [()=>resizeWindow(0,480),()=>resizeWindow(640,480,-1),()=>resizeWindow(640,480,'1' as unknown as number),()=>setWindowFullscreen(1 as unknown as boolean),()=>setWindowMaximized(true,999)]){try{action();}catch{malformed++;}}
  check(malformed===5,'malformed requests rejected');
  for(let i=0;i<30;i++)setWindowTitle('Coalesced '+i);
  const busy=performance.now()+250;while(performance.now()<busy){}
  await until(()=>own()?.title==='Coalesced 29');
  check(snapshots.every((snapshot,index)=>index===0||snapshot.revision>snapshots[index-1].revision),'monotonic snapshots');
  stop();const stopped=snapshots.length;
  setWindowTitle('Unsubscribed');await wait(300);check(snapshots.length===stopped,'unsubscribe');
  let renewed=0;const stopAgain=onWindowsChanged(()=>renewed++);await until(()=>renewed>0);stopAgain();
  const stops:Array<()=>void>=[];for(let i=0;i<64;i++)stops.push(onWindowsChanged(()=>{}));
  let limited=false;try{onWindowsChanged(()=>{});}catch{limited=true;}check(limited,'listener bound');for(const dispose of stops)dispose();
  setResult(JSON.stringify({stage:'platform-pass',id,passed:true,snapshots:snapshots.length,malformed,limited,initial,stopped,renewed,restored,info:currentWindow()}));
  await wait(400);closeWindow();
 })().catch(error=>setResult(JSON.stringify({stage:'failure',message:String(error),stack:error?.stack,info:currentWindow()})));});
 return <main><h1>Platform controls</h1><input placeholder="Input remains available"/><div class="meter"/><pre id="description">{description()}</pre><pre id="platform-result">{result()}</pre></main>;
}
defineSolidApp(App);`);
await run('controls-jit', process.execPath, [resolve('sdk/cli.mjs'), 'build', project, join(project,'controls-jit')]);
await run('controls-aot', process.execPath, [resolve('sdk/cli.mjs'), 'build', project, join(project,'controls-aot'), '--aot']);
await writeFile(join(project, 'src/main.tsx'), shared + `
function App(){
 const id=currentWindow().id,[result,setResult]=createSignal('pending'),[count,setCount]=createSignal(80),[ticks,setTicks]=createSignal(0);
 const opens:number[]=[];
 const open=async(width:number,height:number)=>{const started=performance.now(),child=await openWindow({width,height});opens.push(performance.now()-started);return child;};
 const phase=async(name:string,extra:object={})=>{setResult(JSON.stringify({stage:'resource-phase',phase:name,id,...extra}));await wait(3500);};
 onMount(()=>{probe();void(async()=>{
  if(id!==1){setResult(JSON.stringify({stage:'resource-child',id}));return;}
  await phase('small');setCount(1000);await phase('large');
  const children:number[]=[];for(let i=0;i<3;i++)children.push((await open(640,480)).id);
  await phase('four-windows');for(const child of children)closeWindow(child);await until(()=>listWindows().length===1);await phase('closed-three');
  for(let i=1;i<=15;i++){const child=await open(480,320);await wait(500);closeWindow(child.id);await until(()=>listWindows().length===1);await wait(500);if(i%5===0)await phase('cycle-'+i,{cycles:i});}
  setCount(80);await phase('small-again');
  setResult(JSON.stringify({stage:'resource-pass',passed:true,id,cycles:15,windows:listWindows().length,windowCreateMs:opens}));await wait(400);closeWindow();
 })().catch(error=>setResult(JSON.stringify({stage:'failure',message:String(error),stack:error?.stack})));});
 return <main><h1>Resource workload</h1><input placeholder="Editable text"/><button onClick={()=>setTicks(ticks()+1)}>Counter {ticks()}</button><div class="meter"/><div class="rows"><For each={Array.from({length:count()},(_,index)=>index)}>{index=><p><b>Row {index}</b><span> GUI content and text layout </span><input value={'value '+index}/></p>}</For></div><pre id="platform-result">{result()}</pre></main>;
}
defineSolidApp(App);`);
await writeFile(join(project, 'src/style.css'), 'body{font:16px sans-serif;margin:0;background:#f5f5f5;color:#222}main{padding:20px}.rows{height:260px;overflow:auto}p{margin:4px}input,button{padding:6px}pre{white-space:pre-wrap;max-height:140px;overflow:auto}.meter{height:10px;width:120px;background:#42885a;animation:pulse 1s alternate infinite}@keyframes pulse{to{transform:translateX(80px)}}');
await run('resources-jit', process.execPath, [resolve('sdk/cli.mjs'), 'build', project, join(project,'resources-jit')]);
await run('resources-aot', process.execPath, [resolve('sdk/cli.mjs'), 'build', project, join(project,'resources-aot'), '--aot']);
for(const name of ['controls-jit','controls-aot','resources-jit','resources-aot'])assert.equal(Boolean(JSON.parse(await readFile(join(project,name,'app.json'))).nativeUnit),name.endsWith('aot'));
await writeFile('artifacts/platform-workflow.json', JSON.stringify({passed:true,project,scope:'Compiled fixtures. Actual Wayland controls and resource runs are separate gates.'},null,2));
console.log(JSON.stringify({passed:true,project}));

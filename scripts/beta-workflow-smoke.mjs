import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const project = join(await mkdtemp(join(tmpdir(), 'weber-beta-workflow-')), 'project');
await mkdir('artifacts/beta-workflow', { recursive: true });
async function run(name, program, args, cwd = project, env = process.env) {
  const log = resolve('artifacts/beta-workflow/' + name + '.log'), fd = openSync(log, 'w');
  const child = spawn(program, args, { cwd, env, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  if (code !== 0) throw new Error(name + ': ' + await readFile(log, 'utf8'));
}
await run('init', process.execPath, [resolve('sdk/cli.mjs'), 'init', project, 'windows'], process.cwd());
await run('install', 'npm', ['install', '--offline', '--cache', '/tmp/weber-vite-npm-cache', '--no-audit', '--no-fund']);
await writeFile(join(project, 'backend/main.mjs'), `import { setTimeout as delay } from 'node:timers/promises';
const marks = {}, active = {};
export default {
  info() { return { pid: process.pid, bun: Bun.version }; },
  mark({ key, value }) { marks[key] = value; return true; },
  state() { return { marks, active }; },
  async watch({ tag, limit = 0 }, { signal, emit }) {
    active[tag] = (active[tag] ?? 0) + 1;
    try { for (let i=1; !signal.aborted && (!limit || i<=limit); i++) { await emit(i); await delay(25, null, {signal}); } }
    catch(error) { if (!signal.aborted) throw error; }
    finally { active[tag]--; }
  },
  end() {},
  async pending(_, {signal}) { active.pending=1; try { await delay(10000,null,{signal}); } finally { active.pending=0; } },
  async burst(_, { emit, signal }) { for (let i=0; i<2000 && !signal.aborted; i++) await emit(i); },
  async invalid(_, { emit }) { await emit(1n); },
  crash() { process.exit(23); }
};`);
await writeFile(join(project, 'src/main.tsx'), `import { createSignal, onMount } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { invoke, subscribe } from '@weber/sdk/backend';
import { currentWindow, listWindows, openWindow, closeWindow, setWindowTitle } from '@weber/sdk/window';
import './style.css';
const wait = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value:unknown, message:string) => { if (!value) throw new Error(message); };
async function until(test:()=>boolean|Promise<boolean>) { const end=performance.now()+8000; while(!await test()) { if(performance.now()>end)throw new Error('Condition timeout'); await wait(30); } }
async function state() { return await invoke<{marks:Record<string,any>,active:Record<string,number>}>('state'); }
function App() {
  const id=currentWindow().id;
  const [result,setResult]=createSignal('pending'), [value,setValue]=createSignal(0);
  const finish=(data:object)=>setResult(JSON.stringify({passed:true,id,...data}));
  onMount(() => {
    const script=document.createElement('script');script.setAttribute('src','/probe.js');document.body.appendChild(script);
    void (async()=>{
      const info=await invoke<{pid:number,bun:string}>('info');
      setWindowTitle('Weber test '+id);
      if(id===1) {
        check(listWindows().length===1,'initial window count');
        const values:number[]=[];
        await new Promise<void>((resolve,reject)=>subscribe<number>('watch',{tag:'finite',limit:3},n=>{values.push(n);setValue(n);},{onError:reject,onEnd:resolve}));
        check(values.join(',')==='1,2,3','ordered events/end');
        check(document.querySelector('#stream')?.textContent==='3','event updates real DOM');
        const unknown=await new Promise<string>(resolve=>subscribe('missing',null,()=>{}, {onError:error=>resolve(String(error))}));
        check(unknown.includes('Unknown backend method'),'subscription error');
        const invalid=await new Promise<string>(resolve=>subscribe('invalid',null,()=>{}, {onError:error=>resolve(String(error))}));
        check(invalid.includes('BigInt')||invalid.includes('JSON'),'invalid event');
        const endings:Promise<void>[]=[];let rejected=0;
        for(let i=0;i<129;i++) {
          try { let finish!:()=>void;const end=new Promise<void>(resolve=>{finish=resolve;});subscribe('end',null,()=>{}, {onEnd:finish,onError:error=>{throw error;}});endings.push(end); }
          catch { rejected++; }
        }
        check(endings.length>0 && endings.length<=64 && rejected===129-endings.length,'completed subscriptions retain bounded delivery slots');
        await Promise.all(endings);
        let received=0;
        const stop=subscribe('watch',{tag:'cancel'},()=>{received++;});
        await until(()=>received>=2);stop();const stopped=received;await wait(150);
        check(received===stopped && (await state()).active.cancel===0,'unsubscribe and abort');
        const overflow=new Promise<string>(resolve=>subscribe('burst',null,()=>{}, {onError:error=>resolve(String(error)),onEnd:()=>resolve('unexpected end')}));
        const busyUntil=performance.now()+400;while(performance.now()<busyUntil){}
        check((await overflow).includes('overflow'),'bounded event overflow');
        let alive=0;subscribe('watch',{tag:'root-owned'},()=>{alive++;});await until(()=>alive>0);
        void invoke('pending').catch(()=>{});await until(async()=>(await state()).active.pending===1);
        const second=await openWindow({width:640,height:480,title:'Child'});
        check(second.id===2,'second window id');
        await until(async()=>Boolean((await state()).marks['child-mounted']));
        finish({info,orderedEvents:values,cancelled:true,overflow:true,completionSlots:endings.length,rejectedCompletions:rejected,second:second.id});
        await wait(500);closeWindow();
      } else if(id===2) {
        await invoke('mark',{key:'child-mounted',value:true});
        await until(()=>!listWindows().some(window=>window.id===1));
        await until(async()=>(await state()).active['root-owned']===0);
        await until(async()=>(await state()).active.pending===0);
        const third=await openWindow({width:420,height:280});
        await until(async()=>Boolean((await state()).marks['third-mounted']));
        await until(()=>!listWindows().some(window=>window.id===third.id));
        let invalidSize=false;try { await openWindow({width:0}); } catch { invalidSize=true; }check(invalidSize,'invalid window rejected');
        let ticks=0;let disconnectedResolve!:(value:string)=>void;
        const disconnected=new Promise<string>(resolve=>{disconnectedResolve=resolve;});
        subscribe<number>('watch',{tag:'child-owned'},n=>{ticks++;setValue(n);},{onError:error=>disconnectedResolve(String(error))});
        await until(()=>ticks>=2);
        try { await invoke('crash'); } catch {}
        check((await disconnected).includes('Backend stopped'),'backend death reaches subscriber');
        finish({info,parentClosed:true,ownedSubscriptionCancelled:true,third:third.id,backendDisconnect:true,invalidSize});
        await wait(500);closeWindow();
      } else {
        await invoke('mark',{key:'third-mounted',value:true});finish({third:true});await wait(500);closeWindow();
      }
    })().catch(error=>{setResult(JSON.stringify({passed:false,id,error:String(error),stack:error?.stack}));});
  });
  return <main><h1>Native window {id}</h1><p id="stream">{value()}</p><pre id="beta-result">{result()}</pre></main>;
}
defineSolidApp(App);`);
await mkdir(join(project,'public'),{recursive:true});
await writeFile(join(project,'public/probe.js'), `(()=>{
  let reported=false;
  const timer=setInterval(()=>{
    const text=document.querySelector('#beta-result')?.textContent;if(!text||text==='pending'||reported)return;
    const data=JSON.parse(text);reported=true;clearInterval(timer);
    const denied=JSON.parse(window.weberHostCall(JSON.stringify({action:'native',capability:'wrong',request:{op:'open'}})));
    data.capabilityRejected=denied.ok===false;
    window.weberHostCall(JSON.stringify({action:data.passed?'telemetry':'telemetry',data:{stage:data.passed?'beta-window':'failure',...data,message:data.error}}));
  },30);
})();`);
await run('build-jit',process.execPath,[resolve('sdk/cli.mjs'),'build',project,join(project,'dist-jit')]);
await run('build-aot',process.execPath,[resolve('sdk/cli.mjs'),'build',project,join(project,'dist-aot'),'--aot']);
const manifest=JSON.parse(await readFile(join(project,'dist-jit/app.json')));assert.ok(!manifest.nativeUnit);
await writeFile('artifacts/beta-workflow.json',JSON.stringify({passed:true,project,scope:'Build fixture; native run is a separate gate.'},null,2));
console.log(JSON.stringify({passed:true,project}));

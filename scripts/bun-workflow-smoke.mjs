import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, cp, access } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execute } from './native-desktop.mjs';
import { digest } from '../sdk/project.mjs';

const binary = resolve(process.argv[2] ?? 'target/debug/weber-servo');
const project = join(await mkdtemp(join(tmpdir(), 'weber-bun-workflow-')), 'project');
const directory = resolve('artifacts/bun-workflow'); await mkdir(directory, { recursive: true });
const env = { ...process.env, WEBER_HOST: binary };
async function run(name, executable, args, cwd = project) {
  const path = join(directory, name + '.log'), fd = openSync(path, 'w');
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 120000);
  let code;
  try { code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); }
  finally { clearTimeout(timer); }
  const output = await readFile(path, 'utf8');
  if (code !== 0) throw Object.assign(new Error(`${name}: ${output}`), { code, output });
  return output;
}
await run('init', process.execPath, [resolve('sdk/cli.mjs'), 'init', project, 'node'], process.cwd());
await run('npm-install', 'npm', ['install', '--offline', '--cache', '/tmp/weber-vite-npm-cache', '--no-audit', '--no-fund']);
await run('npm-semver', 'npm', ['install', 'semver@6.3.1', '--offline', '--cache', '/tmp/weber-vite-npm-cache', '--no-audit', '--no-fund']);
const backendPath = join(project, 'backend/main.mjs');
let backend = await readFile(backendPath, 'utf8');
backend = `import semver from 'semver';\nimport { writeFileSync } from 'node:fs';\nimport { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nimport { setTimeout as delay } from 'node:timers/promises';\n` + backend.replace('export default {', 'const methods = {').replace('pid: process.pid', 'pid: process.pid, mode: process.env.WEBER_BACKEND_TEST_MODE ?? "full"');
backend += `
Object.assign(methods, {
  echo(value) { return value; },
  package() { return { semver: semver.satisfies('1.2.3', '^1.0.0') }; },
  async process() { return (await promisify(execFile)('/usr/bin/printf', ['process-ok'])).stdout; },
  async delay({ ms, value }, { signal }) { await delay(ms, null, { signal }); return value; },
  fail() { throw new TypeError('backend-example-error'); },
  big() { return 'x'.repeat(1100000); },
  invalid() { return 1n; },
  log() { console.log('backend-console-is-stderr'); return true; },
  busy() { const end = performance.now()+300; while (performance.now()<end) {} return true; },
  forever() { writeFileSync(process.env.WEBER_BACKEND_BUSY_MARKER, 'busy'); while (true) {} },
  crash() { process.exit(19); },
});
export default methods;
`;
await writeFile(backendPath, backend);
await writeFile(join(project, 'src/main.tsx'), `import { createSignal, onMount } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { invoke } from '@weber/sdk/backend';
import './style.css';
async function rejected(method: string, params: any = null, timeoutMs?: number) {
  try { await invoke(method, params, timeoutMs ? { timeoutMs } : {}); throw new Error('Expected rejection: '+method); }
  catch(error) { const text=String(error); if (text.includes('Expected rejection:')) throw error; return text; }
}
export default function App() {
  const [result, setResult] = createSignal('pending');
  onMount(() => {
    const script=document.createElement('script'); script.setAttribute('src','/probe.js'); document.body.appendChild(script);
    void (async () => {
      const info=await invoke<{bun:string,pid:number,mode:string}>('info');
      if(info.mode==='healthy'){setResult(JSON.stringify({passed:true,info}));return;}
      if(info.mode==='hang'){void invoke('forever').catch(()=>{});setResult(JSON.stringify({passed:true,info,hanging:true}));return;}
      const round=await invoke<{text:string,sha256:string}>('roundTrip',{text:'Node APIs · 가나다'});
      if(round.text!=='Node APIs · 가나다'||round.sha256.length!==64)throw new Error('file/crypto');
      if(!(await invoke<{semver:boolean}>('package')).semver)throw new Error('npm dependency');
      if(await invoke('process')!=='process-ok')throw new Error('child_process');
      if(JSON.stringify(await invoke('echo',{unicode:'가나다',nested:[1,true,null]}))!==JSON.stringify({unicode:'가나다',nested:[1,true,null]}))throw new Error('JSON');
      const concurrent=await Promise.all(Array.from({length:16},(_,i)=>invoke('delay',{ms:(16-i)*3,value:i})));
      if(concurrent.some((value,i)=>value!==i))throw new Error('correlation');
      const methodError=await rejected('fail'); if(!methodError.includes('backend-example-error'))throw new Error(methodError);
      const unknown=await rejected('missing'); if(!unknown.includes('Unknown backend method'))throw new Error(unknown);
      const timeout=await rejected('delay',{ms:1000,value:0},20); if(!timeout.includes('timed out'))throw new Error(timeout);
      const large=await rejected('big'); if(!large.includes('1MiB'))throw new Error(large);
      const invalid=await rejected('invalid'); if(!invalid.includes('JSON'))throw new Error(invalid);
      if(!await invoke('log'))throw new Error('console transport');
      let ticks=0, active=true; const tick=()=>{if(active){ticks++;requestAnimationFrame(tick);}};requestAnimationFrame(tick);
      await invoke('busy');active=false;if(ticks<2)throw new Error('UI blocked by backend work: '+ticks);
      const saturated=await Promise.allSettled(Array.from({length:129},()=>invoke('delay',{ms:800,value:true})));
      if(saturated.filter(item=>item.status==='rejected').length!==1)throw new Error('pending bound');
      const crash=await rejected('crash'); if(!crash.includes('Backend stopped'))throw new Error(crash);
      const dead=await rejected('echo'); if(!dead.includes('Backend stopped'))throw new Error(dead);
      setResult(JSON.stringify({passed:true,info,round,concurrent:concurrent.length,methodError,unknown,timeout,large,invalid,ticks,backpressure:true,crash,dead}));
    })().catch(error=>setResult(JSON.stringify({passed:false,error:String(error),stack:error?.stack})));
  });
  return <main><h1>Bun integration</h1><pre id="backend-result">{result()}</pre></main>;
}
defineSolidApp(App);
`);
await mkdir(join(project, 'public'));
await writeFile(join(project, 'public/probe.js'), `(() => {
 const report=data=>window.weberHostCall(JSON.stringify({action:'telemetry',data}));
 const capability=document.querySelector('meta[name="weber-backend"]').content;
 const denied=JSON.parse(window.weberHostCall(JSON.stringify({action:'backend',capability:'invalid',request:{op:'status'}})));
 if(denied.ok){report({stage:'failure',message:'Unauthenticated backend call accepted'});location.href='weber://close';return;}
 const interval=setInterval(()=>{let data;try{data=JSON.parse(document.getElementById('backend-result').textContent);}catch{return;}
  clearInterval(interval); report({stage:data.passed?(data.hanging?'backend-hanging':'backend-test'):'failure',...data,message:data.error,capabilityRejected:true});if(!data.hanging)setTimeout(()=>location.href='weber://close',100);
 },30);
})();`);
await run('npm-check', 'npm', ['run', 'check']);
await run('npm-package-jit', 'npm', ['run', 'package']);
const jit = JSON.parse(await readFile(join(project, 'dist/app.json')));
assert.equal(jit.backend.runtime, 'bun'); assert.equal(jit.nativeUnit, undefined);
assert.equal(jit.assets['/backend'], undefined);
await access(join(project, 'package/application/backend'));
await cp(join(project, 'package'), join(project, 'package-jit'), { recursive: true });
await run('npm-package-aot', 'npm', ['run', 'package:aot']);
const aot = JSON.parse(await readFile(join(project, 'dist/app.json'))); assert.ok(aot.nativeUnit); assert.ok(aot.backend);
await cp(join(project, 'package'), join(project, 'package-aot'), { recursive: true });
const previous = digest(await readFile(join(project, 'dist/app.json')));
await writeFile(backendPath, backend + '\nthis is a deliberate syntax error }\n');
await assert.rejects(run('backend-error-preserves-build', 'npm', ['run', 'build']));
assert.equal(digest(await readFile(join(project, 'dist/app.json'))), previous);
await writeFile(backendPath, backend);
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout);
await writeFile('artifacts/bun-workflow.json', JSON.stringify({ passed:true, build, binary, project, bunVersion:jit.backend.bunVersion, results:['npm scripts and semver dependency','JIT package with standalone Bun executable','native AOT UI package with same backend contract','backend compile failure preserves preceding build'],scope:'Build/package evidence; native invocation checked separately.' },null,2));
console.log(JSON.stringify({ passed:true,project,bunVersion:jit.backend.bunVersion }));

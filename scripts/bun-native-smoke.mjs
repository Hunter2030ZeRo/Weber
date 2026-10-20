import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, cp, mkdtemp, access, chmod, symlink, rename } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, execute, waitFor, readEvents, delay } from './native-desktop.mjs';
import { digest } from '../sdk/project.mjs';

const workflow=JSON.parse(await readFile('artifacts/bun-workflow.json'));
const {project,binary,build,bunVersion}=workflow;
const results=[], negative=[];
const previous={WEBER_APP_TEST:process.env.WEBER_APP_TEST,LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH,WEBER_BACKEND_TEST_MODE:process.env.WEBER_BACKEND_TEST_MODE};
const hidden=[];
const restore=async()=>{for(const name of hidden.splice(0))await rename(join(project,name+'.runtime-hidden'),join(project,name));};
delete process.env.WEBER_APP_TEST; delete process.env.LD_LIBRARY_PATH;
const stopped=async pid=>{try{return (await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1][0]==='Z';}catch{return true;}};
try {
  for(const name of ['node_modules','src','backend']){await rename(join(project,name),join(project,name+'.runtime-hidden'));hidden.push(name);}
  for(const[name,engine]of [['package-jit','aot'],['package-aot','aot'],['package-aot','web']]) {
    const app=await launch({binary:join(project,name,'weber'),application:join(project,name,'application'),engine,name:`bun-${name}-${engine}`});
    try {
      const event=await app.waitEvent(event=>event.data.stage==='backend-test','Bun backend through actual UI',30000);
      assert.equal(event.data.passed,true); assert.equal(event.data.info.bun,bunVersion);
      assert.equal(event.data.hermesInitialized,name==='package-aot'&&engine==='aot');
      assert.equal(event.data.capabilityRejected,true); assert.equal(event.data.backpressure,true);
      assert.equal((await app.waitExit()).code,0); await waitFor(()=>stopped(event.data.info.pid),'Backend process reaped');
      results.push({name,engine,passed:true,data:event.data,trace:app.path});
    }finally{await app.stop();}
  }
  for(const mode of ['healthy','hang']) {
    process.env.WEBER_BACKEND_TEST_MODE=mode;
    const marker=resolve(`artifacts/bun-${mode}-busy`); process.env.WEBER_BACKEND_BUSY_MARKER=marker;
    const app=await launch({binary:join(project,'package-jit/weber'),application:join(project,'package-jit/application'),name:`bun-lifetime-${mode}`});
    try{
      const event=await app.waitEvent(event=>event.data.stage===(mode==='hang'?'backend-hanging':'backend-test'),'Backend lifetime scenario');
      if(mode==='hang'){await waitFor(async()=>{try{await access(marker);return true;}catch{return false;}},'Bun executing synchronous infinite loop');app.child.kill('SIGKILL');}
      const exit=await app.waitExit(); if(mode==='healthy')assert.equal(exit.code,0);else assert.equal(exit.signal,'SIGKILL');
      await waitFor(()=>stopped(event.data.info.pid),'Owned Bun process terminated',10000);
      results.push({name:`lifetime-${mode}`,passed:true,pid:event.data.info.pid,forcedParentDeath:mode==='hang',trace:app.path});
    }finally{await app.stop();}
  }
  delete process.env.WEBER_BACKEND_BUSY_MARKER;
  const directory=await mkdtemp(join(tmpdir(),'weber-bun-negative-'));
  for(const change of ['hash','path','runtime','invalid-executable','escaping-symlink']) {
    const source=join(project,'package-jit/application'), destination=join(directory,change);
    await cp(source,destination,{recursive:true});
    const manifest=JSON.parse(await readFile(join(destination,'app.json')));
    if(change==='hash')manifest.backend.sha256='0'.repeat(64);
    if(change==='path')manifest.backend.file='../backend';
    if(change==='runtime')manifest.backend.runtime='node';
    if(change==='invalid-executable'){await writeFile(join(destination,'backend'),'invalid backend executable');await chmod(join(destination,'backend'),0o755);manifest.backend.sha256=digest(await readFile(join(destination,'backend')));}
    if(change==='escaping-symlink'){const {rm}=await import('node:fs/promises');await rm(join(destination,'backend'));await symlink(join(source,'backend'),join(destination,'backend'));}
    await writeFile(join(destination,'app.json'),JSON.stringify(manifest));
    await assert.rejects(execute(binary,['--app',destination]),error=>error.code!==0&&/Backend executable hash mismatch|Invalid backend|Starting Bun backend|Backend executable escapes|Backend executable is not ELF/.test(error.stderr));
    negative.push({change,rejected:true});
  }
  // Run the same app through the actual npm/Vite native development path.
  await restore();
  process.env.WEBER_BACKEND_TEST_MODE='healthy';
  const telemetry=resolve('artifacts/bun-dev.jsonl'), logPath=resolve('artifacts/bun-dev.log');await writeFile(telemetry,'');
  const fd=openSync(logPath,'w');const child=spawn('npm',['run','dev'],{cwd:project,detached:true,env:{...process.env,WEBER_HOST:binary,WEBER_TELEMETRY:telemetry},stdio:['ignore',fd,fd]});closeSync(fd);
  let exit;const done=new Promise((finish,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{exit={code,signal};finish(exit);});});done.catch(()=>{});
  try{
    const event=await waitFor(async()=>{const events=await readEvents(telemetry);const failure=events.find(event=>event.data.stage==='failure');if(failure)throw new Error(JSON.stringify(failure));return events.find(event=>event.data.stage==='backend-test');},'Bun backend in native Vite dev window',30000);
    await waitFor(()=>exit,'Vite/host shutdown');assert.equal((await done).code,0);await waitFor(()=>stopped(event.data.info.pid),'Development Bun terminated');
    const output=await readFile(logPath,'utf8');const url=output.match(/Weber development \(SpiderMonkey\): (http:\/\/\S+)/)?.[1];assert.ok(url);await assert.rejects(fetch(url));
    results.push({name:'npm run dev with Bun and owned shutdown',passed:true,data:event.data,trace:telemetry});
  }finally{if(!exit){process.kill(-child.pid,'SIGTERM');await done;}}
  await writeFile('artifacts/bun-native-workflow.json',JSON.stringify({passed:true,build,bunVersion,display:process.env.WEBER_TEST_DISPLAY,results,negative,scope:'Actual Servo renderer on isolated Wayland; programmatic UI/backend calls. Not physical input, performance benchmarking or full Node.js compatibility.'},null,2));
  console.log(JSON.stringify({passed:true,results:results.map(({name,passed})=>({name,passed})),negative},null,2));
}finally{await restore();for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}delete process.env.WEBER_BACKEND_BUSY_MARKER;}

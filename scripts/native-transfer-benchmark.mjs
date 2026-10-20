// Run under the owned headless Wayland harness. Two hosts, identical installed app.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {launch,execute,delay,memory,distribution} from './native-desktop.mjs';
const inputs=process.argv.slice(2).map(path=>resolve(path));assert.equal(inputs.length,2,'Pass before and after bundle executables');
// Packaging/hashing can leave different file-cache folios resident. Copy both
// bundles through the same I/O path and discard only their unused cache pages.
// This never drops the system cache or modifies the supplied bundles.
const prepared=resolve('artifacts/native-transfer-hosts');
assert.ok(inputs.every(path=>!path.startsWith(prepared+'/')),'Inputs must be outside prepared copies');
await rm(prepared,{recursive:true,force:true});await mkdir(prepared,{recursive:true});
const binaries=[];
for(const [variant,input] of inputs.entries()){
  const output=join(prepared,String(variant));
  await execute('python3',['-c',`import os, pathlib, shutil, sys
shutil.copytree(sys.argv[1], sys.argv[2])
root = pathlib.Path(sys.argv[2])
for path in [root / sys.argv[3], *root.joinpath("lib").glob("*")]:
    if path.is_file():
        with path.open("rb") as f: os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
`,dirname(input),output,basename(input)]);
  binaries.push(join(output,basename(input)));
}
const fixture=JSON.parse(await readFile('artifacts/native-transfer-workflow.json','utf8'));
const hz=Number((await execute('getconf',['CLK_TCK'])).stdout.trim());assert.ok(hz>0);
const builds=await Promise.all(binaries.map(async binary=>({
  binary:resolve(binary),build:JSON.parse((await execute(binary,['--build-info'])).stdout),
  sha256:createHash('sha256').update(await readFile(binary)).digest('hex'),
})));
async function ticks(pid){const raw=await readFile(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);return Number(fields[11])+Number(fields[12]);}
// Warm each host once; compositor startup and initial disk faults are unscored.
for(const [variant,binary] of binaries.entries()){
  const app=await launch({binary,engine:'web',mode:'benchmark',config:{timeoutMs:1000},name:'native-transfer-warmup-'+variant});
  try{await app.waitEvent(e=>e.data.stage==='first-app-present','unscored warmup');assert.equal((await app.waitExit()).code,0);}finally{await app.stop();}
}
const runs=[];
for(const [index,variant] of [0,1,1,0,1,0,0,1].entries()){
  const root=resolve('artifacts/native-transfer-runs',String(index));await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const wrapper=root+'/weber';await writeFile(wrapper,'#!/bin/sh\nexec env -u MALLOC_ARENA_MAX -u GLIBC_TUNABLES '+
    ['XDG_DATA_HOME='+root+'/data','XDG_CONFIG_HOME='+root+'/config','XDG_CACHE_HOME='+root+'/cache',builds[variant].binary].map(quote).join(' ')+' "$@"\n',{mode:0o755});
  const app=await launch({binary:wrapper,application:fixture.application,engine:'web',name:'native-transfer-'+index});
  const samples=[];let done=false,error;
  try{
    await app.waitEvent(e=>e.data.stage==='first-app-present','document app presentation');
    const completion=app.waitEvent(e=>e.data.stage==='transfer-pass','document roundtrips',120000).then(()=>{done=true;},e=>{error=e;done=true;});
    while(!done){try{const total=await memory(app.child.pid);assert.equal(total.pids.length,1,'JIT-only process, no backend');const rollup=await readFile(`/proc/${app.child.pid}/smaps_rollup`,'utf8');const amount=name=>Number(rollup.match(new RegExp('^'+name+':\\s+(\\d+)','m'))?.[1]??0);samples.push({time:Date.now(),ticks:await ticks(app.child.pid),...total,anonKiB:amount('Pss_Anon'),fileKiB:amount('Pss_File')});}catch(e){if(app.child.exitCode===null)throw e;}await delay(50);}
    await completion;if(error)throw error;assert.equal((await app.waitExit()).code,0);
    const events=await app.events(),phases=events.filter(e=>e.data.stage==='transfer-phase').map(start=>{
      const end=events.find(e=>e.data.stage==='transfer-phase-end'&&e.data.phase===start.data.phase);assert.ok(end);
      const first=samples.find(p=>p.time>=start.unixTimeMs+300),last=samples.find(p=>p.time>=end.unixTimeMs);
      assert.ok(first&&last,'CPU snapshots bracket work, inside the one-second idle guards');
      const points=samples.filter(p=>p.time>=first.time&&p.time<=last.time);
      return {phase:start.data.phase,pairs:end.data.pairs,jsonBytes:end.data.jsonBytes,pairMs:distribution(end.data.times),cpuMs:(last.ticks-first.ticks)*1000/hz,peakPssMiB:Math.max(...points.map(p=>p.pssKiB))/1024,settledPssMiB:last.pssKiB/1024,peakAnonMiB:Math.max(...points.map(p=>p.anonKiB))/1024,peakFileMiB:Math.max(...points.map(p=>p.fileKiB))/1024};
    });
    const startup=events.find(e=>e.data.stage==='first-app-present');assert.ok(startup,'Actual first presentation');
    runs.push({index,variant,startupMs:startup.data.startupMs,phases,trace:app.path});console.log(JSON.stringify(runs.at(-1)));
  }finally{await app.stop();}
}
const summary=Object.fromEntries(['small','ascii','escaped'].map(phase=>[phase,builds.map((_,variant)=>{
  const cases=runs.filter(run=>run.variant===variant).map(run=>run.phases.find(p=>p.phase===phase));
  return {variant,cpuMs:distribution(cases.map(p=>p.cpuMs)),pairMedianMs:distribution(cases.map(p=>p.pairMs.p50)),peakPssMiB:distribution(cases.map(p=>p.peakPssMiB)),peakAnonMiB:distribution(cases.map(p=>p.peakAnonMiB)),peakFileMiB:distribution(cases.map(p=>p.peakFileMiB))};
})]));
const animated=[];
for(const [index,variant] of [0,1,1,0].entries()){
  const app=await launch({binary:builds[variant].binary,engine:'web',mode:'benchmark',config:{timeoutMs:8500},name:'native-transfer-animated-'+index});
  try{
    await app.waitEvent(e=>e.data.stage==='first-app-present','animated app presentation');await delay(1500);
    const start=await ticks(app.child.pid),began=performance.now();await delay(5000);
    const cpuMs=((await ticks(app.child.pid))-start)*1000/hz,wallMs=performance.now()-began;
    assert.equal((await app.waitExit(15000)).code,0);const events=await app.events();
    const frames=events.find(e=>e.data.stage==='presentation-summary');assert.ok(frames?.data.intervalsMs.length>100,'Continued native animation');
    animated.push({index,variant,cpuMs,wallMs,cpuPercent:cpuMs/wallMs*100,intervalMs:distribution(frames.data.intervalsMs),trace:app.path});console.log(JSON.stringify(animated.at(-1)));
  }finally{await app.stop();}
}
const startup=builds.map((_,variant)=>({variant,ms:distribution(runs.filter(run=>run.variant===variant).map(run=>run.startupMs))}));
const report={passed:true,display:process.env.WEBER_TEST_DISPLAY,clockTicksPerSecond:hz,cpuModel:cpus()[0]?.model,inputs,builds,fixture,sdkVersion:fixture.sdkVersion,runs,summary,startup,animated,
  method:'Fresh copies of both supplied bundles via identical shutil.copytree, followed by POSIX_FADV_DONTNEED on only those owned unused ELF/library copies, then identical hash/read and one unscored animated warmup per host. One shared isolated 960x720@60 Wayland compositor; before/after/after/before/after/before/before/after, four fresh processes per host; same installed app assets. Per phase one warmup then 32 sequential durable set/get pairs with equality checks. One-second idle guards bracket process user+system CPU snapshots; peak process-tree PSS sampled every 50ms. No allocator overrides. Separate embedded SolidJS animated workload: before/after/after/before, two five-second CPU windows per host after presentation plus 1.5 seconds settle, one logical core equals 100%; presentation intervals cover each whole run. Startup is first actual document-fixture presentation in the eight document runs. Warm local cache only; not native input, total GPU/compositor memory, cold-cache or general web workload scores.'};
await writeFile('artifacts/native-transfer-benchmark.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,summary}));

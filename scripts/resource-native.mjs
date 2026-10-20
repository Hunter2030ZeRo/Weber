// Diagnostic resource attribution, separate from ordinary lifecycle acceptance.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launch,execute,delay,memory,distribution} from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
const cycles=Number(process.argv.find(a=>a.startsWith('--cycles='))?.split('=')[1]??200);
const disabled=process.argv.includes('--disabled'),styles=process.argv.includes('--styles'),suffix=(styles?'-styles':'')+(disabled?'-disabled':'');
const binary=resolve(process.env.WEBER_RESOURCE_HOST??'target/optimized/release/weber-servo');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout);
const fixture=JSON.parse(await readFile(`artifacts/lifecycle-resource-${cycles}${styles?'-styles':''}-workflow.json`,'utf8'));
assert.equal(build.aotAvailable,false);assert.equal(fixture.cycles,cycles);
if(disabled)delete process.env.WEBER_MEMORY_PROFILE;else process.env.WEBER_MEMORY_PROFILE='1';
const app=await launch({binary,application:fixture.application,engine:'web',name:`resource-${cycles}${suffix}`});
const samples=[];let done=false,error,final;
try{
  const completion=app.waitEvent(e=>e.data.stage==='lifecycle-pass','resource lifetimes',Math.max(240000,cycles*400)).then(e=>{final=e.data;done=true;},e=>{error=e;done=true;});
  while(!done){try{const stat=await readFile(`/proc/${app.child.pid}/stat`,'utf8'),f=stat.slice(stat.lastIndexOf(')')+2).split(' '),rollup=await readFile(`/proc/${app.child.pid}/smaps_rollup`,'utf8');const amount=name=>Number(rollup.match(new RegExp('^'+name+':\\s+(\\d+)','m'))?.[1]??0);samples.push({time:Date.now(),...await memory(app.child.pid),anonKiB:amount('Pss_Anon'),fileKiB:amount('Pss_File'),fds:(await readdir(`/proc/${app.child.pid}/fd`)).length,threads:(await readdir(`/proc/${app.child.pid}/task`)).length,cpuTicks:Number(f[11])+Number(f[12])});}catch(e){if(app.child.exitCode===null)throw e;}await delay(200);}
  await completion;if(error)throw error;assert.equal((await app.waitExit()).code,0);
  const events=await app.events();assert.equal(events.filter(e=>e.data.stage==='window-opened').length,cycles+1);assert.equal(events.filter(e=>e.data.stage==='window-closed').length,cycles+1);
  const profiles=events.filter(e=>e.data.stage==='memory-report');assert.ok(!events.some(e=>e.data.stage==='memory-report-error'));
  const phases=events.filter(e=>e.data.stage==='lifecycle-phase').map(begin=>{
    const end=events.find(e=>e.data.stage==='lifecycle-phase-end'&&e.data.phase===begin.data.phase);assert.ok(end);
    const points=samples.filter(p=>p.time>=begin.unixTimeMs+1800&&p.time<end.unixTimeMs);assert.ok(points.length>=3);
    const profile=profiles.find(e=>e.data.label===begin.data.phase);
    if(!disabled)assert.ok(profile,'Engine report: '+begin.data.phase);
    const raw=profile?.data.report.results.flatMap(p=>p.reports)??[];
    const total=test=>raw.filter(test).reduce((sum,r)=>sum+r.size,0);
    return {phase:begin.data.phase,cycles:begin.data.cycles,pssMiB:distribution(points.map(p=>p.pssKiB/1024)),anonMiB:distribution(points.map(p=>p.anonKiB/1024)),fileMiB:distribution(points.map(p=>p.fileKiB/1024)),fds:distribution(points.map(p=>p.fds)),threads:distribution(points.map(p=>p.threads)),idleTicks:points.at(-1).cpuTicks-points[0].cpuTicks,
      engine:profile?{reportMs:profile.data.durationMs,reportCount:raw.length,systemHeapAllocated:total(r=>r.path.join('/')==='system-heap-allocated'),systemFontBytes:total(r=>r.path.join('/')==='system-fonts'),systemHeapReserved:total(r=>r.path.join('/')==='system-heap-reserved'),jsGcUsed:total(r=>r.path.slice(-2).join('/')==='gc-heap/used'),jsGcUnused:total(r=>r.path.slice(-2).join('/')==='gc-heap/unused'),jsGcDecommitted:total(r=>r.path.slice(-2).join('/')==='gc-heap/decommitted'),jsMalloc:total(r=>r.path[1]==='js'&&r.path.at(-1)==='malloc-heap'),zombieDomBytes:total(r=>r.path.some(p=>p.includes('-zombie-'))),webRenderBytes:total(r=>r.path[0]==='webrender')}:null};
  });
  if(disabled)assert.equal(profiles.length,0,'No memory reporting without explicit opt-in');else assert.equal(profiles.length,phases.length);
  assert.ok(phases.at(-1).fds.p50<=phases[0].fds.p50+4);assert.ok(phases.at(-1).threads.p50<=phases[0].threads.p50+4);
  let memoryGuard=null;
  if(!disabled&&cycles>=1000){
    const warm=phases.find(p=>p.cycles===200),last=phases.at(-1);assert.ok(warm?.engine&&last.engine);
    assert.ok(warm.engine.systemHeapAllocated>1048576,'Available default-allocator counters');
    memoryGuard={warmCycles:200,finalCycles:cycles,additionalNativeHeapBytes:last.engine.systemHeapAllocated-warm.engine.systemHeapAllocated,limitBytes:8388608,additionalSystemFontBytes:last.engine.systemFontBytes-warm.engine.systemFontBytes,systemFontLimitBytes:262144};
    assert.ok(warm.engine.systemFontBytes>0,'Available system-font service counter');
    assert.ok(memoryGuard.additionalSystemFontBytes<=memoryGuard.systemFontLimitBytes,'Closed painters must not accumulate more than 256 KiB of font caches after warmup');
    assert.ok(memoryGuard.additionalNativeHeapBytes<=memoryGuard.limitBytes,'Warmed native heap must not grow by more than 8 MiB from cycle 200 to 1000');
  }
  const report={passed:true,memoryGuard,build,sdkVersion:fixture.sdkVersion,cycles,disabled,styles,display:process.env.WEBER_TEST_DISPLAY,phases,cycleMs:distribution(final.times),samples,trace:app.path,
    scope:'Installed SDK lifecycle workload and existing asynchronous Servo memory reports. No forced GC or allocator policy changes. Sampled process-tree PSS/anonymous/file categories are not a sum of engine allocation counters; GC decommitted is virtual capacity, not resident RAM. Engine/system counters may overlap. Diagnostic reports perturb allocation/timing and do not establish default-path performance or all-day endurance.'};
  await writeFile(`artifacts/resource-${cycles}${suffix}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,phases,cycleMs:report.cycleMs}));
}finally{await app.stop();}

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launch, execute, delay, memory, distribution } from './native-desktop.mjs';
const {project}=JSON.parse(await readFile('artifacts/platform-workflow.json'));
const results=[];
const controlsOnly=process.env.WEBER_CONTROLS_ONLY==='1';
const variant=process.env.WEBER_PLATFORM_VARIANT??'';assert.match(variant,/^[a-z0-9-]*$/);
const prefix=variant?variant+'-':'';
for(const [name,engine] of [['jit','web'],['aot','aot']]) {
 const binary=resolve('target/package/weber-platform-'+name+'/weber');
 const build=JSON.parse((await execute(binary,['--build-info'])).stdout);
 assert.equal(build.windowProtocol,2);assert.equal(build.aotAvailable,name==='aot');
 const controls=await launch({binary,application:join(project,'controls-'+name),engine,name:prefix+'platform-controls-'+name});
 let controlResult;
 try {
  controlResult=(await controls.waitEvent(event=>event.data.stage==='platform-pass','actual window controls and snapshots',45000)).data;
  assert.equal(controlResult.passed,true);assert.equal((await controls.waitExit()).code,0);
  assert.ok(controlResult.snapshots>5);assert.equal(controlResult.hermesInitialized,name==='aot');
 }finally{await controls.stop();}
 if(controlsOnly){results.push({name,build,controls:controlResult});continue;}
 const app=await launch({binary,application:join(project,'resources-'+name),engine,name:prefix+'platform-resources-'+name});
 const samples=[];let final;
 try {
  let done=false,error;
  const completion=app.waitEvent(event=>event.data.stage==='resource-pass','resource lifecycle',150000).then(event=>{final=event.data;done=true;},failure=>{error=failure;done=true;});
  while(!done){samples.push({time:Date.now(),...await memory(app.child.pid)});await delay(150);}
  await completion;if(error)throw error;assert.equal((await app.waitExit()).code,0);
  const events=await app.events(), phases=events.filter(event=>event.data.stage==='resource-phase');
  assert.deepEqual(phases.map(event=>event.data.phase),['small','large','four-windows','closed-three','cycle-5','cycle-10','cycle-15','small-again']);
  const summaries=phases.map((event,index)=>{
   const end=phases[index+1]?.unixTimeMs??events.find(event=>event.data.stage==='resource-pass').unixTimeMs;
   // Omit the first second after a phase change; sample the settled part only.
   // Child creation between phases belongs to a transition, so cap the phase at 3.2 seconds.
   const points=samples.filter(sample=>sample.time>=event.unixTimeMs+1000&&sample.time<Math.min(end,event.unixTimeMs+3200));
   assert.ok(points.length>=8,event.data.phase+' settled samples');assert.ok(points.every(sample=>sample.pssKiB>0));
   return {phase:event.data.phase,elements:event.data.elements,viewport:event.data.viewport,pssKiB:distribution(points.map(sample=>sample.pssKiB)),rssKiB:distribution(points.map(sample=>sample.rssKiB)),privateKiB:distribution(points.map(sample=>sample.privateKiB))};
  });
  const reclaims=events.filter(event=>event.data.stage==='memory-reclaim').map(event=>event.data);
  if(process.env.WEBER_RECLAIM!=='0')assert.ok(reclaims.some(event=>event.released),'free allocator pages reclaimed');
  else assert.equal(reclaims.length,0);
  assert.equal(final.windowCreateMs.length,18);
  results.push({name,build,executableSha256:createHash('sha256').update(await readFile(binary)).digest('hex'),controls:controlResult,controlTrace:controls.path,resources:{phases:summaries,samples,trace:app.path,final,reclaims,windowCreateMs:distribution(final.windowCreateMs)}});
 }finally{await app.stop();}
}
assert.equal(results[0].build.sourceHash,results[1].build.sourceHash);
await writeFile(controlsOnly?`artifacts/${prefix}platform-controls.json`:`artifacts/${prefix}platform-native.json`,JSON.stringify({passed:true,display:process.env.WEBER_TEST_DISPLAY,controlsOnly,reclaimEnabled:process.env.WEBER_RECLAIM!=='0',method:controlsOnly?'Actual Wayland controls only; no resource measurements.':'Actual isolated Wayland windows, programmatic SDK/DOM tests. Process-tree PSS/RSS samples at 150ms; medians are correlated observations of one run per engine. Excludes compositor/system/GPU allocations. Includes an animated Solid UI, 80/1000 rows and 15 sequential window lifecycles; no Bun. WindowCreate timing ends at SDK creation resolution, not paint. Not a cross-framework comparison or physical-input result.',results},null,2));
console.log(JSON.stringify({passed:true,results:results.map(({name,controls,resources})=>({name,snapshots:controls.snapshots,phases:resources?.phases}))},null,2));

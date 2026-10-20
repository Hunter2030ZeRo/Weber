import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launch,execute,delay,memory,distribution} from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
const cycles=Number(process.argv.find(arg=>arg.startsWith('--cycles='))?.split('=')[1]??50);assert.ok(Number.isInteger(cycles)&&cycles>=50&&cycles<=1000);
const suffix=cycles===50?'':'-'+cycles;
const binary=resolve('target/package/weber-clipboard-jit/weber');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout),fixture=JSON.parse(await readFile(`artifacts/lifecycle${suffix}-workflow.json`,'utf8'));
assert.equal(fixture.cycles,cycles);assert.equal(build.aotAvailable,false);assert.equal(build.fileDialogParentProtocol,1);
assert.equal(build.clipboardMaxTextBytes,262144);assert.equal(build.storageMaxValueBytes,1048576);
await writeFile(`artifacts/lifecycle${suffix}-native.json`,JSON.stringify({passed:false,build}));
async function sample(pid){
 const stat=await readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 return {time:Date.now(),...await memory(pid),fds:(await readdir(`/proc/${pid}/fd`)).length,threads:(await readdir(`/proc/${pid}/task`)).length,cpuTicks:Number(fields[11])+Number(fields[12])};
}
const app=await launch({binary,application:fixture.application,engine:'web',name:'lifecycle'+suffix+'-native'});
let final,restored;const samples=[];
try{
 await app.waitEvent(e=>e.data.stage==='window-opened','initial lifecycle window');
 assert.ok((await app.events()).some(e=>e.data.stage==='portal-parent'&&e.data.available),'Initial native parent export');
 let done=false,error;const completion=app.waitEvent(e=>e.data.stage==='lifecycle-pass',cycles+' native window cycles',Math.max(240000,cycles*500)).then(e=>{final=e.data;done=true;},e=>{error=e;done=true;});
 while(!done){if(app.child.exitCode!==null)break;try{samples.push(await sample(app.child.pid));}catch(error){if(app.child.exitCode===null)throw error;}await delay(200);}
 await completion;if(error)throw error;assert.equal((await app.waitExit()).code,0);
 const events=await app.events();assert.equal(events.filter(e=>e.data.stage==='window-opened').length,cycles+1);assert.equal(events.filter(e=>e.data.stage==='window-closed').length,cycles+1);
 assert.equal(events.filter(e=>e.data.stage==='lifecycle-child').length,cycles);
 const parents=events.filter(e=>e.data.stage==='portal-parent');assert.equal(parents.length,cycles+1);assert.ok(parents.every(e=>e.data.available),'All native windows export valid portal parents');
 const phases=events.filter(e=>e.data.stage==='lifecycle-phase').map(e=>{
  const end=events.find(f=>f.data.stage==='lifecycle-phase-end'&&f.data.phase===e.data.phase)?.unixTimeMs;
  assert.ok(end,'Explicit end of settled sample interval');
  const points=samples.filter(p=>p.time>=e.unixTimeMs+800&&p.time<Math.min(end,e.unixTimeMs+4800));assert.ok(points.length>=4,e.data.phase);
  return {...e.data,pssKiB:distribution(points.map(p=>p.pssKiB)),fds:distribution(points.map(p=>p.fds)),threads:distribution(points.map(p=>p.threads)),idle: ['baseline','settled'].includes(e.data.phase)?{seconds:(points.at(-1).time-points[0].time)/1000,cpuTicks:points.at(-1).cpuTicks-points[0].cpuTicks}:undefined};
 });
 const before=phases[0],after=phases.at(-1);assert.ok(after.fds.p50<=before.fds.p50+4,'File descriptors stay bounded');assert.ok(after.threads.p50<=before.threads.p50+4,'Threads stay bounded');
 const restart=await launch({binary,application:fixture.application,engine:'web',name:'lifecycle'+suffix+'-restored'});
 try{restored=(await restart.waitEvent(e=>e.data.stage==='lifecycle-restored','large document restored')).data;assert.equal((await restart.waitExit()).code,0);}finally{await restart.stop();}
 const result={passed:true,build,sdkVersion:fixture.sdkVersion,installedSdk:true,display:process.env.WEBER_TEST_DISPLAY,final,restored,phases,parentExportMs:distribution(parents.map(e=>e.data.elapsedMs)),cycleMs:distribution(final.times),samples,trace:app.path,scope:'JIT-only installed SDK; 1 MiB encoded JSON and Unicode persistence, native/SDK rejection, '+cycles+' real native window create/dispose cycles, '+(cycles*31)+' abandoned owned storage results, cross-window result isolation, '+(cycles+1)+' xdg-foreign exports, fd/thread and process-tree PSS/CPU samples, clean last-window shutdown and restart. Programmatic app actions; not physical IME, GPU recovery, all-day endurance or cross-framework performance proof.'};
 await writeFile(`artifacts/lifecycle${suffix}-native.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,cycles,phases,cycleMs:result.cycleMs}));
}finally{await app.stop();}

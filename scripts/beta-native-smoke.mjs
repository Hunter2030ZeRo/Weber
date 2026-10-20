import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, execute, waitFor } from './native-desktop.mjs';
const {project}=JSON.parse(await readFile('artifacts/beta-workflow.json'));
const results=[];
for(const [name,engine] of [['jit','web'],['aot','aot']]) {
  const binary=resolve(name==='jit'?'target/package/weber-beta-jit/weber':'target/package/weber-beta-aot/weber');
  const build=JSON.parse((await execute(binary,['--build-info'])).stdout);
  assert.equal(build.aotAvailable,name==='aot');
  const app=await launch({binary,application:join(project,'dist-'+name),engine,name:'beta-'+name});
  try {
    const final=await app.waitEvent(event=>event.data.stage==='beta-window'&&event.data.id===2,'child continues after parent closes',30000);
    const exit=await app.waitExit();assert.equal(exit.code,0);
    const events=await app.events(),windows=events.filter(event=>event.data.stage==='beta-window');
    assert.equal(windows.length,3);assert.ok(windows.every(event=>event.data.passed&&event.data.capabilityRejected));
    assert.ok(windows.every(event=>event.data.hermesInitialized===(name==='aot')));
    assert.equal(final.data.parentClosed,true);assert.equal(final.data.backendDisconnect,true);
    const closed=events.filter(event=>event.data.stage==='window-closed').map(event=>event.data.id);assert.deepEqual(closed,[1,3,2]);
    await waitFor(async()=>{try{return (await readFile('/proc/'+final.data.info.pid+'/stat','utf8')).split(') ')[1][0]==='Z';}catch{return true;}},'Bun reaped after last window');
    results.push({name,passed:true,build,windows:windows.map(event=>event.data),closed,trace:app.path});
  }finally{await app.stop();}
}
await writeFile('artifacts/beta-native.json',JSON.stringify({passed:true,display:process.env.WEBER_TEST_DISPLAY,results,scope:'Actual native multi-window renderer and Bun event delivery; programmatic UI; not physical input or a performance result.'},null,2));
console.log(JSON.stringify({passed:true,results:results.map(({name,passed})=>({name,passed}))}));

import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {launch,execute,delay,memory} from './native-desktop.mjs';
const binary=resolve('target/package/weber-foundation-jit/weber');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout);assert.equal(build.aotAvailable,false);assert.equal(build.storageProtocol,1);
const workflow=JSON.parse(await readFile('artifacts/foundation-workflow.json','utf8'));
const results=[];
for(const [application,first,second] of [[workflow.contracts,'storage-pass','storage-restored'],[join(resolve('artifacts/foundation/notes'),'dist-native'),'notes-pass','notes-restored']]){
 for(const stage of [first,second]){
  const app=await launch({binary,application,engine:'web',name:'foundation-'+stage});
  try{
   const event=(await app.waitEvent(e=>e.data.stage===stage,stage,40000)).data;
   assert.equal(event.passed,true);assert.equal(event.hermesInitialized,false);
   assert.equal((await app.waitExit()).code,0);results.push({stage,result:event,trace:app.path});
  }finally{await app.stop();}
 }
}
const [a,b,c,d]=results;assert.deepEqual(a.result.paths,b.result.paths);assert.deepEqual(c.result.paths,d.result.paths);assert.notEqual(a.result.paths.data,c.result.paths.data);
for(const item of [a,c]){
 const path=join(item.result.paths.data,'store.json');const info=await stat(path);assert.ok(info.size>0);assert.equal(info.mode&0o777,0o600);
}
// Existing embedded controls exercise mount/unmount, Unicode signals, scrolling and keyed lists.
const smoke=await launch({binary,engine:'web',mode:'smoke',name:'foundation-desktop-smoke'});
try{await smoke.waitEvent(e=>e.data.stage==='smoke','desktop regression',30000);assert.equal((await smoke.waitExit()).code,0);}finally{await smoke.stop();}
await writeFile('artifacts/foundation-native.json',JSON.stringify({passed:true,build,executableSha256:createHash('sha256').update(await readFile(binary)).digest('hex'),display:process.env.WEBER_TEST_DISPLAY,scope:'Actual isolated Wayland windows and programmatic DOM input. Two launches per persisted app, cross-app paths, cross-window ownership and shared data, bounded queues and malformed input, file permissions, desktop regression. No physical keyboard/IME or Windows/macOS validation.',results,desktopTrace:smoke.path},null,2));
console.log('Foundation native gates passed');

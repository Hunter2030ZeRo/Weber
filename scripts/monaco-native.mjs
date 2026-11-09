import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {NativeKeys,launch,execute,waitFor} from './native-desktop.mjs';
import {privateHangul} from './private-hangul.mjs';
import {withTarget,viteConfig} from '../sdk/project.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const selected=process.argv.find(arg=>arg.startsWith('--mode='))?.slice(7);
assert.ok(!selected||['http','vite-dev','packaged'].includes(selected));
assert.ok(process.argv.slice(2).every(arg=>arg===`--mode=${selected}`));
const modes=selected?[selected]:['http','vite-dev','packaged'];
const fixture=JSON.parse(await readFile('artifacts/monaco/workflow.json'));
const bytes=await readFile('compatibility/monaco/profile.json'),profile=JSON.parse(bytes);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(fixture.profileSha256,digest(bytes));
for(const [file,hash] of Object.entries(profile.sources))assert.equal(digest(await readFile(join('compatibility/monaco',file))),hash,file);
const binary=resolve(process.env.WEBER_HOST||'target/optimized/release/weber-servo');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout);
assert.equal(build.uiEngine,'spidermonkey');assert.equal(build.aotAvailable,false);
const manifest=JSON.parse(await readFile(join(fixture.application,'app.json')));
const css=Object.entries(manifest.assets).filter(([,asset])=>asset.mime.startsWith('text/css')).map(([route])=>`<link rel="stylesheet" href="${route}">`).join('');
const html=`<!doctype html><meta charset="utf-8">${css}<div id="aot-dom-root"></div><script src="/web.js"></script><script>WeberUserApp.mount(document.getElementById('aot-dom-root'));</script>`;
const server=createServer(async(request,response)=>{
 try{
  const route=new URL(request.url,'http://localhost').pathname;
  if(route==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);return;}
  const asset=manifest.assets[route];if(!asset){response.writeHead(404).end();return;}
  const bytes=await readFile(join(fixture.application,asset.file));assert.equal(digest(bytes),asset.sha256);
  response.writeHead(200,{'Content-Type':asset.mime}).end(bytes);
 }catch{response.writeHead(500).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const runs=[],output='artifacts/monaco/native.json';let keys,hangul,development;
await writeFile(output,JSON.stringify({passed:false,build,runs}));
try{
 const loaded=await withTarget(resolve('compatibility/monaco'),'web',()=>viteConfig(resolve('compatibility/monaco'),'serve'));
 development=await loaded.vite.createServer(loaded.vite.mergeConfig(loaded.config,{server:{host:'127.0.0.1',port:0,open:false},clearScreen:false,logLevel:'warn'}));
 await development.listen();
 const devUrl=`http://127.0.0.1:${development.httpServer.address().port}/`;
 hangul=await privateHangul();
 keys=await NativeKeys.open();
 for(const mode of modes){
  let app;
  try{
   app=await launch({binary,engine:'web',name:`monaco-${mode}`,capture:true,...(mode==='packaged'?{application:fixture.application}:{url:mode==='vite-dev'?devUrl:`http://127.0.0.1:${server.address().port}/`})});keys.app=app;
   const result=await waitFor(async()=>{
    const events=await app.events(), fatal=events.find(e=>['monaco-fatal','monaco-error','monaco-worker-error','failure'].includes(e.data.stage));
    if(fatal)throw new Error(JSON.stringify(fatal.data));
    if(app.child.exitCode!==null)throw new Error(`Native app exited: ${app.child.exitCode}`);
    return events.find(e=>e.data.stage==='monaco-auto-result')?.data;
   },'actual Monaco results',90000);
   assert.deepEqual(result.results.map(x=>x.id),profile.required);
   await app.waitEvent(e=>e.data.stage==='first-app-present','native Monaco presentation');
   await keys.activate();await hangul.latin();
   async function state(predicate){return waitFor(async()=>{const value=(await app.events()).filter(e=>e.data.stage==='monaco-input-state').at(-1)?.data;return value&&predicate(value)?value:null;},'native Monaco model state');}
   await keys.key(64);for(const code of [30,48,46])await keys.key(code);
   const typed=await state(s=>s.value==='abc');assert.equal(typed.value,'abc');
   await keys.key(44,[29]);const undone=await state(s=>s.value!=='abc');assert.notEqual(undone.value,'abc');
   await keys.key(44,[29,42]);const redone=await state(s=>s.value==='abc');assert.equal(redone.value,'abc');
   await keys.key(64);await hangul.activate();
   for(const code of [34,37,31,19,50,33,57])await keys.key(code);
   const korean=await state(s=>s.value==='한글 '&&s.composition.some(event=>event.trusted&&event.data));assert.equal(korean.value,'한글 ');assert.ok(korean.composition.some(event=>event.type==='compositionend'&&event.trusted&&event.data));
   let composing=false;
   for(const event of korean.composition){
    if(event.type==='compositionstart')composing=true;
    if(event.type==='input')assert.ok(composing,'Composition input arrived after compositionend');
    if(event.type==='compositionend')composing=false;
   }
   assert.equal(composing,false);
   await keys.key(30,[29]);for(const code of [19,37,57])await keys.key(code);
   const replaced=await state(s=>s.value==='가 ');assert.equal(replaced.value,'가 ');
   await keys.key(64);for(const code of [34,37,31,14,14,14])await keys.key(code);
   const deleted=await state(s=>s.value==='');assert.equal(deleted.value,'');
   assert.equal((await app.events()).filter(e=>['monaco-error','monaco-worker-error','monaco-fatal'].includes(e.data.stage)).length,0);
   await keys.key(88);assert.equal((await app.waitExit()).code,0);
   const passed=result.results.every(x=>x.status==='pass');runs.push({mode,...result,passed,nativeInput:{ascii:true,undoRedo:true,hangul:true,selectionReplacement:true,jamoDeletion:true,composition:korean.composition},trace:app.path});
   console.log(`${mode}: ${result.results.filter(x=>x.status==='pass').length}/${profile.required.length} actual Monaco API checks; OS typing/undo/redo and actual Hangul passed`);
  }catch(error){runs.push({mode,passed:false,error:String(error),trace:app?.path,events:app?(await app.events()).map(e=>e.data).filter(e=>e.stage?.startsWith('monaco')||e.stage==='large-app-case'):[]});console.log(mode+': '+String(error));}
  finally{if(app)await app.stop();}
 }
 const passed=runs.length===modes.length&&runs.every(r=>r.passed);
 await writeFile(output,JSON.stringify({passed,build,modes,profile:profile.id,profileSha256:fixture.profileSha256,version:fixture.version,display:process.env.WEBER_TEST_DISPLAY,runs,scope:'Actual pinned Monaco with real editor/TS worker bundles, native Servo windows, identical HTTP control and relocated packaged bytes, plus the live Vite development server through checkout SDK bindings. Selected API actions plus OS ASCII typing/undo/redo and actual Fcitx5 Hangul composition, selection replacement and jamo deletion. Physical keyboard, wheel input, development hot reload, complete editor semantics and performance remain separate gates.'},null,2));
 assert.equal(passed,true,`Actual Monaco gate failed: ${output}`);
}finally{if(keys)await keys.close();if(hangul)await hangul.stop();if(development)await development.close();await new Promise(done=>server.close(done));}

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {readFile,writeFile,stat,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {launch,NativeKeys,waitFor,delay,execute} from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
const binary=resolve('target/package/weber-clipboard-jit/weber');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout);
for(const name of ['fileDialogProtocol','safeCutProtocol','closeRequestProtocol'])assert.equal(build[name],1,name);
const fixture=JSON.parse(await readFile('artifacts/preview-workflow.json','utf8'));
const resultPath='artifacts/preview-native.json';
await writeFile(resultPath,JSON.stringify({passed:false,build,scope:'Native preview test started'},null,2));
let app,keys;const traces=[];
const portalLog=openSync('artifacts/preview-portal.log','w');
const monitor=spawn('dbus-monitor',['--session',"interface='org.freedesktop.portal.Request'","interface='org.freedesktop.impl.portal.Request'","type='method_call',interface='org.freedesktop.portal.FileChooser'"],{stdio:['ignore',portalLog,portalLog]});closeSync(portalLog);
const monitored=new Promise(resolve=>{monitor.once('error',resolve);monitor.once('exit',resolve);});
const focused=async()=> (await app.events()).filter(e=>e.data.stage==='window-focus').at(-1)?.data.focused;
async function rawKey(code,modifiers=[]){for(const m of modifiers){await keys.command({keycode:m,pressed:true});await delay(30);}await keys.command({keycode:code,pressed:true});await delay(30);await keys.command({keycode:code,pressed:false});for(const m of modifiers.reverse())await keys.command({keycode:m,pressed:false});await delay(70);}
async function focusApp(){
  if(!await focused()){
    await rawKey(1);await delay(300);if(!await focused())await rawKey(15,[56]);
  }
  await waitFor(focused,'owned Weber window focus');
}
async function state(predicate,message){return waitFor(async()=>{const all=await app.events();const error=all.find(e=>e.data.stage==='failure');if(error)throw new Error(JSON.stringify(error));const value=all.filter(e=>e.data.stage==='preview-state').at(-1)?.data;return value&&predicate(value)?value:null;},message);}
async function phase(n){await keys.key(64);await app.waitEvent(e=>e.data.stage==='preview-begin'&&e.data.phase===n,`begin ${n}`);}
async function done(n){await app.waitEvent(e=>e.data.stage==='preview-done'&&e.data.phase===n,`done ${n}`,20000);}
async function portal(){
  // This isolated display contains only our app and the chooser it requested.
  // Raw OS input is allowed only after that owned request has taken focus.
  await waitFor(async()=>await focused()===false,'owned portal chooser focus',10000);await delay(400);
}
async function choose(path){
  assert.ok(path.startsWith(dirname(fixture.input)+'/'),'Only owned fixture files');
  await portal();await rawKey(38,[29]);await rawKey(30,[29]); // Ctrl+L, then replace the full location/name including its extension.
  for(const char of path){await keys.command({keysym:char.codePointAt(0),pressed:true});await keys.command({keysym:char.codePointAt(0),pressed:false});}
  await rawKey(28);await delay(500);
  // Save choosers may need an accept/overwrite confirmation after location entry.
  if(await focused()===false){await rawKey(28);await delay(400);}
  if(await focused()===false){await rawKey(19,[56]);await delay(300);} // Explicit GTK Replace accelerator when overwrite confirmation is still open.
}
try{
  keys=await NativeKeys.open();
  app=await launch({binary,application:fixture.application,engine:'web',name:'preview-native'});traces.push(app.path);keys.app=app;
  await app.waitEvent(e=>e.data.stage==='window-opened','preview window');await delay(400);await focusApp();
  assert.ok((await app.events()).some(e=>e.data.stage==='portal-parent'&&e.data.available),'Actual native parent export');
  await state(s=>s.status==='Loaded','Notes initial load');
  await phase(0);await choose(fixture.input);await state(s=>s.status==='File opened','Notes file open');await done(0);
  await phase(1);await choose(fixture.output);await state(s=>s.status==='File saved','Notes file save');await done(1);
  assert.equal(await readFile(fixture.output,'utf8'),'Saved 한글 😀\nNew line');
  await phase(2);await done(2);await keys.key(62,[56]); // Alt+F4 is an actual native close request.
  await state(s=>s.dialog,'unsaved native-close prompt');await keys.key(28);await state(s=>!s.dialog&&s.dirty==='Unsaved changes','keep editing');
  await phase(3);await portal();await rawKey(46,[56]);await done(3);await waitFor(focused,'focus restored after chooser cancellation'); // Explicit GTK Cancel accelerator.
  await phase(4);await choose(fixture.invalid);await done(4);await waitFor(focused,'focus restored after invalid file');
  await phase(5);await choose(fixture.output);await done(5);assert.equal(await readFile(fixture.output,'utf8'),'\u0001'.repeat(262144));await waitFor(focused,'focus after overwrite');
  await phase(6);await choose(fixture.oversized);await done(6);await waitFor(focused,'focus after oversized file');
  await phase(7);await done(7);await waitFor(focused,'chooser closed after AbortSignal');
  await phase(8);await done(8);await state(s=>s.error?.includes('Preview synchronous application failure'),'script error display');
  await phase(9);await done(9);await state(s=>s.error?.includes('Preview rejected promise <img src=x>'),'promise error display');
  await phase(10);await done(10);await keys.key(62,[56]);await state(s=>s.dialog,'final unsaved close prompt');await keys.key(15);await keys.key(28);
  const exit=await app.waitExit();assert.equal(exit.code,0,JSON.stringify(exit));
  app=await launch({binary,application:fixture.closingApplication,engine:'web',name:'preview-pending-close'});traces.push(app.path);keys.app=app;
  await app.waitEvent(e=>e.data.stage==='window-opened','pending-close window');await delay(200);if(!(await app.events()).some(e=>e.data.stage==='closing-file-started')&&!await focused())await focusApp();
  await app.waitEvent(e=>e.data.stage==='closing-file-started','pending file request accepted');await portal();const closing=await app.waitExit(10000);assert.equal(closing.code,0,JSON.stringify(closing));
  await rm('artifacts/preview-error-capture.png',{force:true});
  app=await launch({binary,application:fixture.errorApplication,engine:'web',name:'preview-error-capture',capture:true});traces.push(app.path);keys.app=app;
  await app.waitEvent(e=>e.data.stage==='preview-error-capture'&&e.data.visible,'startup error visible');const captured=await app.waitExit();assert.equal(captured.code,0,JSON.stringify(captured));
  assert.ok((await stat('artifacts/preview-error-capture.png')).size>1000,'real Servo screenshot of startup diagnostic');
  const parentArguments=(await readFile('artifacts/preview-portal.log','utf8')).match(/string "wayland:[^"]+"/g)??[];
  assert.ok(parentArguments.length>=8,'All chooser calls carry actual exported Wayland parent identifiers');
  await writeFile(resultPath,JSON.stringify({passed:true,build,sdkVersion:fixture.sdkVersion,installedSdk:fixture.installed,display:process.env.WEBER_TEST_DISPLAY,portalBackend:process.env.WEBER_TEST_FILE_CHOOSER??'desktop default',traces,parentArguments,scope:'Actual desktop FileChooser portal and virtual keyboard in isolated Wayland: Notes open/save, explicit GTK Cancel, invalid UTF-8, 256KiB escaped overwrite, oversized external input, SDK validation, AbortSignal, native Alt+F4 keep/discard, visible JS/promise/startup errors, final close and pending chooser cleanup. App button/input setup is programmatic. No physical input/IME, Windows/macOS, AOT, clean OS or performance claim.'},null,2));
  console.log('Linux preview native acceptance cases passed');
}catch(error){
  try{await execute('gdbus',['call','--timeout','5','--session','--dest','org.gnome.Shell.Screenshot','--object-path','/org/gnome/Shell/Screenshot','--method','org.gnome.Shell.Screenshot.Screenshot','false','false',resolve('artifacts/preview-failure.png')]);}catch{}
  throw error;
}finally{if(keys)await keys.close();if(app)await app.stop();if(monitor.exitCode===null)monitor.kill();await monitored;}

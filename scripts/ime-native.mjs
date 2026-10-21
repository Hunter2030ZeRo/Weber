// Actual Fcitx5 Hangul -> GNOME IBus bridge -> text-input-v3 -> Weber/Servo.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {NativeKeys,launch,execute,waitFor,delay} from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const fixture=JSON.parse(await readFile('artifacts/ime-workflow.json','utf8'));
const binary=resolve(process.argv[2]??'target/package/weber-ime/weber');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout),results=[];
await writeFile('artifacts/ime-native.json',JSON.stringify({passed:false,build}));
const dir=join(process.env.XDG_CONFIG_HOME,'fcitx5');await mkdir(dir,{recursive:true});
await writeFile(join(dir,'profile'),'[Groups/0]\nName=Default\nDefault Layout=kr-kr104\nDefaultIM=hangul\n[Groups/0/Items/0]\nName=keyboard-kr-kr104\n[Groups/0/Items/1]\nName=hangul\n[GroupOrder]\n0=Default\n');
await writeFile(join(dir,'config'),'[Hotkey/TriggerKeys]\n0=Hangul\n');
await execute('gsettings',['set','org.gnome.desktop.input-sources','sources',"[('xkb', 'kr+kr104')]"]);
const fd=openSync('artifacts/ime-fcitx.log','w');const fcitx=spawn('fcitx5',['--disable=xcb,classicui,notifications'],{stdio:['ignore',fd,fd]});closeSync(fd);
let keys,app,monitor;const traces=[];
if(process.env.WEBER_IME_WAYLAND_TRACE==='1'){const log=openSync('artifacts/ime-dbus.log','w');monitor=spawn('dbus-monitor',['--session'],{stdio:['ignore',log,log]});closeSync(log);}
const events=async()=>await app.events();
const state=async(id)=> {const all=await events();id??=all.filter(e=>e.data.stage==='window-focus'&&e.data.focused).at(-1)?.data.windowId??1;return all.filter(e=>e.data.windowId===id&&['ime-event','ime-reset','ime-seed','ime-ready'].includes(e.data.stage)).at(-1)?.data;};
const value=async id=>(await state())?.fields[id]?.value;
async function check(id,expected){await waitFor(async()=>await value(id)===expected,JSON.stringify({id,expected}));await delay(80);assert.equal(await value(id),expected);}
async function raw(code){await keys.command({keycode:code,pressed:true});await keys.command({keycode:code,pressed:false});}
async function type(codes){for(const code of codes)await keys.key(code);}
async function reset(){await keys.key(57);await keys.key(64);await waitFor(async()=>{const s=await state();return s?.active==='first'&&['first','second','multi','secret'].every(id=>s.fields[id].value==='');},'fixture reset');}
async function contextInfo(){return(await execute('gdbus',['call','--session','--dest','org.fcitx.Fcitx5','--object-path','/controller','--method','org.fcitx.Fcitx.Controller1.DebugInfo'])).stdout;}
async function hangul(){
 await waitFor(async()=>/program:window:\d+ frontend:ibus cap:\S+ focus:1/.test(await contextInfo()),'actual focused Wayland IBus context');
 await execute('fcitx5-remote',['-s','hangul']);await execute('fcitx5-remote',['-o']);
 await waitFor(async()=>(await execute('fcitx5-remote',['-n'])).stdout.trim()==='hangul'&&(await execute('fcitx5-remote',[])).stdout.trim()==='2','focused Hangul engine active');
}
async function scenario(name,work){const before=(await events()).length;await work();const after=(await events()).slice(before).map(e=>e.data);results.push({name,passed:true,events:after.length,compositionEvents:after.filter(e=>e.type?.startsWith('composition')).map(e=>({type:e.type,target:e.target,data:e.data,trusted:e.trusted})),state:await state()});console.log(name+': passed');}
try{
 await waitFor(async()=>{try{return(await execute('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.NameHasOwner','org.fcitx.Fcitx5'])).stdout.includes('true');}catch{return false;}},'private Fcitx5');
 await waitFor(async()=>(await contextInfo()).includes('program:gnome-shell frontend:ibus'),'GNOME attaches to the private IBus frontend');
 keys=await NativeKeys.open();
 if(process.env.WEBER_IME_WAYLAND_TRACE==='1')process.env.WAYLAND_DEBUG='client';
 app=await launch({binary,application:fixture.application,engine:'web',name:'ime-native',capture:true});keys.app=app;traces.push(app.path);delete process.env.WAYLAND_DEBUG;
 await app.waitEvent(e=>e.data.stage==='ime-ready','IME fixture ready');await keys.activate();await hangul();
 await scenario('Hangul syllable preedit and commit',async()=>{await type([19,37,31,37,18,37,57]);await check('first','가나다 ');const all=await events();for(const type of ['compositionstart','compositionupdate','compositionend'])assert.ok(all.some(e=>e.data.type===type&&e.data.trusted));});
 await scenario('Backspace decomposes and deletes final jamo',async()=>{await reset();await hangul();await type([34,37,31]);await check('first','한');await keys.key(14);await check('first','하');await keys.key(14);await check('first','ㅎ');await keys.key(14);await check('first','');const before=(await events()).length;await keys.key(105);const next=(await events()).slice(before).find(e=>e.data.type==='keydown');assert.equal(next?.data.composing,false);});
 await scenario('10 immediate Hangul key toggle roundtrips',async()=>{await reset();await execute('fcitx5-remote',['-c']);for(let i=0;i<10;i++){await reset();await raw(122);await raw(19);await raw(37);await raw(57);await check('first','가 ');await raw(122);await raw(45);await check('first','가 x');}});
 await scenario('kr104 right Alt switches before the first character',async()=>{await reset();await execute('fcitx5-remote',['-c']);await raw(100);await raw(19);await raw(37);await raw(57);await check('first','가 ');await raw(100);await raw(45);await check('first','가 x');await keys.command({keycode:100,pressed:true});await delay(400);await keys.command({keycode:100,pressed:false});await type([19,37,57]);await check('first','가 x가 ');});
 await scenario('Unicode UTF16 selection and middle insertion',async()=>{await reset();await hangul();await keys.key(61);await type([19,37,57]);await check('first','🙂가 x');assert.equal((await state()).fields.first.start,4);});
 await scenario('Replace selected text with composition',async()=>{await reset();await execute('fcitx5-remote',['-c']);await type([30,48,46]);await check('first','abc');await keys.key(30,[29]);await hangul();await type([34,37,31,19,50,33,57]);await check('first','한글 ');});
 await scenario('Textarea newlines and final-jamo deletion',async()=>{await reset();await keys.key(66);await hangul();await type([34,37,31,57,28,19,50,33,57]);await check('multi','한 \n글 ');await type([19,14]);await check('multi','한 \n글 ');assert.equal((await state()).mirror,'한 \n글 ');});
 await scenario('Tab commits to the original field without stealing focus',async()=>{await reset();await hangul();await type([19,37]);await check('first','가');await keys.key(15);await waitFor(async()=>(await state())?.active==='second','second field keeps DOM focus');await type([31,37,57]);await check('first','가');await check('second','나 ');});
 await scenario('Programmatic focus during composition',async()=>{await reset();await hangul();await type([19,37]);await keys.key(65);await waitFor(async()=>(await state())?.active==='second','programmatic focus remains');await type([18,37,57]);await check('first','가');await check('second','다 ');});
 await scenario('Native window focus handoff and return',async()=>{await reset();await hangul();await type([19,37]);await keys.key(60);await app.waitEvent(e=>e.data.stage==='ime-ready'&&e.data.id===2,'second window ready');await waitFor(async()=>{const f=(await events()).filter(e=>e.data.stage==='window-focus').at(-1)?.data;return f?.windowId===2&&f.focused;},'child native focus');await hangul();await type([31,37]);await check('first','나');await keys.key(1,[56]);await waitFor(async()=>{const f=(await events()).filter(e=>e.data.stage==='window-focus').at(-1)?.data;return f?.windowId===1&&f.focused;},'compositor switches to original');assert.equal((await state(2)).fields.first.value,'나');await check('first','가');await hangul();await type([18,37,57]);await check('first','가다 ');await keys.key(1,[56]);await waitFor(async()=>{const f=(await events()).filter(e=>e.data.stage==='window-focus').at(-1)?.data;return f?.windowId===2&&f.focused;},'compositor returns to child');await hangul();await type([19,37,57]);await check('first','나가 ');await keys.key(68);await app.waitEvent(e=>e.data.stage==='window-closed'&&e.data.id===2,'child closes');await waitFor(async()=>{const f=(await events()).filter(e=>e.data.stage==='window-focus').at(-1)?.data;return f?.windowId===1&&f.focused;},'original native focus');await check('first','가다 ');});
 await scenario('Readonly input and textarea remain immutable',async()=>{await reset();await keys.key(66);await keys.key(15);await keys.key(15);await waitFor(async()=>(await state())?.active==='locked','readonly input focus');await type([19,37,57]);await check('locked','Read only');await keys.key(15);await waitFor(async()=>(await state())?.active==='lockedmulti','readonly textarea focus');await type([19,37,57]);await check('lockedmulti','Read only');});
 await scenario('Password focus remains stable across IME context changes',async()=>{await reset();await keys.key(66);await keys.key(15);await waitFor(async()=>(await state())?.active==='secret','password focus');await execute('fcitx5-remote',['-c']);await type([30,48,46]);await check('secret','abc');await keys.key(15);await waitFor(async()=>(await state())?.active==='locked','readonly focus after password');});

 await reset();await hangul();await type([34,37,31,19,50,33,57]);await keys.key(88);assert.equal((await app.waitExit()).code,0);
 app=await launch({binary,application:fixture.workbenchApplication,engine:'web',name:'ime-workbench',capture:true});keys.app=app;traces.push(app.path);
 await app.waitEvent(e=>e.data.stage==='ime-workbench-ready','actual Workbench loaded');await keys.activate();await hangul();
 const workbenchState=async()=>(await app.events()).filter(e=>e.data.stage==='ime-workbench-state').at(-1)?.data;
 await type([34,37,31,19,50,33,57]);await waitFor(async()=>(await workbenchState())?.value==='한글 ','Solid-controlled textarea receives real Hangul');
 await keys.key(14);await waitFor(async()=>(await workbenchState())?.value==='한글','Workbench removes committed space');await keys.key(31,[29]);
 await waitFor(async()=>(await workbenchState())?.status==='Saved','normal Workbench Ctrl+S');await keys.key(62,[56]);assert.equal((await app.waitExit()).code,0);
 app=await launch({binary,application:fixture.workbenchApplication,engine:'web',name:'ime-workbench-restored'});keys.app=app;traces.push(app.path);
 const restored=(await app.waitEvent(e=>e.data.stage==='ime-workbench-ready','Workbench restart loads saved Hangul')).data;assert.equal(restored.value,'한글');await keys.activate();await keys.key(62,[56]);assert.equal((await app.waitExit()).code,0);
 results.push({name:'Real Solid Workbench Hangul typing, Ctrl+S and restart',passed:true,value:restored.value});
 await writeFile('artifacts/ime-native.json',JSON.stringify({passed:true,build,sdkVersion:fixture.sdkVersion,installedSdk:fixture.installed,display:process.env.WEBER_TEST_DISPLAY,results,traces,
 scope:'Actual Fcitx5 Hangul engine via private GNOME IBus/text-input-v3 and OS keycodes. No synthetic composition/input events. Physical human keyboard, other compositors, Hanja popup positioning/reconversion and contenteditable are separate verification.'},null,2));
 console.log('Korean IME native acceptance passed');
}catch(error){await writeFile('artifacts/ime-native.json',JSON.stringify({passed:false,build,results,error:String(error),state:app?await state():null,traces},null,2));throw error;}
finally{if(monitor)monitor.kill();if(keys)await keys.close();if(app)await app.stop();if(fcitx.exitCode===null)fcitx.kill();}

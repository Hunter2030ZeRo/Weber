// Actual Fcitx5 Hangul -> GNOME IBus bridge -> text-input-v3 -> Weber/Servo.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {NativeKeys,launch,execute,waitFor,delay} from './native-desktop.mjs';
const hyprland=process.env.WEBER_TEST_DISPLAY?.startsWith('isolated Hyprland');
assert.ok(hyprland||process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const fixture=JSON.parse(await readFile('artifacts/ime-workflow.json','utf8'));
const binary=resolve(process.argv[2]??'target/package/weber-ime/weber');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout),results=[];
await writeFile('artifacts/ime-reconversion-native.json',JSON.stringify({passed:false,build}));
const dir=join(process.env.XDG_CONFIG_HOME,'fcitx5');await mkdir(dir,{recursive:true});
await writeFile(join(dir,'profile'),'[Groups/0]\nName=Default\nDefault Layout=kr-kr104\nDefaultIM=hangul\n[Groups/0/Items/0]\nName=keyboard-kr-kr104\n[Groups/0/Items/1]\nName=hangul\n[GroupOrder]\n0=Default\n');
await writeFile(join(dir,'config'),'[Hotkey/TriggerKeys]\n0=Hangul\n');
if(!hyprland)await execute('gsettings',['set','org.gnome.desktop.input-sources','sources',"[('xkb', 'kr+kr104')]"]);
const fd=openSync('artifacts/ime-fcitx.log','w');const fcitx=spawn('fcitx5',['--disable=xcb,notifications'+(hyprland?',ibusfrontend':',classicui')],{env:{...process.env,WAYLAND_DEBUG:'client'},stdio:['ignore',fd,fd]});closeSync(fd);
let keys,app,monitor,hyprlandRoot;const traces=[];
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
 await waitFor(async()=>(hyprland?/frontend:wayland[^ ]* cap:\S+ focus:1/:/program:window:\d+ frontend:ibus cap:\S+ focus:1/).test(await contextInfo()),'actual focused Wayland IBus context');
 await execute('fcitx5-remote',['-s','hangul']);await execute('fcitx5-remote',['-o']);
 await waitFor(async()=>(await execute('fcitx5-remote',['-n'])).stdout.trim()==='hangul'&&(await execute('fcitx5-remote',[])).stdout.trim()==='2','focused Hangul engine active');
}
async function switchWindow(id){
 if(!hyprland){await keys.key(1,[56]);return;}
 const clients=JSON.parse((await execute(process.env.WEBER_TEST_HYPRCTL,['-j','clients'])).stdout);
 const own=clients.filter(client=>Number(client.pid)===app.child.pid).filter(client=>(client.address===hyprlandRoot)===(id===1));
 assert.equal(own.length,1);assert.match(own[0].address,/^0x[0-9a-f]+$/i);
 await execute(process.env.WEBER_TEST_HYPRCTL,['dispatch',`hl.dsp.focus({window='address:${own[0].address}'})`]);
}
async function scenario(name,work){const before=(await events()).length;await work();const after=(await events()).slice(before).map(e=>e.data);results.push({name,passed:true,events:after.length,compositionEvents:after.filter(e=>e.type?.startsWith('composition')).map(e=>({type:e.type,target:e.target,data:e.data,trusted:e.trusted})),state:await state()});console.log(name+': passed');}
try{
 await waitFor(async()=>{try{return(await execute('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.NameHasOwner','org.fcitx.Fcitx5'])).stdout.includes('true');}catch{return false;}},'private Fcitx5');
 if(!hyprland)await waitFor(async()=>(await contextInfo()).includes('program:gnome-shell frontend:ibus'),'GNOME attaches to the private IBus frontend');
 keys=await NativeKeys.open();
 if(process.env.WEBER_IME_WAYLAND_TRACE==='1')process.env.WAYLAND_DEBUG='client';
 app=await launch({binary,application:fixture.application,engine:'web',name:'ime-reconversion-native',capture:true});keys.app=app;traces.push(app.path);delete process.env.WAYLAND_DEBUG;
 await app.waitEvent(e=>e.data.stage==='ime-ready','IME fixture ready');await keys.activate();if(hyprland){const own=JSON.parse((await execute(process.env.WEBER_TEST_HYPRCTL,['-j','clients'])).stdout).filter(c=>Number(c.pid)===app.child.pid);assert.equal(own.length,1);hyprlandRoot=own[0].address;}await hangul();

 await scenario('Committed Hangul Hanja reconversion replaces original text',async()=>{await reset();await hangul();await type([34,37,31,57,14]);await check('first','한');await keys.key(123);await delay(500);await keys.key(2);await check('first','韓');});
 const popupRects=(await readFile('artifacts/ime-fcitx.log','utf8')).split('\n').filter(line=>line.includes('text_input_rectangle'));
 assert.ok(!hyprland||popupRects.length>0,'Fcitx receives actual candidate popup anchor');
 await writeFile('artifacts/ime-reconversion-native.json',JSON.stringify({passed:true,build,results,popupRects,display:process.env.WEBER_TEST_DISPLAY,traces},null,2));
}catch(error){await writeFile('artifacts/ime-reconversion-native.json',JSON.stringify({passed:false,build,results,error:String(error),state:app?await state():null,traces},null,2));throw error;}
finally{if(monitor)monitor.kill();if(keys)await keys.close();if(app)await app.stop();if(fcitx.exitCode===null)fcitx.kill();}

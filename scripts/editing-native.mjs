// Actual Fcitx5 Hangul -> GNOME IBus bridge -> text-input-v3 -> Weber/Servo.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {NativeKeys,launch,execute,waitFor,delay,memory} from './native-desktop.mjs';
const hyprland=process.env.WEBER_TEST_DISPLAY?.startsWith('isolated Hyprland');
assert.ok(hyprland||process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const fixture=JSON.parse(await readFile('artifacts/editing-workflow.json','utf8'));
const binary=resolve(process.argv[2]??'target/package/weber-ime/weber');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout),results=[];
await writeFile('artifacts/editing-native.json',JSON.stringify({passed:false,build}));
const dir=join(process.env.XDG_CONFIG_HOME,'fcitx5');await mkdir(dir,{recursive:true});
await writeFile(join(dir,'profile'),'[Groups/0]\nName=Default\nDefault Layout=kr-kr104\nDefaultIM=hangul\n[Groups/0/Items/0]\nName=keyboard-kr-kr104\n[Groups/0/Items/1]\nName=hangul\n[GroupOrder]\n0=Default\n');
await writeFile(join(dir,'config'),'[Hotkey/TriggerKeys]\n0=Hangul\n');
if(!hyprland)await execute('gsettings',['set','org.gnome.desktop.input-sources','sources',"[('xkb', 'kr+kr104')]"]);
const fd=openSync('artifacts/ime-fcitx.log','w');const fcitx=spawn('fcitx5',['--disable=xcb,classicui,notifications'+(hyprland?',ibusfrontend':'')],{stdio:['ignore',fd,fd]});closeSync(fd);
let keys,app,monitor,hyprlandRoot;const traces=[];
if(process.env.WEBER_IME_WAYLAND_TRACE==='1'){const log=openSync('artifacts/ime-dbus.log','w');monitor=spawn('dbus-monitor',['--session'],{stdio:['ignore',log,log]});closeSync(log);}
const events=async()=>await app.events();
const state=async()=>(await events()).filter(e=>e.data.stage?.startsWith('editing-')).at(-1)?.data;
async function check(expected){await waitFor(async()=>(await state())?.text===expected,JSON.stringify({expected,current:await state()}));}
async function type(codes){for(const code of codes)await keys.key(code);}
async function reset(){await keys.key(64);await waitFor(async()=>(await state())?.text==='', 'editable reset');await execute('fcitx5-remote',['-c']);}
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
async function scenario(name,work){const before=(await events()).length;await work();const after=(await events()).slice(before).map(e=>e.data);results.push({name,passed:true,events:after.length,state:await state()});console.log(name+': passed');}
try{
 await waitFor(async()=>{try{return(await execute('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.NameHasOwner','org.fcitx.Fcitx5'])).stdout.includes('true');}catch{return false;}},'private Fcitx5');
 if(!hyprland)await waitFor(async()=>(await contextInfo()).includes('program:gnome-shell frontend:ibus'),'GNOME attaches to the private IBus frontend');
 keys=await NativeKeys.open();
 if(process.env.WEBER_IME_WAYLAND_TRACE==='1')process.env.WAYLAND_DEBUG='client';
 app=await launch({binary,application:fixture.application,engine:'web',name:'editing-native',capture:true});keys.app=app;traces.push(app.path);delete process.env.WAYLAND_DEBUG;
 await app.waitEvent(e=>e.data.stage==='editing-ready','IME fixture ready');await keys.activate();if(hyprland){const own=JSON.parse((await execute(process.env.WEBER_TEST_HYPRCTL,['-j','clients'])).stdout).filter(c=>Number(c.pid)===app.child.pid);assert.equal(own.length,1);hyprlandRoot=own[0].address;}await hangul();

 await scenario('Latin insertion and caret movement',async()=>{await reset();await type([30,48,46]);await check('abc');await keys.key(105);await keys.key(45);await check('abxc');});
 await scenario('Grapheme selection preserves emoji and combining marks',async()=>{await keys.key(61);await waitFor(async()=>(await state())?.text==='A🙂e\u0301한B','Unicode seed');await keys.key(105,[42]);assert.equal((await state()).selection,'B');await keys.key(105,[42]);assert.equal((await state()).selection,'한B');await keys.key(105,[42]);assert.equal((await state()).selection,'e\u0301한B');await keys.key(105,[42]);assert.equal((await state()).selection,'🙂e\u0301한B');await keys.key(45);await check('Ax');assert.equal((await state()).nodeCount,0);});
 await scenario('Backspace and Delete use complete graphemes',async()=>{await keys.key(61);await keys.key(14);await check('A🙂e\u0301한');await keys.key(14);await check('A🙂e\u0301');await keys.key(14);await check('A🙂');await keys.key(14);await check('A');await keys.key(14);await check('');await keys.key(61);await keys.key(66);await keys.key(111);await check('🙂e\u0301한B');await keys.key(111);await check('e\u0301한B');});
 await scenario('Select all is scoped to focused editing host',async()=>{await reset();await type([30,48,46]);await keys.key(30,[29]);assert.equal((await state()).selection,'abc');await keys.key(45);await check('x');assert.equal((await state()).other,'Other');});
 await scenario('Native copy cut paste and cancelled beforeinput',async()=>{await reset();await type([30,48,46]);await keys.key(30,[29]);await keys.key(46,[29]);await keys.key(45,[29]);await check('');await keys.key(47,[29]);await check('abc');await keys.key(67);await keys.key(47,[29]);await check('abc');});
 await scenario('Undo redo preserves original DOM node and listeners',async()=>{await keys.key(62);await waitFor(async()=>(await state())?.text==='seed','rich seed');await keys.key(45);await check('seedx');await keys.key(44,[29]);await check('seed');assert.equal((await state()).seedSame,true);await keys.key(87);assert.equal((await state()).listenerCount,1);await keys.key(44,[29,42]);await check('seedx');await keys.key(44,[29]);await check('seed');await keys.key(21);await check('seedy');await keys.key(44,[29,42]);await check('seedy');});
 await scenario('Undo beforeinput can be cancelled',async()=>{await reset();await keys.key(45);await check('x');await keys.key(68);await keys.key(44,[29]);await check('x');});
 await scenario('Cancelled text insertion and external DOM history invalidation',async()=>{await reset();await keys.key(45);await check('x');await keys.key(59);await keys.key(30);await check('x');await keys.key(63);await check('external');await keys.key(44,[29]);await check('external');});
 await scenario('Native multiline and deletion',async()=>{await reset();await type([30,28,48]);await waitFor(async()=>(await state())?.text?.includes('a')&&(await state())?.text?.includes('b'),'multiline');await keys.key(14);await waitFor(async()=>!(await state())?.text?.includes('b'),'backspace');});
 await scenario('Hangul composition and whole-composition undo',async()=>{await reset();await hangul();await type([34,37,31,57]);await check('한 ');await keys.key(14);await check('한');await keys.key(44,[29]);await check('한 ');await keys.key(44,[29]);await check('한');await keys.key(44,[29]);await check('');});
 await scenario('Hangul last-jamo deletion',async()=>{await reset();await hangul();await type([19,37]);await check('가');await keys.key(14);await check('ㄱ');await keys.key(14);await check('');assert.ok((await state()).nodeCount<=1);});
 if(hyprland)await scenario('Committed Hangul reconversion in native editable DOM',async()=>{await reset();await hangul();await type([34,37,31,57,14]);await check('한');await keys.key(123);await delay(500);await keys.key(2);await check('韓');});
 await scenario('Composition replacement preserves external live Range and UTF-16 boundaries',async()=>{await keys.key(61,[42]);await waitFor(async()=>(await state())?.selection==='한','selected same-node Hangul');await hangul();await type([19,37]);await check('A🙂가B');assert.equal((await state()).watchedText,'A🙂가B');assert.equal((await state()).seedSame,true);await keys.key(57);await check('A🙂가 B');assert.equal((await state()).watchedText,'A🙂가 B');await keys.key(44,[29]);await check('A🙂가B');await keys.key(44,[29]);await check('A🙂한B');assert.equal((await state()).seedSame,true);});
 await scenario('Composition replaces cross-node selection and preserves rich node identity',async()=>{await keys.key(62,[42]);await waitFor(async()=>(await state())?.selection==='한글','selected cross-node Hangul');await hangul();await type([19,37,57]);await check('A🙂가 B');assert.equal((await state()).watchedText,'A🙂가 B');assert.equal((await state()).seedSame,true);assert.equal((await state()).nodeCount,2);await keys.key(44,[29]);await check('A🙂가B');await keys.key(44,[29]);await check('A🙂한글B');assert.equal((await state()).html,'<span>A🙂한</span><em>글B</em>');assert.equal((await state()).seedSame,true);});
 await scenario('Composition in an empty element inserts text without placeholder elements',async()=>{await keys.key(66,[42]);await waitFor(async()=>(await state())?.html==='','empty editing host');await hangul();await type([19,37,57]);await check('가 ');assert.equal((await state()).html,'가 ');await keys.key(44,[29]);await check('가');await keys.key(44,[29]);await check('');assert.equal((await state()).html,'');});
 let resources;
 if(process.env.WEBER_EDITING_STRESS==='1'){
  const ticks=async()=>{const sample=await memory(app.child.pid);let total=0;for(const pid of sample.pids){const data=await readFile(`/proc/${pid}/stat`,'utf8').catch(()=>null);if(data){const fields=data.slice(data.lastIndexOf(')')+2).trim().split(/\s+/);total+=Number(fields[11])+Number(fields[12]);}}return total;};
  const hz=Number((await execute('getconf',['CLK_TCK'])).stdout);
  const idle=async()=>{const start=performance.now(),cpu=await ticks();await delay(10000);return {durationMs:performance.now()-start,cpuPercent:(await ticks()-cpu)/hz/((performance.now()-start)/1000)*100,memory:await memory(app.child.pid)};};
  await reset();await hangul();resources={before:await idle(),blocks:[]};console.log('Editing endurance baseline collected');
  for(let block=0;block<2;block++){const start=performance.now(),cpu=await ticks();for(let i=0;i<100;i++){await type([19,37,57,14,14]);if(i%25===24)console.log(`Hangul endurance ${block*100+i+1}/200`);}await check('');resources.blocks.push({cycles:100,wallMs:performance.now()-start,cpuPercent:(await ticks()-cpu)/hz/((performance.now()-start)/1000)*100,idle:await idle()});}
  assert.ok((await state()).nodeCount<=1,'No DOM-node accumulation after 200 compositions');
 }
 const caretUpdates=(await events()).filter(e=>e.data.stage==='ime-caret-rect');assert.ok(caretUpdates.length>5,'actual painted contenteditable caret moves');
 await keys.key(88);assert.equal((await app.waitExit()).code,0);
 await writeFile('artifacts/editing-native.json',JSON.stringify({passed:true,build,display:process.env.WEBER_TEST_DISPLAY,results,traces,resources,scope:'Standard contenteditable. Actual OS keycodes and Fcitx5 composition; no JavaScript editor or synthetic input events.'},null,2));
 console.log('Native editable DOM acceptance passed');
}catch(error){await writeFile('artifacts/editing-native.json',JSON.stringify({passed:false,build,results,error:String(error),state:app?await state():null,traces},null,2));throw error;}
finally{if(monitor)monitor.kill();if(keys)await keys.close();if(app)await app.stop();if(fcitx.exitCode===null)fcitx.kill();}

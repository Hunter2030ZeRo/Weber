import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, execute, NativeKeys, waitFor, delay, memory, distribution } from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
const fixture=JSON.parse(await readFile('artifacts/alpha-workflow.json','utf8'));
const binary=resolve('target/package/weber-clipboard-jit/weber');
const build=JSON.parse((await execute(binary,['--build-info'])).stdout);assert.equal(build.appIntegrationProtocol,1);
await writeFile('artifacts/alpha-native.json',JSON.stringify({passed:false,build}));
const applications=join(process.env.XDG_DATA_HOME,'applications');await mkdir(applications,{recursive:true});
await cp(join(fixture.package,'dev.weber.workbench.desktop'),join(applications,'dev.weber.workbench.desktop'));
const urlLog=resolve('artifacts/alpha-url.jsonl');await writeFile(urlLog,'');
await writeFile(join(applications,'weber-alpha-url.desktop'),`[Desktop Entry]\nType=Application\nName=Weber owned URL test handler\nExec=/usr/bin/python3 "${resolve('scripts/alpha-url-handler.py')}" "${urlLog}" %u\nMimeType=x-scheme-handler/http;\nNoDisplay=true\nTerminal=false\n`);
await mkdir(process.env.XDG_CONFIG_HOME,{recursive:true});await writeFile(join(process.env.XDG_CONFIG_HOME,'mimeapps.list'),'[Default Applications]\nx-scheme-handler/http=weber-alpha-url.desktop;\n');
await execute('update-desktop-database',[applications]);
const log=openSync('artifacts/alpha-dbus.log','w');
const monitor=spawn('dbus-monitor',['--session',"interface='org.freedesktop.Notifications'","interface='org.freedesktop.portal.OpenURI'","interface='org.freedesktop.portal.Request'"],{stdio:['ignore',log,log]});closeSync(log);
const monitored=new Promise(done=>{monitor.once('error',done);monitor.once('exit',done);});
let app,keys,pipewire;const traces=[];
const focused=async id=>(await app.events()).filter(event=>event.data.stage==='window-focus'&&event.data.windowId===id).at(-1)?.data.focused;
async function rawKey(code,modifiers=[]){for(const keycode of modifiers)await keys.command({keycode,pressed:true});try{await keys.command({keycode:code,pressed:true});await delay(40);await keys.command({keycode:code,pressed:false});}finally{for(const keycode of modifiers.reverse())await keys.command({keycode,pressed:false});}await delay(100);}
async function focusRoot(){
 if(await focused(1))return;
 for(let i=0;i<3&&!await focused(1);i++){await rawKey(1,[56]);await delay(200);}
 if(!await focused(1)){await rawKey(1);await rawKey(15,[56]);}
 await waitFor(()=>focused(1),'actual primary alpha window focus');
}
async function phase(number){await focusRoot();await keys.key(64);await app.waitEvent(e=>e.data.stage==='alpha-begin'&&e.data.phase===number,'alpha phase '+number);}
async function done(number){await app.waitEvent(e=>e.data.stage==='alpha-done'&&e.data.phase===number,'alpha done '+number,40000);}
async function pointer(gesture){await keys.command({point:[100,180]});await app.waitEvent(e=>e.data.stage==='alpha-pointer'&&e.data.gesture===gesture,'actual pointer motion in '+gesture+' target');await delay(200);}
try{
 const pipeLog=openSync('artifacts/alpha-pipewire.log','w');pipewire=spawn('pipewire',[],{stdio:['ignore',pipeLog,pipeLog]});closeSync(pipeLog);
 await waitFor(()=>stat(join(process.env.XDG_RUNTIME_DIR,'pipewire-0')).catch(()=>false),'private PipeWire socket');
 process.env.WEBER_TEST_ABSOLUTE_POINTER='1';
 keys=await NativeKeys.open();await keys.command({point:[120,200]});await delay(300);

 app=await launch({binary,application:fixture.application,engine:'web',name:'alpha-native',capture:true});keys.app=app;traces.push(app.path);
 await app.waitEvent(e=>e.data.stage==='alpha-ready','Workbench mounted');await keys.activate();await focusRoot();
 await phase(0);await done(0);await app.waitEvent(e=>e.data.stage==='alpha-child'&&e.data.passed,'foreign request and notification isolation');
 await phase(1);await done(1);
 await phase(2);
 // Some portal backends confirm first use. Only dismiss our owned request.
 for(let i=0;i<25;i++){if((await app.events()).some(e=>e.data.stage==='alpha-done'&&e.data.phase===2))break;if(!await focused(1)){await rawKey(28);break;}await delay(100);}
 await done(2);
 const handoff=await waitFor(async()=>{const lines=(await readFile(urlLog,'utf8')).trim().split('\n').filter(Boolean);return lines.length?JSON.parse(lines[0]):null;},'private desktop URI handler receives URL');
 assert.equal(new URL(handoff.url).pathname,'/weber-alpha-owned');assert.equal(new URL(handoff.url).searchParams.get('unicode'),'한글');
 await phase(3);await done(3);await focusRoot();
 // Real Wayland interactive resize, initiated by an OS left-button press.
 await keys.key(62);await app.waitEvent(e=>e.data.stage==='alpha-gesture-ready'&&e.data.gesture==='resize','resize armed');await pointer('resize');
 await keys.command({button:272,pressed:true});await app.waitEvent(e=>e.data.stage==='alpha-gesture'&&e.data.gesture==='resize'&&e.data.trusted,'trusted resize pointerdown');
 await delay(200);await keys.command({point:[180,220]});await delay(300);await keys.command({button:272,pressed:false});
 await app.waitEvent(e=>e.data.stage==='window-drag'&&e.data.accepted,'native resize request');
 // The inspector comes from actual native snapshots, not an assumed requested size.
 await app.waitEvent(e=>e.data.stage==='alpha-size'&&e.data.width>640&&e.data.height>480,'interactive resize changes actual DOM viewport');
 await keys.key(63);await app.waitEvent(e=>e.data.stage==='alpha-gesture-ready'&&e.data.gesture==='move','move armed');await pointer('move');
 await keys.command({button:272,pressed:true});await app.waitEvent(e=>e.data.stage==='alpha-gesture'&&e.data.gesture==='move'&&e.data.trusted,'trusted move pointerdown');await delay(150);await keys.command({point:[120,195]});await delay(150);await keys.command({button:272,pressed:false});
 await phase(4);await done(4);await waitFor(async()=>!await focused(1),'minimize loses native focus');await focusRoot();
 await phase(5);await done(5);await keys.key(31,[29]); // Real Ctrl+S uses Workbench's normal shortcut.
 await delay(300);await phase(6);await done(6);await app.waitEvent(e=>e.data.stage==='alpha-pass'&&e.data.passed,'alpha acceptance');assert.equal((await app.waitExit()).code,0);
 assert.ok((await stat('artifacts/alpha-native.png')).size>1000,'actual Servo screenshot');
 const events=await app.events();assert.equal(events.filter(e=>e.data.stage==='window-drag'&&e.data.accepted).length,2);
 app=await launch({binary,application:fixture.application,engine:'web',name:'alpha-restored'});keys.app=app;traces.push(app.path);
 await app.waitEvent(e=>e.data.stage==='alpha-restored'&&e.data.passed,'Workbench persisted document restored');assert.equal((await app.waitExit()).code,0);
 const hz=Number((await execute('getconf',['CLK_TCK'])).stdout.trim());
 const savedPath=process.env.PATH,savedDesktop=process.env.XDG_CURRENT_DESKTOP;
 process.env.PATH='/weber-no-node-or-bun';delete process.env.XDG_CURRENT_DESKTOP;
 let production;
 try {
  app=await launch({binary:join(fixture.package,'weber'),application:join(fixture.package,'application'),engine:'web',name:'alpha-production'});keys.app=app;traces.push(app.path);
  await app.waitEvent(e=>e.data.stage==='ready','normal packaged Workbench');await keys.activate();await focusRoot();await delay(1800);
  const ticks=async()=>{const value=await readFile(`/proc/${app.child.pid}/stat`,'utf8'),fields=value.slice(value.lastIndexOf(')')+2).trim().split(/\s+/);return Number(fields[11])+Number(fields[12]);};
  const start=await ticks(),began=performance.now(),samples=[];
  for(let i=0;i<25;i++){samples.push(await memory(app.child.pid));await delay(200);}
  const cpuMs=((await ticks())-start)*1000/hz,wallMs=performance.now()-began;
  production={withoutNodeOrBun:true,probeFree:true,pssMiB:distribution(samples.map(sample=>sample.pssKiB/1024)),cpuMs,wallMs,cpuPercent:cpuMs/wallMs*100};
  await keys.key(62,[56]);assert.equal((await app.waitExit()).code,0);
 } finally {process.env.PATH=savedPath;if(savedDesktop===undefined)delete process.env.XDG_CURRENT_DESKTOP;else process.env.XDG_CURRENT_DESKTOP=savedDesktop;}
 const dbus=await readFile('artifacts/alpha-dbus.log','utf8');
 const notifications=(dbus.match(/member=Notify\n/g)??[]).length,closed=(dbus.match(/member=CloseNotification\n/g)??[]).length;
 assert.ok(notifications>=10&&closed>=notifications,'explicit and owner-close notification dismissals');
 assert.ok(dbus.includes('&lt;b&gt;plain &amp; text&lt;/b&gt;'),'notification body uses plain text');assert.ok(dbus.includes('member=OpenURI'),'actual desktop portal used');assert.ok(dbus.includes('member=Close\n'),'cancelled URL request closes portal');
 await writeFile('artifacts/alpha-native.json',JSON.stringify({passed:true,build,sdkVersion:fixture.sdkVersion,installedSdk:fixture.installed,display:process.env.WEBER_TEST_DISPLAY,traces,production,notifications,closed,url:handoff.url,screenshot:resolve('artifacts/alpha-native.png'),
 scope:'Installed SDK Workbench in private GNOME Wayland: observed display metadata and explicit unsupported capabilities, decorations/resizable and create options, immutable coalesced snapshots, real OS drag/resize handoff and minimize/focus recovery, foreign request/notification rejection, bounded real desktop notifications and cleanup, real OpenURI handoff to a private handler without network navigation, active chooser abort with concurrent notification, actual Ctrl+S and document restart. File dialogs/clipboard covered by separate preview gates. Not physical Korean IME, optical latency, other compositors/OS, stable output IDs or all-day/crash recovery proof.'},null,2));
 console.log('Alpha application/window/system native gates passed');
}finally{if(keys)await keys.close();if(app)await app.stop();if(pipewire?.exitCode===null)pipewire.kill();if(monitor.exitCode===null)monitor.kill();await monitored;}

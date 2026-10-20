import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
if(process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'))throw new Error('Use a private dbus-run-session');
const temporary=await mkdtemp(join(tmpdir(),'weber-layer-'));
const runtime=join(temporary,'runtime');await mkdir(runtime,{mode:0o700});
const env={...process.env,XDG_RUNTIME_DIR:runtime,WAYLAND_DISPLAY:'weber-layer-test',XDG_CONFIG_HOME:join(temporary,'config'),XDG_CACHE_HOME:join(temporary,'cache'),XDG_DATA_HOME:join(temporary,'data'),XDG_STATE_HOME:join(temporary,'state'),XDG_SESSION_TYPE:'wayland',QT_QPA_PLATFORM:'offscreen',KWIN_COMPOSE:'O2',LIBGL_ALWAYS_SOFTWARE:'1'};
delete env.DISPLAY;delete env.WAYLAND_SOCKET;
const compositorLog=resolve('artifacts/layer-compositor.log'),fd=openSync(compositorLog,'w');
const compositor=spawn('kwin_wayland',['--virtual','--socket','weber-layer-test','--width','960','--height','720','--no-lockscreen'],{env,stdio:['ignore',fd,fd]});closeSync(fd);
const done=new Promise((finish,reject)=>{compositor.once('error',reject);compositor.once('exit',(code,signal)=>finish({code,signal}));});done.catch(()=>{});
let child;
try {
  let ready=false;for(let i=0;i<200;i++){if(compositor.exitCode!==null)throw new Error(await readFile(compositorLog,'utf8'));try{await access(join(runtime,env.WAYLAND_DISPLAY));ready=true;break;}catch{}await delay(50);}
  assert.ok(ready,'private KWin socket');await delay(800);
  const fixture=join(temporary,'panel.html');
  await writeFile(fixture,`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#243546;color:white;font:18px sans-serif}main{display:flex;align-items:center;gap:20px;height:48px;padding:0 16px}#meter{width:20px;height:12px;background:#7dd3a8}</style><main><b>Weber panel</b><button id="button">0</button><span id="meter"></span><span id="status">checking</span></main><script>
let count=0;document.querySelector('#button').addEventListener('click',()=>{count++;document.querySelector('#button').textContent=String(count);});
requestAnimationFrame(()=>{document.querySelector('#button').click();document.querySelector('#meter').style.width='42px';requestAnimationFrame(()=>{if(count===1&&getComputedStyle(document.querySelector('#meter')).width==='42px'&&innerHeight===48){document.querySelector('#status').textContent='DOM / CSS / rAF passed';document.title='weber-layer-pass';}else document.title='weber-layer-failed';});});
</script>`);
  const log=resolve('artifacts/layer-probe.log'),out=openSync(log,'w');
  const binary=resolve(process.argv[2]??'target/package/weber-beta-jit/weber');
  child=spawn(binary,['--layer-probe',pathToFileURL(fixture).href],{env:{...env,WEBER_LAYER_CAPTURE:resolve('artifacts/layer-probe.png')},stdio:['ignore',out,out]});closeSync(out);
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  const result=await new Promise((finish,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>finish({code,signal}));});clearTimeout(timer);
  const output=await readFile(log,'utf8');assert.equal(result.code,0,output);
  const events=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  assert.ok(events.some(event=>event.stage==='layer-configured'&&event.width===960&&event.height===48));
  assert.ok(events.some(event=>event.stage==='layer-frame'));
  assert.ok(events.some(event=>event.stage==='layer-passed'));
  await access('artifacts/layer-probe.png');
  await writeFile('artifacts/layer-shell.json',JSON.stringify({passed:true,binary,compositor:'isolated KWin virtual output, OpenGL; software EGL client',size:[960,48],exclusiveZone:48,events,capture:'artifacts/layer-probe.png',scope:'Actual Servo DOM/CSS/rAF and Wayland layer surface/configure/frame callback. Programmatic click; not Hyprland, keyboard/IME, output hotplug, AOT or full shell integration.'},null,2));
  console.log(JSON.stringify({passed:true,events}));
}finally{if(child?.exitCode===null)child.kill();if(compositor.exitCode===null)compositor.kill();const cleanup=setTimeout(()=>compositor.kill('SIGKILL'),3000);await done;clearTimeout(cleanup);await rm(temporary,{recursive:true,force:true});}

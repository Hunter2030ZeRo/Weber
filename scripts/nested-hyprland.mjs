// Run only under headless-wayland.mjs on its private D-Bus and display.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {writeFile,mkdtemp,rm,lstat,readdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execute,waitFor,delay} from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
assert.ok(process.env.XDG_RUNTIME_DIR?.startsWith('/tmp/weber-wayland-'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const root=resolve(process.env.WEBER_TEST_HYPRLAND_ROOT??'target/test-tools/hyprland');
const runtime=await mkdtemp('/tmp/wh-');
const config=join(process.env.XDG_CONFIG_HOME,'hyprland-test.lua');
await writeFile(config,`hl.monitor({output="",mode="960x720@60",position="auto",scale=1})
hl.config({debug={enable_stdout_logs=true},animations={enabled=false},general={gaps_in=0,gaps_out=0,border_size=1},xwayland={enabled=false},misc={disable_hyprland_logo=true,disable_splash_rendering=true},input={kb_layout="kr",kb_variant="kr104"}})
hl.bind("ALT + F4",hl.dsp.window.close())
`);
const env={...process.env,PATH:join(root,'usr/bin')+':'+process.env.PATH,XDG_DATA_DIRS:join(root,'usr/share')+':/usr/local/share:/usr/share',XDG_RUNTIME_DIR:runtime,WAYLAND_DISPLAY:join(process.env.XDG_RUNTIME_DIR,process.env.WAYLAND_DISPLAY),LD_LIBRARY_PATH:join(root,'usr/lib'),LIBSEAT_BACKEND:'seatd',SEATD_SOCK:join(runtime,'no-seatd'),AQ_DRM_DEVICES:'/dev/null',HYPRLAND_NO_SD_VARS:'1',HYPRLAND_NO_SD_NOTIFY:'1',XDG_CURRENT_DESKTOP:'Hyprland'};
const fd=openSync('artifacts/hyprland-test.log','w');
const compositor=spawn(join(root,'usr/bin/Hyprland'),['--config',config],{env,stdio:['ignore',fd,fd]});closeSync(fd);
const exit=new Promise(done=>compositor.once('exit',done));
await writeFile('artifacts/hyprland-process.json',JSON.stringify({pid:compositor.pid,runtime}));
try{
 const socket=await waitFor(async()=>{if(compositor.exitCode!==null)throw Error('Nested Hyprland exited; see artifacts/hyprland-test.log');for(const name of await readdir(runtime)){if(name.startsWith('wayland-')&&(await lstat(join(runtime,name))).isSocket())return name;}return null;},'nested Hyprland socket',20000);
 const own=await waitFor(async()=>{try{return JSON.parse((await execute(join(root,'usr/bin/hyprctl'),['-j','instances'],{env})).stdout).find(instance=>Number(instance.pid)===compositor.pid);}catch{return null;}},'exact owned compositor instance',20000);
 env.HYPRLAND_INSTANCE_SIGNATURE=own.instance;
 env.WAYLAND_DISPLAY=socket;env.WEBER_TEST_DISPLAY='isolated Hyprland 0.56.2 nested in private GNOME; native text-input-v3/input-method-v2';
 env.WEBER_TEST_HYPRCTL=join(root,'usr/bin/hyprctl');
 const control=async args=>(await execute(env.WEBER_TEST_HYPRCTL,args,{env})).stdout;
 if(JSON.parse(await control(['-j','monitors'])).length===0)console.log(await control(['output','create','headless']));
 await waitFor(async()=>JSON.parse(await control(['-j','monitors'])).length>0,'private Hyprland headless output');
 await writeFile('artifacts/hyprland-environment.json',JSON.stringify({display:env.WEBER_TEST_DISPLAY,version:await control(['version']),monitors:JSON.parse(await control(['-j','monitors'])),isolated:true,drmDisabled:true,parent:'private GNOME headless Wayland'},null,2));
 await delay(300);
 const child=spawn(process.execPath,process.argv.slice(2),{env,stdio:'inherit'});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)});if(code!==0)process.exitCode=code??1;
}finally{
 try {for(const signature of await readdir(join(runtime,'hypr'))) {
  const content=await readFile(join(runtime,'hypr',signature,'hyprland.log'),'utf8').catch(()=>null);
  if(content)await writeFile('artifacts/hyprland-internal.log',content);
 }}catch{}
 if(compositor.exitCode===null)compositor.kill();
 const timer=setTimeout(()=>{if(compositor.exitCode===null)compositor.kill('SIGKILL');},3000);
 try{await exit;}finally{clearTimeout(timer);}
 const owned=async pid=>{try{return(await readFile(`/proc/${pid}/environ`,'utf8')).split('\0').includes(`XDG_RUNTIME_DIR=${runtime}`);}catch{return false;}};
 for(const name of await readdir('/proc'))if(/^\d+$/.test(name)&&await owned(name)){try{process.kill(Number(name),'SIGKILL');}catch{}}
 await rm(runtime,{recursive:true,force:true});
}

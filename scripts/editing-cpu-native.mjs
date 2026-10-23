// A/B the correctness observer, with identical OS input and one warm process.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync,constants} from 'node:fs';
import {mkdir,readFile,readdir,writeFile,open,mkdtemp,rm,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {cpus,release,arch} from 'node:os';
import {NativeKeys,launch,execute,waitFor,delay,memory,distribution} from './native-desktop.mjs';

assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated Hyprland'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const profileOnly=process.env.WEBER_CPU_PERF==='1';
const endurance=process.env.WEBER_CPU_ENDURANCE==='1';
assert.ok(!(profileOnly&&endurance),'Profile and endurance are separate runs');
const output=profileOnly?'artifacts/editing-cpu-profile.json':endurance?'artifacts/editing-cpu-endurance.json':'artifacts/editing-cpu-native.json';
const binary=resolve(process.argv[2]??'target/package/weber-clipboard-jit/weber');
const fixture=JSON.parse(await readFile('artifacts/editing-workflow.json','utf8'));
if(process.env.WEBER_CPU_APPLICATION)fixture.application=resolve(process.env.WEBER_CPU_APPLICATION);
const build=JSON.parse((await execute(binary,['--build-info'])).stdout);
const hz=Number((await execute('getconf',['CLK_TCK'])).stdout);
const cycles=Number(process.env.WEBER_CPU_CYCLES??(profileOnly||endurance?100:50)),periodMs=85;
assert.ok(Number.isInteger(cycles)&&cycles>=5&&cycles<=200);
const results=[],report={passed:false,build,binary,fixture,display:process.env.WEBER_TEST_DISPLAY,
 startedAt:new Date().toISOString(),hardware:{cpu:cpus()[0].model,logicalCpus:cpus().length,kernel:release(),arch:arch()},
 fixtureBuild:JSON.parse(await readFile(join(fixture.application,'build.json'),'utf8')),
 fixtureSha256:createHash('sha256').update(await readFile(join(fixture.application,'web.js'))).digest('hex'),
 methodology:{cpu:'100% = one logical CPU; Weber process tree only; excludes compositor, Fcitx and driver',
 workload:'Hangul r+k, space commit, Backspace space, Backspace syllable; native OS keycodes',
 periodMs,cyclesPerBlock:cycles,order:profileOnly?[]:endurance?Array(8).fill('quiet'):['observed','quiet','quiet','observed','quiet','observed','observed','quiet'],
 boundary:'Quiet disables per-event DOM snapshots/JSON/bridge calls. Cheap event counters and host telemetry remain enabled. Not telemetry-free production CPU or input latency.',
 sampling:'Process CPU from /proc stat at CLK_TCK; thread attribution from schedstat runtime nanoseconds; frame presentation is not inferred from event counts.'},results};
await writeFile(output,JSON.stringify(report,null,2));
const dir=join(process.env.XDG_CONFIG_HOME,'fcitx5');await mkdir(dir,{recursive:true});
await writeFile(join(dir,'profile'),'[Groups/0]\nName=Default\nDefault Layout=kr-kr104\nDefaultIM=hangul\n[Groups/0/Items/0]\nName=keyboard-kr-kr104\n[Groups/0/Items/1]\nName=hangul\n[GroupOrder]\n0=Default\n');
await writeFile(join(dir,'config'),'[Hotkey/TriggerKeys]\n0=Hangul\n');
const fd=openSync('artifacts/editing-cpu-fcitx.log','w');
const fcitx=spawn('fcitx5',['--disable=xcb,classicui,notifications,ibusfrontend'],{stdio:['ignore',fd,fd]});closeSync(fd);
let app,keys,observer=true,nativePid,profileDir,control,ack;
const latest=async stage=>(await app.events()).filter(e=>e.data.stage===stage).at(-1)?.data;
async function focused(){
 const active=JSON.parse((await execute(process.env.WEBER_TEST_HYPRCTL,['-j','activewindow'])).stdout);
 assert.equal(Number(active.pid),nativePid,'Input stays on the owned private window');
}
// Snapshot polling happens outside the measured interval.
async function state(){
 const before=(await app.events()).filter(e=>e.data.stage==='editing-identity').length;
 await keys.key(87);
 return await waitFor(async()=>{const all=(await app.events()).filter(e=>e.data.stage==='editing-identity');return all.length>before?all.at(-1).data:null;},'explicit editing snapshot');
}
async function sample(){
 const mem=await memory(nativePid);let ticks=0;const threads={};
 for(const pid of mem.pids){
  const stat=await readFile(`/proc/${pid}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
  ticks+=Number(fields[11])+Number(fields[12]);
  for(const tid of await readdir(`/proc/${pid}/task`)){
   try{threads[tid]={name:(await readFile(`/proc/${pid}/task/${tid}/comm`,'utf8')).trim(),ns:Number((await readFile(`/proc/${pid}/task/${tid}/schedstat`,'utf8')).split(/\s+/)[0])};}catch{}
  }
 }
 return {ticks,threads,memory:mem,time:performance.now()};
}
function delta(a,b){
 const wallMs=b.time-a.time,cpuMs=(b.ticks-a.ticks)/hz*1000;
 const threads=Object.entries(b.threads).map(([tid,t])=>({tid:Number(tid),name:t.name,cpuMs:(t.ns-(a.threads[tid]?.ns??0))/1e6})).sort((a,b)=>b.cpuMs-a.cpuMs);
 return {wallMs,cpuMs,cpuPercent:cpuMs/wallMs*100,threads,memory:b.memory};
}
async function input(n){
 await focused();const started=performance.now(),lateness=[];
 for(let i=0;i<n*5;i++){
  const due=started+i*periodMs;
  if(due>performance.now())await delay(due-performance.now());
  lateness.push(Math.max(0,performance.now()-due));
  const code=[19,37,57,14,14][i%5];
  await keys.command({keycode:code,pressed:true});
  try{await delay(25);}finally{await keys.command({keycode:code,pressed:false});}
 }
 await delay(Math.max(0,started+n*5*periodMs-performance.now()));
 await focused();return distribution(lateness);
}
async function mode(observed){
 if(observer===observed)return;
 await keys.key(60);observer=observed;
 await waitFor(async()=>(await latest('editing-observation'))?.observe===observed,'observer mode');
}
async function block(name,n=cycles){
 const before=await state();assert.equal(before.text,'');await delay(300);
 const a=await sample(),latenessMs=await input(n);await delay(150);const b=await sample();
 assert.ok(latenessMs.max<periodMs,'Input scheduler must not miss a whole key interval');
 const after=await state();assert.equal(after.text,'');assert.ok(after.nodeCount<=1);
 const eventCounts=Object.fromEntries(Object.entries(after.eventCounts).map(([key,value])=>[key,value-(before.eventCounts[key]??0)]));
 assert.equal(eventCounts.compositionend,n,'Every Hangul composition completed');
 assert.ok(eventCounts.input>=n*4,'Edits actually reached DOM');
 const value={mode:name,cycles:n,...delta(a,b),latenessMs,eventCounts,final:{text:after.text,nodeCount:after.nodeCount}};
 console.log(`${name}: ${value.cpuPercent.toFixed(3)}% CPU, ${value.cpuMs.toFixed(0)} ms CPU, late p95 ${latenessMs.p95.toFixed(2)} ms`);
 return value;
}
try{
 await waitFor(async()=>{try{return(await execute('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.NameHasOwner','org.fcitx.Fcitx5'])).stdout.includes('true');}catch{return false;}},'private Fcitx');
 keys=await NativeKeys.open();
 let launcher=binary;
 if(profileOnly){
  profileDir=await mkdtemp(resolve('artifacts/editing-perf-'));
  const ctl=join(profileDir,'control'),reply=join(profileDir,'ack');
  await execute('mkfifo',[ctl,reply]);
  control=await open(ctl,constants.O_RDWR|constants.O_NONBLOCK);
  ack=await open(reply,constants.O_RDWR|constants.O_NONBLOCK);
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  launcher=join(profileDir,'weber-profile');
  await writeFile(launcher,`#!/bin/sh\nexec perf record -e cpu-clock:u -F 499 --call-graph dwarf,8192 --user-callchains --delay=-1 --control=${quote('fifo:'+ctl+','+reply)} -o ${quote(resolve('artifacts/editing-cpu-perf.data'))} -- ${quote(binary)} "$@"\n`);
  await chmod(launcher,0o700);
 }
 app=await launch({binary:launcher,application:fixture.application,engine:'web',name:profileOnly?'editing-cpu-profile':'editing-cpu'});
 nativePid=profileOnly?await waitFor(async()=>{if(app.child.exitCode!==null)throw Error('perf launcher exited; see artifacts/editing-cpu-profile.log');const children=(await readFile(`/proc/${app.child.pid}/task/${app.child.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);assert.ok(children.length<=1);return children[0];},'perf-owned Weber child'):app.child.pid;
 keys.app={...app,child:{pid:nativePid,exitCode:null}};
 await app.waitEvent(e=>e.data.stage==='editing-ready','fixture ready');
 await app.waitEvent(e=>e.data.stage==='first-app-present','first presented frame');await keys.activate();
 await waitFor(async()=>/frontend:wayland[^ ]* cap:\S+ focus:1/.test((await execute('gdbus',['call','--session','--dest','org.fcitx.Fcitx5','--object-path','/controller','--method','org.fcitx.Fcitx.Controller1.DebugInfo'])).stdout),'focused Wayland IME');
 await execute('fcitx5-remote',['-s','hangul']);await execute('fcitx5-remote',['-o']);
 await waitFor(async()=>(await execute('fcitx5-remote',[])).stdout.trim()==='2','Hangul active');
 await mode(false);await block('warmup',10);
 const a=await sample();await delay(5000);report.idle=delta(a,await sample());
 if(profileOnly){
  async function command(value){
   await control.write(value+'\n');
   await waitFor(async()=>{const buffer=Buffer.alloc(64);try{const {bytesRead}=await ack.read(buffer,0,buffer.length,null);return buffer.subarray(0,bytesRead).toString().includes('ack');}catch(error){if(error.code==='EAGAIN')return false;throw error;}},'perf '+value,5000);
  }
  await command('enable');report.profile=await block('quiet-profile');await command('disable');
 }else{
  for(const name of report.methodology.order){await mode(name==='observed');results.push(await block(name));await writeFile(output,JSON.stringify(report,null,2));}
  report.summary=Object.fromEntries([...new Set(report.methodology.order)].map(mode=>[mode,{cpuPercent:distribution(results.filter(r=>r.mode===mode).map(r=>r.cpuPercent)),cpuMsPerCycle:distribution(results.filter(r=>r.mode===mode).map(r=>r.cpuMs/r.cycles))}]));
 }
 await keys.key(88);assert.equal((await app.waitExit()).code,0);report.passed=true;
}catch(error){report.error=String(error);throw error;}
finally{
 await writeFile(output,JSON.stringify(report,null,2));
 if(keys)await keys.close();if(app)await app.stop();if(fcitx.exitCode===null)fcitx.kill();
 await control?.close();await ack?.close();if(profileDir)await rm(profileDir,{recursive:true,force:true});
}

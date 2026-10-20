import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { launch, execute, delay, memory, distribution } from './native-desktop.mjs';
const binaries={before:'target/package/weber-beta-jit/weber',after:'target/package/weber-platform-jit/weber'};
const builds={},startup={before:[],after:[]},steady={before:[],after:[]};
for(const [name,binary] of Object.entries(binaries)){
 builds[name]=JSON.parse((await execute(binary,['--build-info'])).stdout);
 assert.equal(builds[name].profile,'release');assert.equal(builds[name].aotAvailable,false);
}
for(let index=-1;index<8;index++){
 for(const name of index%2===0?['before','after']:['after','before']){
  const app=await launch({binary:binaries[name],engine:'web',mode:'benchmark',name:`platform-start-${name}-${index+1}`,config:{timeoutMs:1000}});
  try{
   const first=await app.waitEvent(event=>event.data.stage==='first-app-present','native app presentation');
   assert.equal((await app.waitExit()).code,0);
   const ready=(await app.events()).find(event=>event.data.stage==='ready');assert.equal(ready.data.hermesInitialized,false);
   if(index>=0)startup[name].push({spawnToFirstPresentMs:first.unixTimeMs-app.spawnUnixMs,rustMainToAppPresentMs:first.data.startupMs,trace:app.path});
  }finally{await app.stop();}
 }
}
for(let run=0;run<3;run++){
 for(const name of run%2===0?['before','after']:['after','before']){
  const app=await launch({binary:binaries[name],engine:'web',mode:'benchmark',name:`platform-steady-${name}-${run}`,config:{timeoutMs:20000}});
  try{
   await app.waitEvent(event=>event.data.stage==='first-app-present','settled presentation');await delay(1000);
   const samples=[];for(let index=0;index<30;index++){samples.push(await memory(app.child.pid));await delay(100);}
   assert.ok(samples.every(sample=>sample.pssKiB>0&&sample.pids.length===1));
   steady[name].push({pssKiB:distribution(samples.map(sample=>sample.pssKiB)),rssKiB:distribution(samples.map(sample=>sample.rssKiB)),samples,trace:app.path});
  }finally{await app.stop();}
 }
}
const results={};
for(const [name,binary] of Object.entries(binaries))results[name]={binary,build:builds[name],executableSha256:createHash('sha256').update(await readFile(binary)).digest('hex'),startup:{spawnToFirstPresentMs:distribution(startup[name].map(point=>point.spawnToFirstPresentMs)),points:startup[name]},steady:{runMedianPssKiB:distribution(steady[name].map(run=>run.pssKiB.p50)),runMedianRssKiB:distribution(steady[name].map(run=>run.rssKiB.p50)),runs:steady[name]}};
const report={display:process.env.WEBER_TEST_DISPLAY,method:'Previous and current JIT-only release hosts; same embedded Solid demo and 960x720 viewport; one warmup + 8 alternating startup launches per host, warm filesystem. Three separate settled runs per host, 30 correlated smaps_rollup samples per run after readiness +1s. No Bun/input injection; GPU and compositor memory excluded. This is a small before/after screen, not a cross-framework or statistical performance claim.',results};
report.ratios={startup:results.after.startup.spawnToFirstPresentMs.p50/results.before.startup.spawnToFirstPresentMs.p50,pss:results.after.steady.runMedianPssKiB.p50/results.before.steady.runMedianPssKiB.p50};
await writeFile('artifacts/platform-benchmark.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({ratios:report.ratios,results:Object.fromEntries(Object.entries(results).map(([name,result])=>[name,{startup:result.startup.spawnToFirstPresentMs,pss:result.steady.runMedianPssKiB,rss:result.steady.runMedianRssKiB}]))},null,2));

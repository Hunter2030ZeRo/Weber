import {spawn}from'node:child_process';import{openSync,closeSync}from'node:fs';import{writeFile,cp}from'node:fs/promises';
const results=[];
async function run(name,args,extra={}){const log='artifacts/final-alpha-'+name+'.log',fd=openSync(log,'w');const child=spawn(args[0],args.slice(1),{env:{...process.env,...extra},stdio:['ignore',fd,fd]});closeSync(fd);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)});results.push({name,code,log});await writeFile('artifacts/final-alpha-checks.json',JSON.stringify({passed:false,results},null,2));console.log(name+': '+code);if(code!==0)throw new Error(name+' failed: '+log);}
await Promise.all([
 ['preview',['node','scripts/preview-workflow.mjs','--installed']],
 ['clipboard',['node','scripts/clipboard-workflow.mjs','--installed']],
 ['lifecycle',['node','scripts/lifecycle-workflow.mjs','--installed']],
 ['lifecycle-200',['node','scripts/lifecycle-workflow.mjs','--installed','--cycles=200']],
 ['npm',['node','scripts/npm-distribution-smoke.mjs']],
 ['activation',['node','scripts/activation-workflow.mjs']],
 ['alpha',['node','scripts/alpha-workflow.mjs']],
 ['ime',['node','scripts/ime-workflow.mjs','--installed']],
].map(([name,args])=>run('prepare-'+name,args)));
await run('package-notes',['node','sdk/cli.mjs','package','artifacts/preview/notes/dist','target/package/weber-notes-npm'],{WEBER_HOST:process.cwd()+'/target/package/weber-clipboard-jit/weber'});
const native=script=>['env','-u','IBUS_ADDRESS','-u','FCITX_DBUS_ADDRESS','dbus-run-session','--','node','scripts/headless-wayland.mjs',...script];
await run('regression',native(['scripts/regression-native-suite.mjs']),{WEBER_TEST_FILE_CHOOSER:'gtk'});
await run('activation',native(['scripts/activation-native.mjs','target/package/weber-clipboard-jit/weber']),{WEBER_TEST_FILE_CHOOSER:'gtk'});
await run('alpha',native(['scripts/alpha-native.mjs']),{WEBER_TEST_FILE_CHOOSER:'gtk'});
await run('ime',native(['scripts/ime-native.mjs','target/package/weber-clipboard-jit/weber']));
await cp('artifacts/ime-native.json','artifacts/ime-gnome-native.json');
await run('editing-prepare',['node','scripts/editing-workflow.mjs','--installed']);
await run('editing-gnome',native(['scripts/editing-native.mjs','target/package/weber-clipboard-jit/weber']));
await cp('artifacts/editing-native.json','artifacts/editing-gnome-native.json');
await run('hyprland-ime',native(['scripts/nested-hyprland.mjs','scripts/hyprland-ime-suite.mjs','target/package/weber-clipboard-jit/weber']),{WEBER_EDITING_STRESS:'1'});
await cp('artifacts/ime-gnome-native.json','artifacts/ime-native.json');
await run('audit',['node','scripts/alpha-audit.mjs']);
await run('distribution',['node','scripts/alpha-dist.mjs']);
await writeFile('artifacts/final-alpha-checks.json',JSON.stringify({passed:true,results},null,2));

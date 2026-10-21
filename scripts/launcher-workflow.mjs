// GIO parses and launches real Desktop Entry files with adversarial path quoting.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopEntry, launcher } from '../sdk/launcher.mjs';
import { execute, waitFor } from './native-desktop.mjs';
import { fingerprint } from './source-fingerprint.mjs';
const temporary=await mkdtemp('/tmp/weber-launcher-'),bundle=join(temporary,'path $ ` " % \\ 한글');
try {
 await mkdir(join(bundle,'application'),{recursive:true});const app={id:'dev.weber.launcher.test',name:'Launcher 한글\nSecond line'};
 await writeFile(join(bundle,'application/app.json'),JSON.stringify(app));
 await writeFile(join(bundle,'weber'),'#!/usr/bin/python3\nimport os,sys,json\nwith open(os.environ["WEBER_LAUNCH_TEST"],"w") as output: json.dump(sys.argv[1:],output,ensure_ascii=False)\n');await chmod(join(bundle,'weber'),0o755);
 const output=join(temporary,'test.desktop'),record=join(temporary,'argv.json');await launcher(bundle,output);
 let protectedFile=false;try{await launcher(bundle,output);}catch(error){protectedFile=error.code==='EEXIST';}assert.ok(protectedFile);
 const result=await execute('/usr/bin/python3',['-c','import sys,gi; from gi.repository import Gio; app=Gio.DesktopAppInfo.new_from_filename(sys.argv[1]); assert app; print(app.get_name()); assert app.launch([],None)',output],{env:{...process.env,WEBER_LAUNCH_TEST:record}});
 assert.equal(result.stdout.trim(),app.name);await waitFor(async()=>{try{return JSON.parse(await readFile(record,'utf8'));}catch{return null;}},'actual launcher child argv');
 assert.deepEqual(JSON.parse(await readFile(record,'utf8')),['--app',join(bundle,'application')]);
 assert.throws(()=>desktopEntry(bundle,{id:'../bad',name:'Bad'}));
 await writeFile('artifacts/launcher-workflow.json',JSON.stringify({passed:true,source:await fingerprint(),specialPathRoundtrip:true,displayNameRoundtrip:true,existingFileProtected:true,scope:'Private-bus GIO DesktopAppInfo parses and executes a newly created headless argv recorder; spaces, dollar, backtick, quote, percent, backslash, Unicode and newline in display name. No user desktop installation.'},null,2));
 console.log('Desktop launcher GIO/argv roundtrip passed');
}finally{await rm(temporary,{recursive:true,force:true});}

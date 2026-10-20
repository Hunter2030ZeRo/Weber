import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digest } from '../sdk/project.mjs';

const root = process.cwd(), release = join(root, 'target/npm');
const spec = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
const temporary = await mkdtemp('/tmp/weber-npm-distribution-');
const logs = join(root, 'artifacts/npm-distribution'); await mkdir(logs, { recursive: true });
let step = 0;
async function run(program, args, cwd, expected, env = {}) {
  const log = join(logs, `${++step}-${program.split('/').at(-1)}.log`), fd = openSync(log, 'w');
  const cleanEnv = { ...process.env }; delete cleanEnv.WEBER_HOST;
  const child = spawn(program, args, { cwd, env: { ...cleanEnv, ...env }, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  const text = await readFile(log, 'utf8');
  if (expected) { assert.notEqual(code, 0, text); assert.match(text, expected); }
  else assert.equal(code, 0, text);
  return { log, code };
}
const releases = join(temporary, 'releases'); await mkdir(releases);
for (const item of spec.packages) {
  assert.equal(digest(await readFile(join(release, item.file))), item.sha256);
  await cp(join(release, item.file), join(releases, item.file));
}
const sdkFile = spec.packages.find(item => item.name === '@weber/sdk').file;
const runtimeFile = spec.packages.find(item => item.name.startsWith('@weber/runtime-')).file;
const bootstrap = join(temporary, 'bootstrap'); await mkdir(bootstrap);
await run('tar', ['-xzf', join(releases, sdkFile), '-C', bootstrap], temporary);
const cli = join(bootstrap, 'package/cli.mjs');
for (const name of ['solid', 'dom', 'node', 'windows', 'notes']) {
  await run(process.execPath, [cli, 'init', join(temporary, name), name], temporary, undefined, { WEBER_SDK_SPEC: `file:../releases/${sdkFile}` });
}
let project = join(temporary, 'notes');
const npmOptions = ['--offline', '--cache', '/tmp/weber-vite-npm-cache', '--no-audit', '--no-fund'];
await run('npm', ['install', ...npmOptions], project);
assert.ok((await realpath(join(project, 'node_modules/@weber/sdk'))).startsWith(project + '/'));
await run('npm', ['run', 'check'], project);
await run('npm', ['run', 'build'], project);
const dist = join(project, 'dist');
const originalManifest = await readFile(join(dist, 'app.json'), 'utf8');
assert.equal(Boolean(JSON.parse(originalManifest).nativeUnit), false);
const installedCli = join(project, 'node_modules/@weber/sdk/cli.mjs');
await run(process.execPath, [installedCli, 'package', 'dist', 'package'], project, /Native runtime missing/);
await run('npm', ['run', 'build:aot'], project, /AOT compilation requires the Weber source checkout/);
assert.equal(await readFile(join(dist, 'app.json'), 'utf8'), originalManifest);
await run('npm', ['install', '--save-dev', `file:../releases/${runtimeFile}`, ...npmOptions], project);
await run('npm', ['run', 'package'], project);
const bundleManifest = join(project, 'package/manifest.json');
const originalBundle = await readFile(bundleManifest, 'utf8');
const runtimeManifest = join(project, 'node_modules', spec.packages.find(item => item.name.startsWith('@weber/runtime-')).name, 'manifest.json');
const originalRuntime = await readFile(runtimeManifest, 'utf8');
const invalid = JSON.parse(originalRuntime); Object.values(invalid.privateLibraries)[0].sha256 = '0'.repeat(64);
await writeFile(runtimeManifest, JSON.stringify(invalid));
try { await run(process.execPath, [installedCli, 'package', 'dist', 'package'], project, /Runtime file hash mismatch/); }
finally { await writeFile(runtimeManifest, originalRuntime); }
assert.equal(await readFile(bundleManifest, 'utf8'), originalBundle);
await mkdir(join(project, 'unrelated')); await writeFile(join(project, 'unrelated/keep.txt'), 'keep');
await run(process.execPath, [installedCli, 'package', 'dist', 'unrelated'], project, /outside a recognized Weber/);
await run(process.execPath, [installedCli, 'package', 'dist', 'dist/nested'], project, /separate from compiled app/);
const web = join(dist, 'web.js'), originalWeb = await readFile(web);
await writeFile(web, Buffer.concat([originalWeb, Buffer.from('\n// corrupted')]));
try { await run(process.execPath, [installedCli, 'package', 'dist', 'package'], project, /Application file hash mismatch/); }
finally { await writeFile(web, originalWeb); }
assert.equal(await readFile(bundleManifest, 'utf8'), originalBundle);
const entry = join(project, 'src/main.tsx'), original = await readFile(entry, 'utf8');
await writeFile(entry, original + '\nconst typeError: string = 42;\n');
try { await run('npm', ['run', 'build'], project, /not assignable to type 'string'/); }
finally { await writeFile(entry, original); }
assert.equal(await readFile(join(dist, 'app.json'), 'utf8'), originalManifest);

// Probe the genuine Notes component through programmatic DOM input, then restart.
await writeFile(entry, original + String.raw`
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
const report=(data:object)=>(window as any).weberHostCall(JSON.stringify({action:'telemetry',data}));
void(async()=>{
 const {currentWindow,listWindows,closeWindow}=await import('@weber/sdk/window');
 for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Loaded';i++)await wait(20);
 check(document.getElementById('status')?.textContent==='Loaded','note loaded');
 const input=document.getElementById('note') as HTMLTextAreaElement;
 const expected='npm 패키지로 실행한 메모 😀\nSecond line';
 if(currentWindow().id!==1){check(input.value===expected,'child loads saved note');await setValue('npm-child-loaded',true);return;}
 if(input.value===expected){report({stage:'npm-notes-restored',passed:true,text:input.value});await wait(100);closeWindow();return;}
 const type=(text:string)=>{input.value=text;input.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));};
 type(expected);document.getElementById('save')!.click();
 for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Saved';i++)await wait(20);
 check(document.getElementById('status')?.textContent==='Saved','save button');
 type('unsaved edit');document.getElementById('reload')!.click();
 await wait(30);check(!!document.getElementById('discard'),'reload asks before discarding changes');document.getElementById('discard')!.click();
 for(let i=0;i<200&&document.getElementById('status')?.textContent!=='Loaded';i++)await wait(20);
 check(input.value===expected,'reload button');document.getElementById('open')!.click();
 for(let i=0;i<150&&await getValue('npm-child-loaded')!==true;i++)await wait(20);
 check(await getValue('npm-child-loaded')===true,'child note');
 for(const info of listWindows())if(info.id!==1)closeWindow(info.id);
 report({stage:'npm-notes-pass',passed:true,text:input.value});await wait(200);closeWindow();
})().catch(error=>report({stage:'failure',message:String(error),stack:error?.stack}));`);
try { await run('npm', ['run', 'package'], project); }
finally { await writeFile(entry, original); }
// Move the whole project after install: generated config cannot contain bootstrap paths.
const moved = join(temporary, 'relocated-notes'); await rename(project, moved); project = moved;
await run('npm', ['run', 'build'], project);
const info = JSON.parse(await readFile(join(project, 'package/manifest.json'), 'utf8'));
assert.deepEqual(info.build, spec.runtime);
await writeFile('artifacts/npm-distribution.json', JSON.stringify({ passed: true, temporary, project, binary: join(project, 'package/weber'), application: join(project, 'package/application'), release: resolve(release, 'release.json'), runtime: info.build, sdkVersion: spec.sdkVersion, scope: 'All five templates extracted from SDK tarball; external npm install/check/build/package; runtime discovery; relocation; missing runtime/AOT/type error/hash corruption/overlap/unrelated-output failures preserve previous builds. Native execution is recorded separately.', logs }, null, 2));
console.log(`External npm workflow passed: ${project}`);

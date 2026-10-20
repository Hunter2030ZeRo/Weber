// Verify that local acceptance evidence and installable artifacts share source.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprint} from './source-fingerprint.mjs';
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const source=await fingerprint(),release=await read('target/npm/release.json');
assert.equal(release.sdkVersion,'0.4.0');assert.equal(release.runtime.sourceHash,source.sourceHash);
for(const name of ['fileDialogProtocol','closeRequestProtocol','safeCutProtocol','diagnosticsProtocol'])assert.equal(release.runtime[name],1);
assert.equal(release.runtime.aotAvailable,false);assert.equal(release.runtime.uiEngine,'spidermonkey');
const gates=['artifacts/preview-native.json','artifacts/clipboard-browser-native.json','artifacts/clipboard-native.json','artifacts/npm-distribution.json','artifacts/npm-distribution-native.json'];
for(const path of gates){const result=await read(path);assert.equal(result.passed,true,path);assert.equal((result.build??result.runtime).sourceHash,source.sourceHash,path);assert.equal(result.sdkVersion,release.sdkVersion,path);}
const fixture=await read('artifacts/preview-workflow.json');assert.equal(fixture.installed,true);
const clipboard=await read('artifacts/clipboard-workflow.json');assert.equal(clipboard.installed,true);
for(const pkg of release.packages){
  assert.equal(await hash(join('target/npm',pkg.file)),pkg.sha256);
  if(pkg.name==='@weber/sdk')for(const file of pkg.files){
    const source=file.startsWith('templates/')?join('examples',file.slice(10)):join('sdk',file);
    for(const project of [fixture.project,clipboard.project])assert.deepEqual(await readFile(join(project,'node_modules/@weber/sdk',file)),await readFile(source),`${project}: ${file}`);
  }
}
const bundle='target/package/weber-notes-npm',manifest=await read(join(bundle,'manifest.json'));
assert.equal(manifest.build.sourceHash,source.sourceHash);assert.equal(await hash(join(bundle,'weber')),manifest.executableSha256);
for(const [file,value]of Object.entries(manifest.privateLibraries))assert.equal(await hash(join(bundle,'lib',file)),value.sha256);
const app=await read(join(bundle,'application/app.json'));
for(const value of Object.values(app.assets))assert.equal(await hash(join(bundle,'application',value.file)),value.sha256);
const code=await readFile(join(bundle,'application/web.js'),'utf8');
for(const probe of ['preview-state','browser-phase','clipboard-offered'])assert.ok(!code.includes(probe),'No test probe in normal Notes');
const tests=await readFile('artifacts/preview-rust-tests.log','utf8');assert.match(tests,/test result: ok\. 13 passed; 0 failed/);
assert.match(await readFile('artifacts/preview-clippy.log','utf8'),/Finished .* profile/);
const result={passed:true,sourceHash:source.sourceHash,gates,sdkVersion:release.sdkVersion,installedSdkMatchesSource:true,tarballHashes:true,packagedExecutableLibrariesAndAssets:true,productionHasNoProbe:true,rustTests:13,limitations:['Linux Wayland with GTK portal test backend; unparented chooser','Clipboard/app-store values remain 8 KiB; text files 256 KiB','No contenteditable default editing, physical IME, Windows/macOS, AOT, clean-machine or performance validation']};
await writeFile('artifacts/preview-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));

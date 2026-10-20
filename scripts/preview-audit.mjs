// Verify that local acceptance evidence and installable artifacts share source.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprint} from './source-fingerprint.mjs';
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const source=await fingerprint(),release=await read('target/npm/release.json');
assert.equal(release.sdkVersion,'0.5.0');assert.equal(release.runtime.sourceHash,source.sourceHash);
for(const name of ['fileDialogProtocol','closeRequestProtocol','safeCutProtocol','diagnosticsProtocol','fileDialogParentProtocol'])assert.equal(release.runtime[name],1);
const stylo=await read('artifacts/stylo-patches.json');assert.equal(stylo.passed,true);assert.equal(stylo.preparedSourceMatches,true);assert.equal(release.runtime.revisions.stylo,stylo.version);
assert.equal(release.runtime.aotAvailable,false);assert.equal(release.runtime.uiEngine,'spidermonkey');
assert.equal(release.runtime.activationProtocol,1);
for(const [name,limit] of Object.entries({clipboardMaxTextBytes:262144,storageMaxValueBytes:1048576,storageAreaQuotaBytes:16777216,storageQueuedBytes:4194304}))assert.equal(release.runtime[name],limit);
const gates=['artifacts/preview-native.json','artifacts/clipboard-browser-native.json','artifacts/clipboard-native.json','artifacts/npm-distribution.json','artifacts/npm-distribution-native.json','artifacts/lifecycle-native.json','artifacts/lifecycle-200-native.json','artifacts/activation-native.json'];
for(const path of gates){const result=await read(path);assert.equal(result.passed,true,path);assert.equal((result.build??result.runtime).sourceHash,source.sourceHash,path);if(path!=='artifacts/activation-native.json')assert.equal(result.sdkVersion,release.sdkVersion,path);}
const fixture=await read('artifacts/preview-workflow.json');assert.equal(fixture.installed,true);
const clipboard=await read('artifacts/clipboard-workflow.json');assert.equal(clipboard.installed,true);
const lifecycle=await read('artifacts/lifecycle-workflow.json');assert.equal(lifecycle.installed,true);
const lifecycle200=await read('artifacts/lifecycle-200-workflow.json');assert.equal(lifecycle200.installed,true);
const patches=await read('artifacts/preview-patches.json');assert.equal(patches.passed,true);assert.equal(patches.patches.length,9);assert.equal(patches.compiledCheckoutMatchesCleanApply,true);
for(const pkg of release.packages){
  assert.equal(await hash(join('target/npm',pkg.file)),pkg.sha256);
  if(pkg.name==='@weber/sdk')for(const file of pkg.files){
    const source=file.startsWith('templates/')?join('examples',file.slice(10)):join('sdk',file);
    for(const project of [fixture.project,clipboard.project,lifecycle.project,lifecycle200.project])assert.deepEqual(await readFile(join(project,'node_modules/@weber/sdk',file)),await readFile(source),`${project}: ${file}`);
  }
}
const bundle='target/package/weber-notes-npm',manifest=await read(join(bundle,'manifest.json'));
assert.equal(manifest.build.sourceHash,source.sourceHash);assert.equal(await hash(join(bundle,'weber')),manifest.executableSha256);
for(const [file,value]of Object.entries(manifest.privateLibraries))assert.equal(await hash(join(bundle,'lib',file)),value.sha256);
const app=await read(join(bundle,'application/app.json'));
for(const value of Object.values(app.assets))assert.equal(await hash(join(bundle,'application',value.file)),value.sha256);
const code=await readFile(join(bundle,'application/web.js'),'utf8');
for(const probe of ['preview-state','browser-phase','clipboard-offered'])assert.ok(!code.includes(probe),'No test probe in normal Notes');
const tests=await readFile('artifacts/preview-rust-tests.log','utf8');const testResult=tests.match(/test result: ok\. (\d+) passed; 0 failed/);assert.ok(testResult&&Number(testResult[1])>=20,'Host tests include document-generation regression');
assert.match(await readFile('artifacts/preview-clippy.log','utf8'),/Finished .* profile/);
const result={passed:true,sourceHash:source.sourceHash,gates,sdkVersion:release.sdkVersion,installedSdkMatchesSource:true,tarballHashes:true,packagedExecutableLibrariesAndAssets:true,productionHasNoProbe:true,rustTests:Number(testResult[1]),styloPreparedSourceMatches:true,limitations:['Linux Wayland with GTK portal test backend; v1 and unsupported-compositor fallback not native-tested','Activation has separate checkout-SDK native evidence; forced token timeout and navigation race not native-tested','Clipboard/text files 256 KiB; JSON values 1 MiB; area quota 16 MiB','No contenteditable default editing, physical IME, Windows/macOS, AOT, clean-machine or performance validation']};
await writeFile('artifacts/preview-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));

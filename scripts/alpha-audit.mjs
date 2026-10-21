import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint } from './source-fingerprint.mjs';
import { execute } from './native-desktop.mjs';
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
await execute(process.execPath,['scripts/preview-audit.mjs']);
const source=await fingerprint(),release=await read('target/npm/release.json');
assert.equal(release.sdkVersion,'0.6.0-alpha.3');assert.equal(release.runtime.sourceHash,source.sourceHash);assert.equal(release.runtime.appIntegrationProtocol,1);
const native=await read('artifacts/alpha-native.json'),launcher=await read('artifacts/launcher-workflow.json'),fixture=await read('artifacts/alpha-workflow.json');
assert.ok(native.passed&&launcher.passed&&fixture.passed);assert.equal(native.build.sourceHash,source.sourceHash);assert.equal(launcher.source.sourceHash,source.sourceHash);assert.equal(native.sdkVersion,release.sdkVersion);assert.ok(native.installedSdk&&fixture.installed);
assert.ok(native.production.withoutNodeOrBun&&native.production.probeFree);
const manifest=await read(join(fixture.package,'manifest.json'));assert.equal(manifest.build.sourceHash,source.sourceHash);assert.equal(await hash(join(fixture.package,'weber')),manifest.executableSha256);
for(const [file,value]of Object.entries(manifest.privateLibraries))assert.equal(await hash(join(fixture.package,'lib',file)),value.sha256);
const app=await read(join(fixture.package,'application/app.json'));for(const value of Object.values(app.assets))assert.equal(await hash(join(fixture.package,'application',value.file)),value.sha256);
const code=await readFile(join(fixture.package,'application/web.js'),'utf8');for(const probe of ['alpha-begin','alpha-child','alpha-gesture-ready'])assert.ok(!code.includes(probe),'No acceptance probe in shipped Workbench');
const sdk=release.packages.find(pkg=>pkg.name==='@weber/sdk');for(const file of sdk.files){const local=file.startsWith('templates/')?join('examples',file.slice(10)):join('sdk',file);assert.deepEqual(await readFile(join(fixture.project,'node_modules/@weber/sdk',file)),await readFile(local),file);}
const ime=await read('artifacts/ime-native.json'),imeFixture=await read('artifacts/ime-workflow.json');
assert.ok(ime.passed&&imeFixture.passed&&ime.installedSdk&&imeFixture.installed);
assert.equal(ime.build.sourceHash,source.sourceHash);assert.equal(ime.sdkVersion,release.sdkVersion);
assert.ok(ime.display.startsWith('isolated GNOME'));
assert.equal(ime.results.length,13);assert.ok(ime.results.every(result=>result.passed));
for(const project of [imeFixture.project,imeFixture.workbenchProject])for(const file of sdk.files){const local=file.startsWith('templates/')?join('examples',file.slice(10)):join('sdk',file);assert.deepEqual(await readFile(join(project,'node_modules/@weber/sdk',file)),await readFile(local),file);}
const hyprland=await read('artifacts/ime-hyprland-native.json'),editing=await read('artifacts/editing-hyprland-native.json'),reconversion=await read('artifacts/ime-reconversion-hyprland-native.json');
for(const gate of [hyprland,editing,reconversion]){assert.ok(gate.passed);assert.equal(gate.build.sourceHash,source.sourceHash);assert.ok(gate.results.every(result=>result.passed));}
const gnomeEditing=await read('artifacts/editing-gnome-native.json');assert.ok(gnomeEditing.passed);assert.equal(gnomeEditing.build.sourceHash,source.sourceHash);
assert.equal(hyprland.results.length,13);assert.equal(editing.results.length,12);assert.ok(reconversion.popupRects.length>0);assert.equal(editing.resources.blocks.length,2);
assert.ok(editing.resources.blocks.every(block=>block.cycles===100));
const tests=await readFile('artifacts/preview-rust-tests.log','utf8');assert.match(tests,/test result: ok\. 28 passed; 0 failed/);
const result={passed:true,sourceHash:source.sourceHash,sdkVersion:release.sdkVersion,rustTests:28,previewGates:8,alphaNative:true,koreanImeScenarios:ime.results.length,realHangulWorkbenchPersistence:true,hyprlandImeScenarios:hyprland.results.length,nativeEditableScenarios:editing.results.length,hanjaReconversion:true,candidateAnchorProtocol:true,launcherRoundtrip:true,installedSdkMatchesSource:true,productionPackageIntegrity:true,productionWithoutNodeOrBun:true,
 limitations:['Pre-first-presentation Workbench input race remains open; acceptance starts after visible frame','Linux x64 Wayland/GNOME and isolated Hyprland 0.56.2; physical keyboard, full Simulacrum and other OS unverified','Text files/clipboard 256 KiB; contenteditable basic native editing only, no full rich-editor conformance or rich clipboard','No first-class layer-shell/Hyprland desktop shell, tray/global shortcut APIs, renderer recovery or clean-OS certification','Display hotplug without a window event requires explicit refresh; compositor owns focus/minimize/drag policy','Notifications have no actions and depend on a desktop service; cleanup and presentation are best effort']};
await writeFile('artifacts/alpha-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));

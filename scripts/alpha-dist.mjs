// Local artifacts only. Requires current-source alpha acceptance; never publishes.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execute } from './native-desktop.mjs';
import { fingerprint } from './source-fingerprint.mjs';
import { atomicOutput } from '../sdk/project.mjs';
const source=await fingerprint(),audit=JSON.parse(await readFile('artifacts/alpha-audit.json','utf8'));
assert.ok(audit.passed);assert.equal(audit.sourceHash,source.sourceHash);
const release=JSON.parse(await readFile('target/npm/release.json','utf8'));assert.equal(release.runtime.sourceHash,source.sourceHash);
const fixture=JSON.parse(await readFile('artifacts/alpha-workflow.json','utf8'));
const output=resolve('target/alpha');
await atomicOutput(output,'release.json',async staging=>{
 for(const pkg of release.packages)await cp(join('target/npm',pkg.file),join(staging,pkg.file));
 const archive=`weber-workbench-${release.sdkVersion}-linux-x64.tar.gz`;
 // A desktop entry embeds the bundle's absolute path. Generate it on the
 // recipient's machine after extraction instead of shipping a stale launcher.
 await execute('tar',['--exclude=*.desktop','-czf',join(staging,archive),'-C',resolve(fixture.package,'..'),basename(fixture.package)]);
 await cp('artifacts/alpha-audit.json',join(staging,'acceptance.json'));
 await cp('artifacts/alpha-native.json',join(staging,'native-validation.json'));
 await cp('artifacts/ime-native.json',join(staging,'ime-validation.json'));
 for(const name of ['ime-hyprland-native','editing-hyprland-native','ime-reconversion-hyprland-native','hyprland-environment'])await cp(`artifacts/${name}.json`,join(staging,`${name}.json`));
 await writeFile(join(staging,'README.txt'),`Weber ${release.sdkVersion} Linux x64 developer alpha\n\nExtract the Workbench archive and run ./weber --app ./application from its folder.\nRequires compatible Linux glibc/loader, Wayland, EGL/GPU drivers and fonts.\nNo Node/Bun is required to run Workbench. Desktop portals and a notifications\nservice are needed for their respective APIs.\n\nInstall both local SDK/runtime npm tarballs as development dependencies to\nbuild apps. See docs/native-editing-alpha3.md and docs/linux-alpha-06.md in the matching source checkout.\nAfter extraction, use the SDK: weber launcher /absolute/bundle /output/app.desktop\nthen install the launcher as dev.weber.workbench.desktop yourself if desired.\nNo user desktop installation or publication has been performed.\n\nThis is not a beta, universal Linux binary, Windows/macOS port or finished\nSimulacrum desktop shell. See acceptance.json, native-validation.json and ime-validation.json.\n`);
 const files=[];for(const name of (await readdir(staging)).sort()){const bytes=await readFile(join(staging,name));files.push({file:name,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length});}
 await writeFile(join(staging,'SHA256SUMS'),files.map(file=>`${file.sha256}  ${file.file}\n`).join(''));
 await writeFile(join(staging,'release.json'),JSON.stringify({version:release.sdkVersion,sourceHash:source.sourceHash,published:false,platform:'linux-x64-wayland',files},null,2));
});
console.log(`Local developer alpha: ${output}`);

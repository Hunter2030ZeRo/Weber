// Invoke under nested-hyprland.mjs; every child gets real Fcitx/Wayland input.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated Hyprland'));
const binary=process.argv[2]??'target/package/weber-clipboard-jit/weber';
for(const [script,target]of [['ime-native','ime-hyprland-native'],['editing-native','editing-hyprland-native'],['ime-reconversion-native','ime-reconversion-hyprland-native']]){
 const child=spawn(process.execPath,[`scripts/${script}.mjs`,binary],{env:process.env,stdio:'inherit'});
 assert.equal(await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)}),0,script);
 const source=await readFile(`artifacts/${script}.json`);assert.equal(JSON.parse(source).passed,true);
 await writeFile(`artifacts/${target}.json`,source);
 // Preserve per-compositor raw telemetry rather than overwriting it with GNOME.
 for(const trace of JSON.parse(source).traces??[]){await writeFile(`artifacts/${target}-${trace.split('/').at(-1)}`,await readFile(trace));}
}

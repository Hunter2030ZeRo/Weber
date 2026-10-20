// Original scripts remain individual native units: no eval or wrapper function.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, posix } from 'node:path';
import { parse, serialize } from 'parse5';

const out = resolve(process.argv[2]);
await mkdir(out, { recursive: true });
const bytes = await readFile('compatibility/profile.json');
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== (await readFile('compatibility/profile.sha256', 'utf8')).trim()) throw new Error('Profile lock mismatch');
const profile = JSON.parse(bytes);
for (const file of profile.files) {
  if (createHash('sha256').update(await readFile(`vendor/wpt/${file.path}`)).digest('hex') !== file.sha256) throw new Error(`Unverified WPT file: ${file.path}; run scripts/prepare-wpt.mjs`);
}
const units = [];
async function compile(name, source) {
  const path = `${out}/${name}.js`, object = `${out}/${name}.o`;
  const key = createHash('sha256').update(source).update('-O -Xes6-block-scoping -Wc,-O0').update(await readFile('vendor/hermes/include/hermes/VM/sh_runtime.h')).update(await readFile('target/hermes/bin/shermes')).digest('hex');
  let cached;
  try { cached = await readFile(`${path}.sha256`, 'utf8'); } catch {}
  if (cached !== key) {
    await writeFile(path, source);
    const result = spawnSync('target/hermes/bin/shermes', ['-O', '-Xes6-block-scoping', '-Wc,-O0', '-c', `-exported-unit=${name}`, '-o', object, path], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`WPT AOT compilation failed: ${name}`);
    await writeFile(`${path}.sha256`, key);
  }
  units.push(name);
  return name;
}
const harness = await compile('weber_wpt_harness', await readFile('vendor/wpt/resources/testharness.js', 'utf8'));
const cases = [];
for (const [index, file] of profile.tests.entries()) {
  let fixture = '', scripts = [];
  const source = await readFile(`vendor/wpt/${file}`, 'utf8');
  if (file.endsWith('.js')) scripts.push(source);
  else {
    const tree = parse(source);
    const walk = async node => {
      for (const child of [...(node.childNodes ?? [])]) {
        if (child.tagName === 'script') {
          const src = child.attrs.find(attr => attr.name === 'src')?.value;
          if (!src) scripts.push((child.childNodes ?? []).map(node => node.value ?? '').join(''));
          else {
            const path = src.startsWith('/') ? src.slice(1) : posix.join(posix.dirname(file), src);
            if (!['resources/testharness.js', 'resources/testharnessreport.js'].includes(path)) {
              if (!profile.files.some(entry => entry.path === path)) throw new Error(`Unlocked script ${path}`);
              scripts.push(await readFile(`vendor/wpt/${path}`, 'utf8'));
            }
          }
          node.childNodes.splice(node.childNodes.indexOf(child), 1);
        } else await walk(child);
      }
    };
    await walk(tree);
    fixture = serialize(tree);
  }
  const init = await compile(`weber_wpt_init_${index}`, `globalThis.weberWptPrepare(${JSON.stringify(file)}, ${JSON.stringify(hash)}, ${JSON.stringify(fixture)});`);
  const testUnits = [];
  for (const [part, script] of scripts.entries()) testUnits.push(await compile(`weber_wpt_case_${index}_${part}`, script));
  cases.push([init, ...testUnits]);
}
const header = `${units.map(name => `extern "C" SHUnit *sh_export_${name}();`).join('\n')}
static bool initialize_wpt(SHRuntime *runtime, std::uint32_t index) {
  if (!_sh_initialize_units(runtime, 1, sh_export_${harness})) return false;
  switch (index) {
${cases.map((names, index) => `    case ${index}: return _sh_initialize_units(runtime, ${names.length}, ${names.map(name => `sh_export_${name}`).join(', ')});`).join('\n')}
    default: throw std::out_of_range("Unknown locked WPT case");
  }
}
`;
await writeFile(`${out}/wpt-units.hpp`, header);
await writeFile(`${out}/wpt-objects.txt`, units.map(name => `${out}/${name}.o`).join('\n'));
console.log(`WPT AOT: ${cases.length} files, ${units.length} native units; ${hash}`);

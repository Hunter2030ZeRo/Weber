import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const [source, object, unit, optimization] = process.argv.slice(2);
if (![source, object, unit].every(Boolean) || !['O0', 'O3'].includes(optimization)) throw new Error('Invalid native compilation plan');
const flags = ['-O', '-Xes6-block-scoping', `-Wc,-${optimization}`, '-c', `-exported-unit=${unit}`];
const hash = createHash('sha256').update(JSON.stringify(flags));
for (const path of [source, 'target/hermes/bin/shermes', 'vendor/hermes/include/hermes/VM/static_h.h', 'vendor/hermes/include/hermes/VM/sh_runtime.h', 'vendor/hermes/include/hermes/VM/sh_mirror.h']) hash.update(await readFile(path));
const key = hash.digest('hex');
let cached = false;
try { cached = (await readFile(`${object}.sha256`, 'utf8')) === key && (await stat(object)).isFile(); } catch {}
if (!cached) {
  await new Promise((resolve, reject) => {
    const child = spawn('target/hermes/bin/shermes', [...flags, '-o', object, source], { stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Native AOT compiler exit ${code}`)));
  });
  await writeFile(`${object}.sha256`, key);
}
console.log(`${unit}: native ${optimization}${cached ? ' cached' : ''}`);

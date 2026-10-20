// Compare normal packaged apps without inheriting either executable's cache history.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { launch, execute, delay, distribution, memory } from './native-desktop.mjs';

assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'), 'Use the isolated Wayland harness');
assert.equal(process.argv.length, 5, 'Pass two prepared runtime executables and an application directory');
const [before, after, application] = process.argv.slice(2).map(path => resolve(path));
const prefix = process.env.WEBER_REPORT_PREFIX ?? 'residency-';
assert.match(prefix, /^[a-z0-9-]+$/);
const hz = Number((await execute('getconf', ['CLK_TCK'])).stdout.trim());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const builds = await Promise.all([before, after].map(async binary => ({
  binary, sha256: hash(await readFile(binary)), info: JSON.parse((await execute(binary, ['--build-info'])).stdout),
})));
const manifest = JSON.parse(await readFile(join(application, 'app.json'), 'utf8'));
for (const asset of Object.values(manifest.assets)) assert.equal(hash(await readFile(join(application, asset.file))), asset.sha256);
async function ticks(pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return Number(fields[11]) + Number(fields[12]);
}
function mappings(text, binary) {
  return text.split(/(?=^[0-9a-f]+-[0-9a-f]+ )/m).filter(block => block.split('\n')[0].endsWith(binary)).map(block => ({
    permissions: block.split(/\s+/)[1], offset: block.split(/\s+/)[2],
    ...Object.fromEntries([...block.matchAll(/^(Size|Rss|Pss|Shared_Clean|Private_Clean|Private_Dirty|Anonymous):\s+(\d+)/gm)].map(match => [match[1], Number(match[2])])),
  }));
}
await mkdir('target', { recursive: true });
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/${prefix}benchmark.json`, JSON.stringify({ passed: false, builds, application, scope: 'Benchmark started; completion unconfirmed' }));
const work = await mkdtemp(resolve('target/residency-'));
const trials = [];
try {
  for (const [trial, variant] of [0, 1, 1, 0, 0, 1, 1, 0].entries()) {
    const source = builds[variant].binary, directory = join(work, String(trial));
    await mkdir(join(directory, 'lib'), { recursive: true });
    const files = ['weber', ...(await readdir(join(dirname(source), 'lib'))).sort().map(file => 'lib/' + file)];
    const hashes = {};
    // Each trial gets new inodes and the same copy/hash/read sequence. Reading
    // an old inode does not undo the kernel's previous page-cache population.
    for (const file of files) {
      await copyFile(file === 'weber' ? source : join(dirname(source), file), join(directory, file));
      const bytes = await readFile(join(directory, file));
      hashes[file] = hash(bytes);
      assert.equal(hashes[file], hash(await readFile(file === 'weber' ? source : join(dirname(source), file))));
    }
    await chmod(join(directory, 'weber'), 0o755);
    const binary = join(directory, 'weber');
    const app = await launch({ binary, application, engine: 'web', name: prefix + trial });
    try {
      const ready = await app.waitEvent(event => event.data.stage === 'ready', 'normal application DOM ready');
      await delay(1800);
      const smaps = await readFile(`/proc/${app.child.pid}/smaps`, 'utf8');
      await writeFile(`artifacts/${prefix}${trial}.smaps`, smaps);
      const began = performance.now(), start = await ticks(app.child.pid), samples = [];
      for (let sample = 0; sample < 20; sample++) {
        const rollup = await readFile(`/proc/${app.child.pid}/smaps_rollup`, 'utf8');
        const amount = name => Number(rollup.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'))?.[1] ?? 0);
        samples.push({ ...await memory(app.child.pid), anonKiB: amount('Pss_Anon'), fileKiB: amount('Pss_File') });
        await delay(100);
      }
      const wallMs = performance.now() - began, cpuMs = ((await ticks(app.child.pid)) - start) * 1000 / hz;
      const present = (await app.events()).find(event => event.data.stage === 'first-app-present');
      trials.push({ trial, variant, hashes, trace: app.path, mappingsKiB: mappings(smaps, binary),
        domReadyMs: ready.unixTimeMs - app.spawnUnixMs,
        firstAppPresentMs: present ? present.unixTimeMs - app.spawnUnixMs : null,
        wallMs, cpuMs, cpuPercent: cpuMs / wallMs * 100,
        memoryMiB: Object.fromEntries(['rssKiB', 'pssKiB', 'privateKiB', 'anonKiB', 'fileKiB'].map(key => [key.replace('KiB', ''), distribution(samples.map(value => value[key] / 1024))])),
      });
    } finally { await app.stop(); }
  }
  const summary = builds.map((_, variant) => {
    const own = trials.filter(trial => trial.variant === variant);
    return { variant, pssMiB: distribution(own.map(trial => trial.memoryMiB.pss.p50)),
      rssMiB: distribution(own.map(trial => trial.memoryMiB.rss.p50)),
      executableRssMiB: distribution(own.map(trial => trial.mappingsKiB.reduce((sum, map) => sum + map.Rss, 0) / 1024)),
      domReadyMs: distribution(own.map(trial => trial.domReadyMs)),
      cpuPercent: distribution(own.map(trial => trial.cpuPercent)),
    };
  });
  const result = { passed: true, builds, application, manifest, display: process.env.WEBER_TEST_DISPLAY, trials, summary,
    scope: 'Unmodified packaged application, no injected JS. Four interleaved launches per host; fresh executable/private-library inodes and identical full-file warm reads each launch, outside the startup timer. Settled samples within a launch are correlated. DOM-ready and first post-ready native presentation are separate; absent presentation markers remain null. No typing, focus guarantee, physical IME, cold-disk, compositor/GPU memory or all-day claim. Copying controls an observed inode/cache-history confound; it does not guarantee identical kernel cache state.' };
  await writeFile(`artifacts/${prefix}benchmark.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, summary }));
} finally { await rm(work, { recursive: true, force: true }); }

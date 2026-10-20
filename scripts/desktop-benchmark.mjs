import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { launch, NativeKeys, delay, execute, memory, distribution } from './native-desktop.mjs';
import { createHash } from 'node:crypto';
const prefix = process.env.WEBER_REPORT_PREFIX ?? '';
assert.match(prefix, /^[a-zA-Z0-9-]*$/);

const binary = process.argv[2] ?? 'target/package/weber-release/weber';
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout);
assert.equal(build.profile, 'release', 'Use an optimized build');
if (build.aotAvailable) assert.equal(build.platformNativeOptimization, 'O3');
const engines = build.aotAvailable ? ['aot', 'web'] : ['web'];
const jitBinary = process.env.WEBER_JIT_HOST ?? binary;
const jitBuild = JSON.parse((await execute(jitBinary, ['--build-info'])).stdout);
assert.equal(jitBuild.sourceHash, build.sourceHash, 'Compare the same source');
assert.equal(jitBuild.profile, 'release');
const selected = engine => engine === 'web' ? jitBinary : binary;
const startup = Object.fromEntries(engines.map(engine => [engine, []])), steady = {};
// First launch of each engine warms filesystem/driver caches, then alternate order.
for (let index = -1; index < 12; index++) {
  for (const engine of index % 2 === 0 ? engines : [...engines].reverse()) {
    const app = await launch({ binary: selected(engine), engine, mode: 'benchmark', name: `${prefix}desktop-bench-start-${engine}-${index + 1}`, config: { timeoutMs: 1100 } });
    try {
      const first = await app.waitEvent(event => event.data.stage === 'first-app-present', 'First native app presentation');
      const observedMs = performance.now() - app.started;
      assert.equal((await app.waitExit()).code, 0);
      const ready = (await app.events()).find(event => event.data.stage === 'ready');
      assert.equal(ready.data.hermesInitialized, engine === 'aot');
      if (index >= 0) startup[engine].push({ startupMs: first.data.startupMs, spawnToFirstPresentMs: first.unixTimeMs - app.spawnUnixMs, spawnToObservedMs: observedMs, trace: app.path });
    } finally { await app.stop(); }
  }
}
const measureInput = process.env.WEBER_BENCH_INPUT !== "0";
const originalIme = measureInput && !process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME') ? (await execute('fcitx5-remote', []).catch(() => ({ stdout: '' }))).stdout.trim() : '';
const keys = measureInput ? await NativeKeys.open() : null;
try {
  for (const engine of [...engines].reverse()) {
    const app = await launch({ binary: selected(engine), engine, mode: 'benchmark', name: `${prefix}desktop-bench-steady-${engine}`, config: { timeoutMs: 45000 } });
    if (keys) keys.app = app;
    try {
      await app.waitEvent(event => event.data.stage === 'driver-start', 'Desktop start'); if (keys) await keys.activate();
      await app.waitEvent(event => event.data.stage === 'focused', 'Benchmark button focus');
      if (['1', '2'].includes(originalIme)) await execute('fcitx5-remote', ['-c']);
      await delay(1000);
      const cpuTicks = async () => { const stat = await readFile(`/proc/${app.child.pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/); return Number(fields[11]) + Number(fields[12]); };
      const hz = Number((await execute('getconf', ['CLK_TCK'])).stdout.trim());
      const cpuStart = await cpuTicks(), cpuBegan = performance.now();
      const samples = [];
      for (let index = 0; index < 40; index++) { samples.push(await memory(app.child.pid)); await delay(200); }
      const cpuMs = ((await cpuTicks()) - cpuStart) * 1000 / hz, cpuWallMs = performance.now() - cpuBegan;
      for (let index = 1; keys && index <= 40; index++) {
        const after = (await app.events()).length; await keys.key(28);
        const event = await app.waitEvent((event, position) => position >= after && event.data.stage === 'input-update' && event.data.target === 'solid-counter' && event.data.snapshot.count === String(index), 'Native benchmark activation');
        assert.equal(event.data.trusted, true);
        await app.waitEvent((event, position) => position >= after && event.data.stage === 'input-present', 'Post-update native presentation');
        await delay(60);
      }
      if (keys) { await keys.key(62, [56]); assert.equal((await app.waitExit()).code, 0); } else { await app.stop(); }
      const all = await app.events(); const summary = all.find(event => event.data.stage === 'presentation-summary');
      const latencies = all.filter(event => event.data.stage === 'input-present').map(event => event.data.latencyMs);
      if (keys) assert.ok(latencies.length >= 40, '40 native input/present samples');
      steady[engine] = { animatedCpu: { cpuMs, wallMs: cpuWallMs, percentOfOneLogicalCore: cpuMs / cpuWallMs * 100 }, memory: { rssKiB: distribution(samples.map(point => point.rssKiB)), pssKiB: distribution(samples.map(point => point.pssKiB)), privateKiB: distribution(samples.map(point => point.privateKiB)), samples },
        inputToNextPresentMs: latencies.length ? distribution(latencies) : null, nativePresentIntervalsMs: summary?.data.intervalsMs.length ? distribution(summary.data.intervalsMs) : null, trace: app.path };
    } finally { if (keys) keys.app = null; await app.stop(); }
  }
} finally { if (keys) { keys.app = null; await keys.close(); } if (['1', '2'].includes(originalIme)) await execute('fcitx5-remote', [originalIme === '2' ? '-o' : '-c']); }
const cpu = (await readFile('/proc/cpuinfo', 'utf8')).match(/^model name\s+: (.*)$/m)?.[1];
const report = { build, jitBuild, jitBinary, inputMeasured: measureInput, hardware: { cpu, kernel: (await execute('uname', ['-srmo'])).stdout.trim(), renderer: 'See headless-wayland and native app logs', session: process.env.WEBER_TEST_DISPLAY ?? 'GNOME desktop Wayland, same 960x720 logical viewport' },
  method: { startup: '1 warmup +12 alternating samples per engine; warm filesystem. spawnToFirstPresent uses parent pre-spawn wall clock and native event wall timestamp, including loader/process start. rustMainToAppPresent excludes loader. First native present follows two app rAF callbacks; not optical scanout.', cpu: 'Main app process utime+stime during the eight-second memory sampling window after one second settling; one logical core = 100%; excludes compositor/external GPU. Diagnostic sampling itself adds overhead.', input: measureInput ? 'GNOME Mutter OS Enter input to next distinct native present after DOM acknowledgement, 40 samples; proxy, not optical latency' : 'Not measured: resource-only run; no compositor input/focus assertion' , memory: 'Process-tree /proc smaps_rollup PSS/RSS, 40 samples at 200ms; GPU allocations excluded', frame: 'Intervals of distinct native buffer presentations; not display scan-out timestamps', comparison: 'Capabilities select JIT-only or same-source dual-engine comparison; Servo DOM, TSX, assets and viewport. WEBER_JIT_HOST may select a JIT-only host without Hermes; AOT still adds the mirror DOM and sync adapter. No Bun backend in this workload.' },
  startup: Object.fromEntries(Object.entries(startup).map(([engine, points]) => [engine, { rustMainToAppPresentMs: distribution(points.map(point => point.startupMs)), spawnToFirstPresentMs: distribution(points.map(point => point.spawnToFirstPresentMs)), points }])), steady };
report.executableSha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
if (build.aotAvailable) {
  const startupRatio = report.startup.aot.spawnToFirstPresentMs.p50 / report.startup.web.spawnToFirstPresentMs.p50;
  const memoryRatio = steady.aot.memory.pssKiB.p50 / steady.web.memory.pssKiB.p50;
  report.aotGate = { requiredMedianImprovement: 0.05, startupRatio, memoryRatio,
    eligibleOnThisWorkload: startupRatio <= .95 && memoryRatio <= .95,
    interpretation: 'Both median spawn-to-first-present and process-tree PSS must improve by at least 5%. This single workload does not establish a general win; no automatic runtime promotion.' };
} else {
  report.aotGate = { evaluated: false, reason: 'JIT-only host; no AOT comparison' };
}
report.jitExecutableSha256 = createHash('sha256').update(await readFile(jitBinary)).digest('hex');
await writeFile(`artifacts/${prefix}desktop-benchmark.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ startup: report.startup, steady: Object.fromEntries(Object.entries(steady).map(([engine, result]) => [engine, { cpu: result.animatedCpu, pssKiB: result.memory.pssKiB, inputMs: result.inputToNextPresentMs, framesMs: result.nativePresentIntervalsMs }])) }, null, 2));

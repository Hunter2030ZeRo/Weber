import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, delay, memory, execute } from './native-desktop.mjs';
const prefix = process.env.WEBER_REPORT_PREFIX ?? '';
assert.match(prefix, /^[a-zA-Z0-9-]*$/);

const binary = process.argv[2] ?? 'target/debug/weber-servo';
const build = JSON.parse((await execute(resolve(binary), ['--build-info'])).stdout);
const results = [];
for (const engine of build.aotAvailable ? ['aot', 'web'] : ['web']) {
  const app = await launch({ binary, engine, mode: 'stress', name: `${prefix}desktop-stress-${engine}`, benchmark: true });
  const points = [];
  let sampling = true;
  const sampler = (async () => {
    let seen = 0;
    while (sampling) {
      const all = await app.events();
      const pending = all.slice(seen).filter(event => event.data.stage === 'stress-checkpoint'); seen = all.length;
      if (pending.length) { const usage = await memory(app.child.pid); for (const event of pending) points.push({ ...event, memory: usage }); }
      await delay(35);
    }
  })();
  try {
    const complete = await app.waitEvent(event => event.data.stage === 'stress-complete', 'Ownership stress', 120000);
    assert.equal((await app.waitExit()).code, 0);
    sampling = false; await sampler;
    assert.equal(complete.data.passed, true);
    assert.equal(points.length, 55, 'Every ownership checkpoint sampled');
    assert.ok(points.every(point => point.memory.pssKiB > 0), 'Every process memory sample is live');
    const tail = points.filter(point => point.data.phase === 'mutation').slice(-20);
    const growthKiB = tail.at(-1).memory.pssKiB - tail[0].memory.pssKiB;
    assert.ok(growthKiB < 16384, 'Warmed mutation tail must not grow by 16 MiB');
    if (engine === 'aot') {
      const heaps = tail.map(point => point.data.runtime.heap);
      assert.ok(heaps.every(heap => heap && Object.keys(heap).length > 0), 'Real Hermes heap counters');
    }
    results.push({ engine, passed: true, complete: complete.data, points, mutationTailPssGrowthKiB: growthKiB });
  } finally { sampling = false; await sampler; await app.stop(); }
}
await writeFile(`artifacts/${prefix}desktop-stress.json`, JSON.stringify({ passed: true, build, display: process.env.WEBER_TEST_DISPLAY ?? 'desktop session',
  criteria: '35 cohorts of 500 detached element/text listener cycles (5 warmup), retained identity/listener reuse, 20 complete disposals/remounts; post-GC live AOT/native handles <= warm baseline +16; disposed root stays empty; warmed 20-cohort PSS growth <16 MiB',
  scope: 'Forced-GC bounded ownership workload; not a proof against all long-term leaks', results }, null, 2));
console.log(results.map(result => ({ engine: result.engine, passed: true, mutationTailPssGrowthKiB: result.mutationTailPssGrowthKiB })));

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launch, execute } from './native-desktop.mjs';
const binary = process.argv[2] ?? 'target/debug/weber-servo';
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout);
const results = [];
for (const engine of ['web', 'aot']) {
  const app = await launch({ binary, engine, mode: 'style-contracts', name: `native-style-${engine}` });
  try {
    const complete = await app.waitEvent(event => event.data.stage === 'style-contracts', 'Native CSSOM contracts');
    assert.equal((await app.waitExit()).code, 0);
    assert.equal(complete.data.passed, true);
    if (engine === 'aot') {
      assert.equal(complete.data.runtime.platform.cssFallback, false, 'Native app must not initialize local CSS parser');
      assert.equal(complete.data.runtime.dom.topologyNodes, 0, 'No duplicate low-level DOM topology');
    }
    results.push({ engine, ...complete.data, trace: app.path });
  } finally { await app.stop(); }
}
assert.deepEqual(results[0].cases, results[1].cases);
assert.deepEqual(results[0].values, results[1].values, 'CSS values and observer oldValue/counts match native Servo');
await writeFile('artifacts/native-style.json', JSON.stringify({ passed: true, build, scope: 'Real Servo CSSOM versus Hermes native AOT facade; programmatic DOM, no physical input', results }, null, 2));
console.log(results.map(result => ({ engine: result.engine, cases: result.cases.length, passed: result.passed, platform: result.runtime?.platform })));

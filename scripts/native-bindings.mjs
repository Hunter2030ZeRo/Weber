import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launch, execute } from './native-desktop.mjs';
const binary = process.argv[2] ?? 'target/debug/weber-servo';
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout), results = [];
for (const engine of ['web', 'aot']) {
  const app = await launch({ binary, engine, mode: 'binding-contracts', name: `binary-bindings-${engine}` });
  try {
    const complete = await app.waitEvent(event => event.data.stage === 'binding-contracts', 'Native authoritative DOM and binary wire');
    assert.equal((await app.waitExit()).code, 0); assert.equal(complete.data.passed, true);
    assert.equal(complete.data.cases.length, engine === 'aot' ? 11 : 10);
    if (engine === 'aot') assert.equal(complete.data.malformedRejected, 3);
    results.push({ engine, ...complete.data, trace: app.path });
  } finally { await app.stop(); }
}
for (const key of ['text', 'input', 'checked']) assert.equal(results[0][key], results[1][key]);
assert.deepEqual(results[0].cases, results[1].cases.slice(0, 10));
await writeFile('artifacts/binary-native-bindings.json', JSON.stringify({ passed: true, build, scope: 'Real Servo mutation read through retained native AOT wrappers; JSON disabled in both JS realms during exchange; not physical input', results }, null, 2));
console.log(results.map(result => ({ engine: result.engine, cases: result.cases.length, passed: result.passed })));

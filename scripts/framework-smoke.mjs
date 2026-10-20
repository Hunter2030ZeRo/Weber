import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, execute } from './native-desktop.mjs';
const binary = process.argv[2] ?? 'target/debug/weber-servo';
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout);
const original = process.env.WEBER_APP_TEST;
process.env.WEBER_APP_TEST = '1';
const results = [];
try {
  for (const name of ['counter', 'notes']) for (const engine of ['web', 'aot']) {
    const app = await launch({ binary, application: `target/applications/${name}`, engine, name: `framework-${name}-${engine}` });
    try {
      const tested = await app.waitEvent(event => event.data.stage === 'application-test', 'Independent user application');
      assert.equal(tested.data.passed, true);
      assert.equal(tested.data.remount, true);
      assert.equal((await app.waitExit()).code, 0);
      assert.equal(tested.data.hermesInitialized, engine === 'aot');
      if (engine === 'aot') { assert.equal(tested.data.runtime.platform.cssFallback, false); assert.equal(tested.data.runtime.dom.topologyNodes, 0); assert.equal(tested.data.runtime.listenerErrors.length, 0); }
      results.push({ name, engine, ...tested.data, trace: app.path });
    } finally { await app.stop(); }
  }
  const negative = [];
  const temp = await mkdtemp(join(tmpdir(), 'weber-app-validation-'));
  try {
    for (const change of ['abi', 'hash', 'path']) {
      const directory = join(temp, change); await cp('target/applications/notes', directory, { recursive: true });
      const manifest = JSON.parse(await readFile(join(directory, 'app.json'), 'utf8'));
      if (change === 'abi') manifest.engine.abi = 'incompatible';
      if (change === 'hash') manifest.nativeUnit.sha256 = '0'.repeat(64);
      if (change === 'path') manifest.nativeUnit.file = '../app.so';
      await writeFile(join(directory, 'app.json'), JSON.stringify(manifest));
      let output;
      try { await execute(resolve(binary), ['--app', directory]); assert.fail('Invalid native package accepted'); }
      catch (error) { assert.ok(error.code && error.code !== 0); output = error.stderr; }
      assert.match(output, { abi: /ABI mismatch/, hash: /hash mismatch/, path: /Unsupported native unit path/ }[change]);
      negative.push({ change, rejected: true, output });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  await writeFile('artifacts/framework-smoke.json', JSON.stringify({ passed: true, build, scope: 'Two separately compiled native SHUnits; identical user apps in AOT/web; programmatic DOM tests; package ABI/hash/path rejection', results, negative }, null, 2));
  console.log(results.map(result => ({ app: result.name, engine: result.engine, passed: result.passed })));
} finally {
  if (original === undefined) delete process.env.WEBER_APP_TEST; else process.env.WEBER_APP_TEST = original;
}

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from './source-fingerprint.mjs';
const prefix = process.env.WEBER_REPORT_PREFIX ?? '';
assert.match(prefix, /^[a-zA-Z0-9-]*$/);

assert.ok(process.env.WAYLAND_DISPLAY, 'A live Wayland compositor is required');
const profileBytes = await readFile('compatibility/profile.json');
const profile = JSON.parse(profileBytes);
const profileHash = createHash('sha256').update(profileBytes).digest('hex');
assert.equal(profileHash, (await readFile('compatibility/profile.sha256', 'utf8')).trim());
const sources = await fingerprint();
const build = JSON.parse(execFileSync('target/debug/weber-servo', ['--build-info'], { encoding: 'utf8' }));
assert.equal(build.sourceHash, sources.sourceHash, 'Build is stale relative to current source; rebuild before reporting');
assert.deepEqual(build.revisions, sources.revisions);
const binaryHash = createHash('sha256').update(await readFile('target/debug/weber-servo')).digest('hex');
for (const file of profile.files) assert.equal(createHash('sha256').update(await readFile(`vendor/wpt/${file.path}`)).digest('hex'), file.sha256, file.path);
let latest;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/__api/')) {
      if (path === '/__api/disconnect') { response.destroy(); return; }
      if (path === '/__api/delay') await delay(500);
      if (path === '/__api/json') { response.setHeader('Content-Type', 'application/json'); response.setHeader('X-Weber', 'native-servo'); response.end(JSON.stringify({ value: '한글' })); return; }
      if (path === '/__api/echo') {
        let body = ''; for await (const chunk of request) body += chunk;
        response.statusCode = 201; response.setHeader('X-Request-Test', request.headers['x-test'] ?? ''); response.end(body); return;
      }
      if (path === '/__api/missing') response.statusCode = 404;
      response.end(path === '/__api/invalid-json' ? '{invalid' : 'test'); return;
    }
    if (path === '/__results' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 8 * 1024 * 1024) throw new Error('Report too large'); }
      latest = JSON.parse(body);
      assert.equal(latest.profileHash, profileHash);
      await writeFile(`artifacts/${prefix}compatibility-profile.json`, JSON.stringify(latest, null, 2));
      response.end('ok'); return;
    }
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : 'text/html');
    if (path === '/') { response.end('<!doctype html><meta charset="utf-8"><title>Weber profile</title><div id="aot-dom-root"></div><script type="module" src="/driver.js"></script>'); return; }
    if (path.startsWith('/__any/')) {
      const index = Number(path.slice('/__any/'.length)), file = profile.tests[index];
      assert.ok(file?.endsWith('.js'));
      response.end(`<!doctype html><meta charset="utf-8"><script src="/resources/testharness.js"></script><script src="/resources/testharnessreport.js"></script><script src="/wpt/${file}"></script>`); return;
    }
    let file;
    if (path === '/driver.js') file = 'scripts/profile-page.js';
    else if (path === '/profile.json') file = 'compatibility/profile.json';
    else if (path === '/profile.sha256') file = 'compatibility/profile.sha256';
    else {
      const relative = path.startsWith('/wpt/') ? path.slice(5) : path.slice(1);
      assert.ok(profile.files.some(file => file.path === relative), 'Only locked WPT files are served');
      file = `vendor/wpt/${relative}`;
    }
    response.end(await readFile(resolve(file)));
  } catch (error) { response.statusCode = 404; response.end(String(error)); }
});
await new Promise(resolve => server.listen(5189, '127.0.0.1', resolve));
const env = { ...process.env, RUST_LOG: 'info' }; delete env.DISPLAY;
const log = openSync('artifacts/profile-native.log', 'w');
const app = spawn('target/debug/weber-servo', ['http://127.0.0.1:5189/'], { env, stdio: ['ignore', log, log] });
try {
  const exit = await Promise.race([
    new Promise((resolve, reject) => { app.once('error', reject); app.once('exit', (code, signal) => resolve({ code, signal })); }),
    delay(240000, undefined, { ref: false }).then(() => { throw new Error('Profile native deadline exceeded'); }),
  ]);
  assert.equal(exit.code, 0, 'Native host exited cleanly');
  assert.equal(latest?.cases.length, profile.tests.length, 'Every locked file was attempted');
  latest.build = { ...build, binaryHash, hermesUnitCapacityPatch: 'patches/hermes-unit-capacity.patch' };
  latest.input = 'programmatic DOM events; physical devices are not covered';
  const verify = (name, callback) => {
    try { const evidence = callback(); latest.scenarios[name] = { status: 'PASS', evidence }; }
    catch (error) { latest.scenarios[name] = { status: 'FAIL', error: String(error) }; }
  };
  for (const [name, flag, count] of [['browser-dom-30', '--browser-contract-self-test', 30], ['solid-aot-7', '--solid-self-test', 7], ['scheduler-aot-9', '--scheduler-self-test', 9]]) {
    verify(name, () => {
      const result = JSON.parse(execFileSync('target/debug/weber-servo', [flag], { env, encoding: 'utf8', timeout: 15000 }));
      assert.equal(result.passed, true); assert.equal(result.cases.length, count);
      return { nativeAot: result };
    });
  }
  verify('legacy-dom', () => {
    const output = execFileSync('target/hermes/bin/shermes', ['-O', '-Xes6-block-scoping', '-exec', 'aot/dom.js', 'aot/dom.test.js'], { env, encoding: 'utf8', timeout: 30000 });
    assert.match(output, /AOT DOM lifetime tests passed/);
    execFileSync(process.execPath, ['scripts/wayland-smoke.mjs'], { env: { ...env, WEBER_DOM_TEST: '1' }, timeout: 45000 });
    return { lifetime: output.trim(), nativeWayland: 'artifacts/dom-binding.json' };
  });
  verify('wayland-solid-scheduling', () => {
    execFileSync(process.execPath, ['scripts/wayland-smoke.mjs'], { env: { ...env, WEBER_SOLID_TEST: '1' }, timeout: 45000 });
    return { nativeWayland: 'artifacts/solid-aot.json' };
  });
  const passes = result => result?.complete && !result.error && result.harness?.status === 0 && result.tests?.length > 0 && result.tests.every(test => test.status === 0);
  const functional = latest.cases.every((entry, index) => entry.file === profile.tests[index] && passes(entry.servo) && passes(entry.aot) && entry.aot.profileHash === profileHash && entry.aot.tests.length === entry.servo.tests.length) && profile.mandatory_scenarios.every(name => latest.scenarios[name]?.status === 'PASS') && !latest.scenarioError && !latest.listenerErrors?.length;
  latest.checks = { build: 'PASS', types: 'NOT_RUN', lint: 'NOT_RUN', format: 'NOT_RUN' };
  if (functional) {
    for (const [name, command, args] of [['types', 'pnpm', ['--dir', 'app', 'run', 'build']], ['lint', 'cargo', ['clippy', '--locked', '--no-deps', '--', '-D', 'warnings']], ['format', 'cargo', ['fmt', '--check', '--package', 'weber-servo']]]) {
      const log = openSync(`artifacts/profile-${name}.log`, 'w');
      try { execFileSync(command, args, { env, timeout: 600000, stdio: ['ignore', log, log] }); latest.checks[name] = 'PASS'; }
      catch (error) { latest.checks[name] = 'FAIL'; }
      finally { closeSync(log); }
    }
  }
  latest.passed = functional && Object.values(latest.checks).every(status => status === 'PASS');
  assert.deepEqual(await fingerprint(), sources, 'Sources changed during compatibility run');
  await writeFile(`artifacts/${prefix}compatibility-profile.json`, JSON.stringify(latest, null, 2));
  console.log(latest.cases.map(entry => ({ file: entry.file, ...Object.fromEntries(['servo', 'aot'].map(engine => [engine, entry[engine]?.error ?? `${entry[engine]?.tests?.filter(test => test.status === 0).length}/${entry[engine]?.tests?.length}; complete=${entry[engine]?.complete}; harness=${entry[engine]?.harness?.status}`])) })));
  assert.equal(latest.passed, true, 'Fixed compatibility target remains incomplete; see artifacts/compatibility-profile.json');
} finally {
  if (app.exitCode === null) app.kill();
  await new Promise(resolve => server.close(resolve));
}

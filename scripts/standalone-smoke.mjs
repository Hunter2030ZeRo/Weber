import { spawn } from 'node:child_process';
import { readFile, writeFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { requireSession, execute } from './native-desktop.mjs';
const prefix = process.env.WEBER_REPORT_PREFIX ?? '';
assert.match(prefix, /^[a-zA-Z0-9-]*$/);

await requireSession();

const source = resolve(process.argv[2] ?? 'target/package/weber');
const build = JSON.parse((await execute(join(source, 'weber'), ['--build-info'])).stdout);
const temp = await mkdtemp(join(tmpdir(), 'weber-relocated-'));
const artifacts = resolve('artifacts');
const results = [];
try {
  await cp(source, join(temp, 'app'), { recursive: true });
  const binary = join(temp, 'app/weber');
  for (const engine of ['aot', 'web']) {
    const telemetry = join(artifacts, `${prefix}standalone-${engine}.jsonl`), capture = join(artifacts, `${prefix}standalone-${engine}.png`);
    await writeFile(telemetry, '');
    const env = { ...process.env, PATH: '/usr/bin:/bin', RUST_LOG: 'info', WEBER_TELEMETRY: telemetry,
      WEBER_DESKTOP_CONFIG: JSON.stringify({ mode: 'smoke' }), WEBER_SMOKE_CAPTURE: capture };
    for (const key of ['DISPLAY', 'LD_LIBRARY_PATH', 'NODE_PATH', 'NODE_OPTIONS', 'WEBER_BENCH']) delete env[key];
    const log = openSync(join(artifacts, `${prefix}standalone-${engine}.log`), 'w');
    const app = spawn(binary, engine === 'web' ? ['--web'] : [], { cwd: tmpdir(), env, stdio: ['ignore', log, log] });
    try {
      const exit = await Promise.race([
        new Promise((resolve, reject) => { app.once('error', reject); app.once('exit', (code, signal) => resolve({ code, signal })); }),
        delay(30000, undefined, { ref: false }).then(() => { throw new Error('Relocated desktop timed out'); }),
      ]);
      assert.equal(exit.code, 0);
      const events = (await readFile(telemetry, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(events.filter(event => ['error', 'failure'].includes(event.data.stage)).length, 0, 'No desktop errors');
      const smoke = events.find(event => event.data.stage === 'smoke');
      assert.equal(smoke?.data.passed, true, 'Complete desktop navigation, app input and scroll');
      assert.equal(smoke.data.hermesInitialized, engine === 'aot', 'Web comparison must not initialize a Hermes heap');
      assert.ok(events.some(event => event.data.stage === 'first-app-present'), 'Native presentation after app readiness');
      assert.ok((await readFile(capture)).length > 1000);
      if (engine === 'aot') {
        assert.equal(smoke.data.runtime.listenerErrors.length, 0);
        assert.ok(smoke.data.runtime.wrappers <= smoke.data.before.wrappers + 20, 'Navigation retains only its new template cache, not the old UI tree');
      }
      results.push({ engine, passed: true, telemetry, capture, initial: events.find(event => event.data.stage === 'ready').data.snapshot, ...smoke.data });
    } finally { if (app.exitCode === null) app.kill(); }
  }
  for (const key of ['title', 'count', 'text', 'input', 'rows', 'layout']) assert.deepEqual(results[0].initial[key], results[1].initial[key], `Same desktop ${key}`);
  await writeFile(join(artifacts, `${prefix}standalone-smoke.json`), JSON.stringify({ passed: true, build, display: process.env.WEBER_TEST_DISPLAY ?? 'desktop session', relocated: true, cwd: tmpdir(), backend: 'Wayland; DISPLAY/LD_LIBRARY_PATH unset', input: 'programmatic DOM events; native/IME tests are separate', results }, null, 2));
  console.log(results.map(result => ({ engine: result.engine, passed: result.passed, nodes: result.snapshot.nodes })));
} finally { await rm(temp, { recursive: true, force: true }); }

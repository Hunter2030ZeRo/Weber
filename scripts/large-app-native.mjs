import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { launch, execute, waitFor } from './native-desktop.mjs';

assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'), 'Run inside scripts/headless-wayland.mjs on its private bus/display');
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'), 'Never use the host session bus');
const baseline = process.argv.slice(2).includes('--record-baseline');
const suite = process.argv.find(arg => arg.startsWith('--suite='))?.slice(8) ?? 'large-app';
assert.ok(['large-app', 'range', 'wrapping'].includes(suite));
assert.ok(process.argv.slice(2).every(arg => ['--record-baseline', '--suite=range', '--suite=wrapping'].includes(arg)), 'Supported options: --record-baseline --suite=range --suite=wrapping');
const binary = resolve(process.env.WEBER_HOST || 'target/optimized/release/weber-servo');
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout);
assert.equal(build.uiEngine, 'spidermonkey'); assert.equal(build.aotAvailable, false);
const fixture = JSON.parse(await readFile(`artifacts/${suite}/workflow.json`));
const profileBytes = await readFile(`compatibility/${suite}/profile.json`), profile = JSON.parse(profileBytes);
assert.equal(fixture.profileSha256, createHash('sha256').update(profileBytes).digest('hex')); assert.equal(fixture.passed, true);
assert.equal(fixture.profileSha256, (await readFile(`compatibility/${suite}/profile.sha256`, 'utf8')).trim());
for (const [file, expected] of Object.entries(profile.sources)) assert.equal(createHash('sha256').update(await readFile(join('compatibility', suite, file))).digest('hex'), expected, `Locked workload source changed: ${file}`);
const manifest = JSON.parse(await readFile(join(fixture.application, 'app.json')));
const html = '<!doctype html><meta charset="utf-8"><div id="aot-dom-root"></div><script src="/web.js"></script><script>WeberUserApp.mount(document.getElementById("aot-dom-root"));</script>';
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    const file = manifest.assets[path]; if (!file) { response.writeHead(404).end(); return; }
    // Normal HTTP control origin: intentional correct MIME for the exact same
    // bytes, to distinguish engine failures from the packaged SDK's metadata.
    const mime = path.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : path.endsWith('.wasm') ? 'application/wasm' : file.mime;
    response.writeHead(200, { 'Content-Type': mime }); response.end(await readFile(join(fixture.application, file.file)));
  } catch { response.writeHead(500).end(); }
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const url = `http://127.0.0.1:${server.address().port}/`;
const runs = [];
const output = `artifacts/${suite}/native.json`;
await writeFile(output, JSON.stringify({ passed: false, profile: profile.id, build, runs }));
try {
  for (const mode of ['http', 'packaged']) {
    let app;
    try {
      app = await launch({ binary, engine: 'web', name: `${suite}-${mode}`, ...(mode === 'packaged' ? { application: fixture.application } : { url }) });
      const event = await waitFor(async () => {
        const events = await app.events(), result = events.find(event => event.data.stage === 'large-app-result');
        if (result) return result;
        const log = await readFile(`artifacts/${suite}-${mode}.log`, 'utf8');
        if (/panicked at/.test(log)) throw new Error(`Servo panicked during ${events.filter(event => event.data.stage === 'large-app-case-start').at(-1)?.data.id ?? 'startup'}; see artifacts/${suite}-${mode}.log`);
        if (app.child.exitCode !== null) throw new Error(`Native host exited before results: ${app.child.exitCode}`);
        return null;
      }, `${mode} compatibility result`, profile.required.length * profile.timeoutMs + 15000);
      const result = event.data;
      assert.equal(result.profile, profile.id); assert.deepEqual(result.results.map(result => result.id), profile.required);
      assert.ok(result.results.every(result => ['pass', 'fail'].includes(result.status)));
      await app.waitEvent(event => event.data.stage === 'first-app-present', `${mode} native presentation`);
      const exit = await app.waitExit(); assert.equal(exit.code, 0);
      runs.push({ mode, ...result, trace: app.path, passed: result.results.every(result => result.status === 'pass') });
      console.log(`${mode}: ${result.results.filter(result => result.status === 'pass').length}/${profile.required.length} selected primitives passed`);
    } catch (error) {
      const partial = app ? (await app.events()).filter(event => event.data.stage === 'large-app-case').map(event => event.data) : [];
      runs.push({ mode, passed: false, complete: false, error: String(error), results: partial, trace: app?.path });
      console.log(`${mode}: incomplete/failed — ${String(error)}`);
    } finally { if (app) await app.stop(); }
  }
  const passed = runs.every(run => run.passed);
  await writeFile(output, JSON.stringify({ passed, recordedBaseline: baseline, profile: profile.id, profileSha256: fixture.profileSha256, build, assets: fixture.assets, display: process.env.WEBER_TEST_DISPLAY, runs, scope: 'Actual Servo/SpiderMonkey native windows on a private headless Wayland display. HTTP control versus packaged app using identical asset bytes. Selected primitive behavior only; not Monaco/VS Code/Electron/Node compatibility, physical input, IME, performance or OS sandbox certification.' }, null, 2));
  if (!baseline) assert.equal(passed, true, `Compatibility gate failed; see ${output}`);
} finally { await new Promise(done => server.close(done)); }

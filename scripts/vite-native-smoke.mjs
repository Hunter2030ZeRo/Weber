import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launch, execute, waitFor, readEvents, delay } from './native-desktop.mjs';

const workflow = JSON.parse(await readFile('artifacts/vite-workflow.json'));
const { project, binary, build } = workflow;
const results = [], originalTest = process.env.WEBER_APP_TEST;
const originalLD = process.env.LD_LIBRARY_PATH;
process.env.WEBER_APP_TEST = '1'; delete process.env.LD_LIBRARY_PATH;
try {
  for (const [name, engine] of [['package-jit', 'aot'], ['package-aot', 'aot'], ['package-aot', 'web']]) {
    const app = await launch({ binary: join(project, name, 'weber'), application: join(project, name, 'application'), engine, name: `vite-${name}-${engine}` });
    try {
      const event = await app.waitEvent(event => event.data.stage === 'application-test', 'Packaged independent Vite app');
      assert.equal(event.data.passed, true); assert.equal(event.data.remount, true);
      assert.equal(event.data.hermesInitialized, name === 'package-aot' && engine === 'aot');
      assert.equal((await app.waitExit()).code, 0);
      results.push({ name, engine: event.data.engine, passed: true, data: event.data, trace: app.path });
    } finally { await app.stop(); }
  }
  const temp = await mkdtemp(join(tmpdir(), 'weber-vite-manifest-'));
  const negative = [];
  for (const change of ['partial-engine', 'partial-unit', 'asset-hash', 'asset-path']) {
    const directory = join(temp, change); await cp(join(project, 'package-jit/application'), directory, { recursive: true });
    const manifest = JSON.parse(await readFile(join(directory, 'app.json')));
    if (change === 'partial-engine') manifest.engine = { abi: 'invalid', hermesRevision: 'invalid' };
    if (change === 'partial-unit') manifest.nativeUnit = { file: 'app.so', sha256: '0'.repeat(64) };
    if (change === 'asset-hash') manifest.assets['/web.js'].sha256 = '0'.repeat(64);
    if (change === 'asset-path') manifest.assets['/web.js'].file = '../web.js';
    await writeFile(join(directory, 'app.json'), JSON.stringify(manifest));
    await assert.rejects(execute(binary, ['--app', directory]), error => error.code !== 0 && (change.startsWith('partial') ? /provided together/.test(error.stderr) : /hash mismatch|Invalid application file path/.test(error.stderr)));
    negative.push({ change, rejected: true });
  }
  delete process.env.WEBER_APP_TEST;
  const sourcePath = join(project, 'src/main.tsx'), configPath = join(project, 'vite.config.mjs');
  const source = await readFile(sourcePath, 'utf8'), config = await readFile(configPath, 'utf8');
  const css = await readFile(join(project, 'src/style.css'), 'utf8');
  const probeFile = resolve('artifacts/vite-dev-probes.jsonl'), commandFile = resolve('artifacts/vite-dev-command.json');
  const telemetry = resolve('artifacts/vite-dev-host.jsonl');
  await writeFile(probeFile, ''); await writeFile(telemetry, ''); await writeFile(commandFile, '{}');
  const probePlugin = `{ name: 'native-vite-probe', configureServer(server) { server.middlewares.use('/__weber_probe', (req, res) => { const data = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams); appendFileSync(${JSON.stringify(probeFile)}, JSON.stringify(data)+'\\n'); res.setHeader('Content-Type','application/json'); res.end(readFileSync(${JSON.stringify(commandFile)})); }); } }`;
  await writeFile(configPath, `import { appendFileSync, readFileSync } from 'node:fs';\n` + config.replace('plugins: [weber(),', `plugins: [weber(), ${probePlugin},`));
  const observer = `
window.addEventListener('error', event => fetch('/__weber_probe?' + new URLSearchParams({ error: String(event.error ?? event.message) })));
window.addEventListener('unhandledrejection', event => fetch('/__weber_probe?' + new URLSearchParams({ error: String(event.reason) })));
const timer = setInterval(() => {
  const button = document.getElementById('counter'), label = document.getElementById('label');
  if (!button || !label) return;
  if (!document.documentElement.dataset.weberPage) {
    document.documentElement.dataset.weberPage = String(Math.random());
    (window as any).weberHostCall?.(JSON.stringify({ action: 'telemetry', data: { stage: 'ready', scope: 'vite-development' } }));
  }
  const page = document.documentElement.dataset.weberPage;
  const state = { label: label.textContent ?? '', count: button.textContent ?? '', color: getComputedStyle(label).color, page, origin: location.origin };
  fetch('/__weber_probe?' + new URLSearchParams(state)).then(r => r.json()).then(command => {
    if (command.id && document.documentElement.dataset.weberCommand !== command.id) {
      document.documentElement.dataset.weberCommand = command.id;
      if (command.action === 'click') button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (command.action === 'close') location.href = 'weber://close';
    }
  });
}, 200);
if (import.meta.hot) import.meta.hot.dispose(() => clearInterval(timer));
`;
  await writeFile(sourcePath, source.replace('function Counter()', 'export default function Counter()').replace('export default export default', 'export default') + observer);
  let output = '', child, finished = false;
  const logPath = resolve('artifacts/vite-dev.log');
  try {
    const log = openSync(logPath, 'w');
    child = spawn('npm', ['run', 'dev'], { cwd: project, detached: true, env: { ...process.env, WEBER_HOST: binary, WEBER_TELEMETRY: telemetry }, stdio: ['ignore', log, log] }); closeSync(log);
    const completion = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => { finished = true; resolveExit({ code, signal }); }); }); completion.catch(() => {});
    const probes = async () => (await readFile(probeFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const first = await waitFor(async () => (await probes()).find(probe => probe.label === 'config/dependency/alias/plugin/env'), 'Vite page in actual Servo window', 30000);
    await writeFile(commandFile, JSON.stringify({ id: 'click', action: 'click' }));
    await waitFor(async () => (await probes()).find(probe => probe.count === 'Count: 1'), 'Solid button update');
    await writeFile(join(project, 'src/style.css'), css + '\n#label { color: rgb(12, 34, 56); }\n');
    const styled = await waitFor(async () => (await probes()).find(probe => probe.color === 'rgb(12, 34, 56)'), 'Native CSS HMR');
    assert.equal(styled.page, first.page); assert.equal(styled.count, 'Count: 1');
    const currentSource = await readFile(sourcePath, 'utf8');
    await writeFile(sourcePath, currentSource.replace('"__PLUGIN_LABEL__"', '"changed"'));
    const updated = await waitFor(async () => (await probes()).find(probe => probe.label === 'config/dependency/alias/changed/env'), 'Native TSX change propagation', 30000);
    assert.equal(updated.page, first.page);
    await writeFile(commandFile, JSON.stringify({ id: 'close', action: 'close' }));
    await waitFor(() => finished, 'Host closes and Vite exits', 15000);
    assert.equal((await completion).code, 0);
    const url = first.origin; assert.ok(url);
    await assert.rejects(fetch(url));
    const events = await readEvents(telemetry); assert.ok(events.some(event => event.data.stage === 'first-app-present'));
    assert.equal(events.find(event => event.data.stage === 'ready').data.hermesInitialized, false);
    assert.equal((await probes()).filter(probe => probe.error).length, 0);
    assert.match(await readFile(logPath, 'utf8'), /\[vite\] hot updated: \/src\/main.tsx/);
    results.push({ name: 'npm run dev in real Servo/Wayland', passed: true, first, styled, updated, cssHmrPreservesPageAndState: true, tsxUpdatePreservesPage: updated.page === first.page, serverClosedWithWindow: true, trace: telemetry });
    await writeFile(join(project, 'src/style.css'), css);
    // A missing native executable must also close the listening dev server.
    const failurePath = resolve('artifacts/vite-dev-missing-host.log'), failureLog = openSync(failurePath, 'w');
    const missing = spawn(process.execPath, [resolve('sdk/cli.mjs'), 'dev', project], { env: { ...process.env, WEBER_HOST: '/nonexistent/weber-host' }, stdio: ['ignore', failureLog, failureLog] }); closeSync(failureLog);
    let failureTimer;
    const missingCode = await Promise.race([new Promise(done => missing.once('close', done)), new Promise(done => { failureTimer = setTimeout(() => { if (missing.exitCode === null) missing.kill(); done('timeout'); }, 15000); })]); clearTimeout(failureTimer);
    assert.equal(missingCode, 1);
    const failed = await readFile(failurePath, 'utf8'); assert.match(failed, /ENOENT/);
    const failedUrl = failed.match(/Weber development \(SpiderMonkey\): (http:\/\/\S+)/)?.[1]; assert.ok(failedUrl); await assert.rejects(fetch(failedUrl));
    results.push({ name: 'missing host exits and closes dev server', passed: true });
    await writeFile(commandFile, '{}'); await writeFile(probeFile, '');
    const signalPath = resolve('artifacts/vite-dev-interrupt.log'), signalLog = openSync(signalPath, 'w');
    const interrupted = spawn(process.execPath, [resolve('sdk/cli.mjs'), 'dev', project], { env: { ...process.env, WEBER_HOST: binary }, stdio: ['ignore', signalLog, signalLog] }); closeSync(signalLog);
    let interruptedExit;
    const interruptedDone = new Promise(done => interrupted.once('close', code => { interruptedExit = { code }; done(code); }));
    try {
      const running = await waitFor(async () => (await probes()).find(probe => probe.label), 'Second owned Vite window');
      const descendants = (await readFile(`/proc/${interrupted.pid}/task/${interrupted.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
      interrupted.kill('SIGINT');
      await waitFor(() => interruptedExit, 'SIGINT cleanup'); assert.equal(await interruptedDone, 0);
      await assert.rejects(fetch(running.origin));
      for (const pid of descendants) await assert.rejects(readFile(`/proc/${pid}/stat`));
      results.push({ name: 'SIGINT closes owned host, Vite and helper processes', passed: true });
    } finally { if (!interruptedExit) { interrupted.kill('SIGTERM'); await interruptedDone; } }
  } finally {
    if (child && !finished) {
      // The test fixture's owned window closes itself through its next probe.
      await writeFile(commandFile, JSON.stringify({ id: 'cleanup', action: 'close' })); await delay(1000);
      if (!finished) process.kill(-child.pid, 'SIGTERM');
    }
    output = await readFile(logPath, 'utf8');
    await writeFile(sourcePath, source); await writeFile(configPath, config);
    await writeFile(join(project, 'src/style.css'), css);
  }
  await writeFile('artifacts/vite-native-workflow.json', JSON.stringify({ passed: true, build, results, negative, display: process.env.WEBER_TEST_DISPLAY ?? process.env.WAYLAND_DISPLAY, scope: 'Actual native Servo renderer on Wayland; programmatic button/DOM probes and CSS/TSX editing. Not physical input or desktop performance evidence.' }, null, 2));
  console.log(JSON.stringify({ passed: true, results: results.map(({ name, passed, tsxUpdatePreservesPage }) => ({ name, passed, tsxUpdatePreservesPage })) }, null, 2));
} finally {
  if (originalTest === undefined) delete process.env.WEBER_APP_TEST; else process.env.WEBER_APP_TEST = originalTest;
  if (originalLD === undefined) delete process.env.LD_LIBRARY_PATH; else process.env.LD_LIBRARY_PATH = originalLD;
}

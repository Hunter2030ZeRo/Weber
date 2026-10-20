import assert from 'node:assert/strict';
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { launch, execute, waitFor, readEvents } from './native-desktop.mjs';
const workflow = JSON.parse(await readFile('artifacts/npm-distribution.json', 'utf8'));
const destination = resolve('target/package/weber-npm-notes');
await mkdir(destination, { recursive: true });
await cp(join(workflow.project, 'package'), destination, { recursive: true });
const binary = join(destination, 'weber'), application = join(destination, 'application');
const info = JSON.parse((await execute(binary, ['--build-info'])).stdout);
assert.deepEqual(info, workflow.runtime); assert.equal(info.aotAvailable, false);
const savedPath = process.env.PATH;
process.env.PATH = '/weber-no-node-or-bun';
// Session lock checking belongs to the private compositor harness, not PATH.
const savedDesktop = process.env.XDG_CURRENT_DESKTOP;
delete process.env.XDG_CURRENT_DESKTOP;
const results = [];
try {
  for (const stage of ['npm-notes-pass', 'npm-notes-restored']) {
    const app = await launch({ binary, application, engine: 'web', name: stage });
    try {
      const event = (await app.waitEvent(event => event.data.stage === stage, stage, 40000)).data;
      assert.equal(event.passed, true); assert.equal(event.hermesInitialized, false);
      assert.equal((await app.waitExit()).code, 0); results.push({ stage, event, trace: app.path });
    } finally { await app.stop(); }
  }
} finally {
  process.env.PATH = savedPath;
  if (savedDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP; else process.env.XDG_CURRENT_DESKTOP = savedDesktop;
}
const entry = join(workflow.project, 'src/main.tsx'), original = await readFile(entry, 'utf8');
const probe = String.raw`
const timer=setInterval(()=>{if(document.getElementById('status')?.textContent==='Loaded'){
 clearInterval(timer);(window as any).weberHostCall(JSON.stringify({action:'telemetry',data:{stage:'npm-dev',value:'before'}}));
}},50);
if(import.meta.hot)import.meta.hot.dispose(()=>clearInterval(timer));`;
const devTrace = resolve('artifacts/npm-dev.jsonl'); await writeFile(devTrace, '');
const devLog = openSync(resolve('artifacts/npm-dev.log'), 'w');
await writeFile(entry, original + probe);
const env = { ...process.env, WEBER_TELEMETRY: devTrace }; delete env.WEBER_HOST;
const child = spawn('npm', ['run', 'dev'], { cwd: workflow.project, env, detached: true, stdio: ['ignore', devLog, devLog] }); closeSync(devLog);
let exited = false;
const completion = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => { exited = true; done(code); }); });
completion.catch(() => {});
const devEvent = value => waitFor(async () => {
  if (exited) throw new Error('npm run dev exited early; see artifacts/npm-dev.log');
  return (await readEvents(devTrace)).find(event => event.data.stage === 'npm-dev' && event.data.value === value);
}, `installed Vite HMR ${value}`, 40000);
try {
  await devEvent('before');
  await writeFile(entry, original + probe.replace("value:'before'", "value:'after'"));
  await devEvent('after');
  results.push({ stage: 'npm-dev-hmr', passed: true, trace: devTrace });
} finally {
  if (!exited) process.kill(-child.pid, 'SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 4000);
  try { await completion; } finally { clearTimeout(timer); await writeFile(entry, original); }
}
// Keep a normal, non-instrumented Notes package available for manual use.
const production = resolve('target/package/weber-notes-npm');
await execute(process.execPath, [join(workflow.project, 'node_modules/@weber/sdk/cli.mjs'), 'package', join(workflow.project, 'dist'), production], { env, maxBuffer: 1024 * 1024 });
await writeFile('artifacts/npm-distribution-native.json', JSON.stringify({ passed: true, binary, application, production, runtime: info, sdkVersion: workflow.sdkVersion, display: process.env.WEBER_TEST_DISPLAY, scope: 'Installed tarballs -> relocated package -> two real Wayland launches with no Node/Bun on PATH; programmatic input, Save/Reload/New window, persisted restart; npm run dev in installed SDK and actual Vite HMR update. No physical keyboard/IME, Windows/macOS, clean OS or performance claim.', results }, null, 2));
console.log('Installed npm package native gates passed');

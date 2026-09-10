'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.WEBER_MONACO_RESULT || 'out/monaco.json');
const electron = process.env.WEBER_MONACO_ELECTRON;
const environment = { ...process.env, WEBER_MONACO_RESULT: output };
delete environment.WEBER_ENTRY;
delete environment.ELECTRON_RUN_AS_NODE;
fs.rmSync(output, { force: true });
const child = spawn(electron || process.execPath,
  electron ? ['--no-sandbox', __dirname] : [path.join(root, 'weber/electron-runtime/bootstrap.cjs'), __dirname],
  { env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
let tail = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', bytes => { tail = (tail + bytes).slice(-32768); });
}
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 110000);
child.once('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 2; });
child.once('exit', (code, signal) => {
  clearTimeout(timer);
  // Reap any host/renderers left after a failed app bootstrap. This process
  // group was created for this one probe and contains no unrelated processes.
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  let report;
  if (fs.existsSync(output)) report = JSON.parse(fs.readFileSync(output));
  else report = { kind: 'standalone-monaco-diagnostic', version: '0.52.2', ready: false,
    vscodeReady: false, checks: [], error: 'Application exited without completing Monaco checks' };
  Object.assign(report, { framework: electron ? 'electron' : 'weber', sourceCommit: process.env.GITHUB_SHA || null,
    exitCode: code, signal, timedOut, outputTail: tail });
  if (code !== 0 || timedOut) report.ready = false;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});

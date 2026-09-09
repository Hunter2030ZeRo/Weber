'use strict';
// The exact same application file is executed by Electron and Weber.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { once } = require('node:events');

const prefix = 'WEBER_BENCHMARK ';
const send = value => process.stdout.write(prefix + JSON.stringify(value) + '\n');
const commands = [];
const waiters = [];
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (waiters.length) waiters.shift()(message);
  else commands.push(message);
});
const receive = () => commands.length ? Promise.resolve(commands.shift()) : new Promise(resolve => waiters.push(resolve));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

ipcMain.handle('benchmark:add', (_event, left, right) => left + right);
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { send({ phase: 'error', error: 'Benchmark application timed out' }); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  const options = { width: 768, height: 512, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: false } };
  const first = new BrowserWindow({ ...options, title: 'Benchmark A' });
  const second = new BrowserWindow({ ...options, title: 'Benchmark B' });
  const windows = [first, second];
  const firstPaint = windows.map(window => once(window, 'ready-to-show'));
  send({ phase: 'progress', stage: 'windows-created' });
  await Promise.all(windows.map(window => window.loadFile('index.html')));
  send({ phase: 'progress', stage: 'documents-loaded' });
  // Loading completion does not guarantee a compositor surface. Both runtimes
  // follow the same first-render / show / animation-frame sequence before PNG.
  await Promise.all(firstPaint);
  send({ phase: 'progress', stage: 'first-render-ready' });
  for (const window of windows) {
    const shown = once(window, 'show');
    window.show();
    await shown;
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    const png = (await window.capturePage()).toPNG();
    assert.deepEqual(png.subarray(0, 8), pngMagic);
  }
  send({ phase: 'ready', versions: { ...process.versions }, windows: windows.length,
    viewport: { width: options.width, height: options.height }, rendererPids: windows.map(window => window.webContents.getOSProcessId()) });
  assert.equal((await receive()).command, 'measure');
  for (const window of windows) {
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".row").length'), 100);
  }

  const roundTrips = [];
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    assert.equal(await first.webContents.executeJavaScript(`Promise.resolve(${index} + 1)`), index + 1);
    roundTrips.push(performance.now() - start);
  }
  const ipcRoundTrips = [];
  for (let index = 0; index < 15; index++) {
    const start = performance.now();
    assert.equal(await first.webContents.executeJavaScript(`benchmark.add(${index}, 1)`), index + 1);
    ipcRoundTrips.push(performance.now() - start);
  }
  const domAndCapture = [];
  let previousHash;
  for (let index = 0; index < 10; index++) {
    const start = performance.now();
    await first.webContents.executeJavaScript(`document.getElementById('counter').textContent = '${index + 1}'; document.getElementById('indicator').style.width = '${120 + index * 4}px'; true`);
    const png = (await first.capturePage()).toPNG();
    domAndCapture.push(performance.now() - start);
    assert.deepEqual(png.subarray(0, 8), pngMagic);
    const hash = createHash('sha256').update(png).digest('hex');
    if (previousHash) assert.notEqual(hash, previousHash, 'The captured image did not reflect a DOM update');
    previousHash = hash;
  }
  assert.equal(await second.webContents.executeJavaScript('document.getElementById("counter").textContent'), '0');
  send({ phase: 'workload', javascriptRoundTripMs: roundTrips,
    ipcRoundTripMs: ipcRoundTrips, domUpdateAndCaptureMs: domAndCapture });
  await delay(500);
  send({ phase: 'idle-ready' });
  assert.equal((await receive()).command, 'finish');
  clearTimeout(deadline);
  send({ phase: 'complete' });
  app.exit(0);
}).catch(error => {
  send({ phase: 'error', error: error.stack || String(error) });
  clearTimeout(deadline);
  app.exit(1);
});

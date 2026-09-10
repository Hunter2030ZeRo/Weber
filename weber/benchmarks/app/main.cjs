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
  // The CI display is 1600 x 900. Keep both windows visible side by side so
  // one window does not cover the other's compositor surface.
  const requestedWindowBounds = [
    { x: 16, y: 16, width: options.width, height: options.height },
    { x: 816, y: 16, width: options.width, height: options.height },
  ];
  windows.forEach((window, index) => window.setBounds(requestedWindowBounds[index]));
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
    viewport: { width: options.width, height: options.height }, requestedWindowBounds,
    reportedWindowBounds: windows.map(window => window.getBounds()),
    rendererPids: windows.map(window => window.webContents.getOSProcessId()) });
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
    await first.webContents.executeJavaScript(`
      document.getElementById('counter').textContent = '${index + 1}';
      document.getElementById('indicator').style.width = '${120 + index * 4}px';
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
    `);
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
  assert.equal((await receive()).command, 'extended');
  // Keep the original measurements above unchanged. This second phase probes
  // concurrent IPC and larger component trees independently of that baseline.
  const ipcBurstMs = [];
  for (let trial = 0; trial < 8; trial++) {
    const start = performance.now();
    const results = await Promise.all(windows.map((window, index) =>
      window.webContents.executeJavaScript(`Promise.all(Array.from({ length: 32 }, (_, n) => benchmark.add(n, ${index * 1000})))`)));
    ipcBurstMs.push(performance.now() - start);
    for (let index = 0; index < results.length; index++) {
      assert.deepEqual(results[index], Array.from({ length: 32 }, (_, n) => n + index * 1000));
    }
  }
  await Promise.all(windows.map(window => window.webContents.executeJavaScript(`
    (() => {
      const rows = document.getElementById('rows');
      for (let index = 100; index < 1000; index++) {
        const row = document.createElement('div');
        row.className = 'row'; row.textContent = 'Component ' + index;
        rows.appendChild(row);
      }
      return document.querySelectorAll('.row').length;
    })()
  `).then(count => assert.equal(count, 1000))));
  const componentUpdateAndCaptureMs = [];
  const previousCaptures = [null, null];
  for (let trial = 0; trial < 6; trial++) {
    const start = performance.now();
    await Promise.all(windows.map(async (window, index) => {
      await window.webContents.executeJavaScript(`
        (() => {
          const rows = document.querySelectorAll('.row');
          for (let n = 0; n < 256; n++) rows[n].textContent = 'Window ${index}, update ${trial}, component ' + n;
          document.getElementById('counter').textContent = 'Components ${index}:${trial}';
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
        })()
      `);
      const png = (await window.capturePage()).toPNG();
      assert.deepEqual(png.subarray(0, 8), pngMagic);
      const hash = createHash('sha256').update(png).digest('hex');
      if (previousCaptures[index]) assert.notEqual(hash, previousCaptures[index]);
      previousCaptures[index] = hash;
    }));
    componentUpdateAndCaptureMs.push(performance.now() - start);
  }
  await delay(500);
  send({ phase: 'extended-ready', ipcBurstMs, componentUpdateAndCaptureMs });
  assert.equal((await receive()).command, 'finish');
  clearTimeout(deadline);
  send({ phase: 'complete' });
  app.exit(0);
}).catch(error => {
  send({ phase: 'error', error: error.stack || String(error) });
  clearTimeout(deadline);
  app.exit(1);
});

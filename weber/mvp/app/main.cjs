// Ordinary Electron imports: no Weber-only module loader or API substitution.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const resultFile = process.env.WEBER_MVP_RESULT;
if (!resultFile) throw new Error('WEBER_MVP_RESULT is required');
const timeout = setTimeout(() => finish(new Error('MVP application timed out')), 45000);
let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  fs.writeFileSync(resultFile, JSON.stringify({ ok: !error, error: error?.stack, version: process.versions.electron }));
  app.exit(error ? 1 : 0);
}
async function run() {
  await app.whenReady();
  ipcMain.handle('mvp:sum', (_event, a, b) => a + b);
  const make = () => new BrowserWindow({ show: true, width: 640, height: 480,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  const first = make(), second = make();
  const firstId = first.id;
  assert.equal(typeof first.id, 'number');
  assert.equal(BrowserWindow.fromId(first.id), first);
  await Promise.all([first.loadFile(path.join(__dirname, 'index.html')), second.loadFile(path.join(__dirname, 'index.html'))]);
  assert.equal(typeof first.webContents.getURL(), 'string');
  assert.equal(await first.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await first.webContents.executeJavaScript('window.mvp.sum(3, 4)'), 7);
  await first.webContents.executeJavaScript("document.getElementById('button').click(); null");
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await first.webContents.executeJavaScript("document.getElementById('result').textContent");
    if (result === '7') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result, '7');
  assert.equal(await second.webContents.executeJavaScript("document.getElementById('result').textContent"), '');
  const capture = await first.webContents.capturePage();
  assert.equal(capture.isEmpty(), false);
  assert.ok(capture.toPNG().length > 100);
  const rendererPid = first.webContents.getOSProcessId();
  assert.ok(rendererPid > 0);
  // On Linux verify actual renderer identity, not a spoofable page UA string.
  const executable = fs.readlinkSync(`/proc/${rendererPid}/exe`);
  assert.equal(path.basename(executable), 'weber-obscura-renderer', 'Window still uses a non-Obscura renderer');
  const args = fs.readFileSync(`/proc/${rendererPid}/cmdline`).toString().split('\0');
  assert.equal(args.includes('--type=renderer'), false, 'Chromium renderer command line detected');
  const closed = once(first, 'closed');
  first.close(); await closed;
  assert.equal(first.isDestroyed(), true);
  assert.equal(BrowserWindow.fromId(firstId), null);
  assert.equal(await second.webContents.executeJavaScript('window.mvp.sum(8, 9)'), 17);
  finish();
}
run().catch(finish);

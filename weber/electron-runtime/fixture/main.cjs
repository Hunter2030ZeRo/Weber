'use strict';
// Ordinary Electron application imports. No alternate framework API is loaded.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const originalFs = require('original-fs');
const nodeOriginalFs = require('node:original-fs');

app.on('window-all-closed', () => {});
ipcMain.handle('test:add', (event, left, right) => {
  assert.equal(event.senderFrame, event.sender.mainFrame);
  return left + right;
});
ipcMain.handle('test:failure', () => { throw new Error('Expected main-process rejection'); });
const deadline = setTimeout(() => finish(new Error('Live Electron-source test timed out')), 90000);
let completed = false;
function finish(error, details = {}) {
  if (completed) return;
  completed = true;
  clearTimeout(deadline);
  fs.writeFileSync(process.env.WEBER_LIVE_RESULT, JSON.stringify({
    ok: !error, error: error?.stack, ...details,
  }, null, 2));
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  // original-fs is a real filesystem API, not an Electron namespace stub.
  // With no ASAR patch installed, all three imports are the same native module.
  assert.equal(originalFs, fs);
  assert.equal(nodeOriginalFs, fs);
  const packageFile = path.join(__dirname, 'package.json');
  const packageContents = fs.readFileSync(packageFile, 'utf8');
  assert.equal(originalFs.readFileSync(packageFile, 'utf8'), packageContents);
  assert.equal(await nodeOriginalFs.promises.readFile(packageFile, 'utf8'), packageContents);
  if (!process.versions.bun) {
    const esm = await import('original-fs');
    const nodeEsm = await import('node:original-fs');
    assert.equal(esm.default, fs);
    assert.equal(nodeEsm.default, fs);
    assert.equal(esm.readFileSync, fs.readFileSync);
    assert.equal(esm.readFileSync(packageFile, 'utf8'), packageContents);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weber-original-fs-'));
  try {
    const archive = path.join(temporary, 'ordinary.asar');
    const bytes = Buffer.from('ordinary file bytes, without archive interpretation');
    fs.writeFileSync(archive, bytes);
    assert.equal(originalFs.statSync(archive).isFile(), true);
    assert.deepEqual(await originalFs.promises.readFile(archive), bytes);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const preferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true };
  const first = new BrowserWindow({ width: 640, height: 480, title: 'First Obscura window', webPreferences: preferences });
  const second = new BrowserWindow({ width: 600, height: 420, title: 'Second Obscura window', webPreferences: preferences });
  // A diagnostic emitted only after the native GTK draw callback ran. App
  // behavior below uses the upstream Electron methods and event contracts.
  const presented = [once(first.webContents, 'weber-first-frame-presented'),
    once(second.webContents, 'weber-first-frame-presented')];
  assert.notEqual(first.id, second.id);
  assert.equal(BrowserWindow.fromId(first.id), first);
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  await Promise.all([first.loadFile('index.html'), second.loadFile('index.html')]);
  await Promise.all(presented);
  assert.match(first.getURL(), /\/index\.html$/);
  assert.equal(await first.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await first.webContents.executeJavaScript('typeof __preloadSecret'), 'undefined');
  assert.equal(await first.webContents.executeJavaScript('weberTest.secret()'), 'visible only inside the isolated preload context');
  assert.equal(await first.webContents.executeJavaScript('weberTest.add(3, 4)'), 7);
  assert.equal(await second.webContents.executeJavaScript('weberTest.add(8, 9)'), 17);
  await assert.rejects(first.webContents.executeJavaScript('weberTest.fail()'), /Expected main-process rejection/);
  assert.equal(await first.webContents.executeJavaScript('Promise.resolve(6 * 7)'), 42);
  assert.equal(await first.webContents.executeJavaScript("document.getElementById('button').click(); document.getElementById('output').textContent"), '1');
  assert.equal(await second.webContents.executeJavaScript("document.getElementById('output').textContent"), '0');
  const capture = await first.capturePage();
  assert.equal(capture.isEmpty(), false);
  assert.deepEqual(capture.toPNG().subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const rendererPids = [first, second].map(win => win.webContents.getOSProcessId());
  assert.notEqual(rendererPids[0], rendererPids[1]);
  const rendererExecutables = rendererPids.map(pid => path.basename(fs.readlinkSync(`/proc/${pid}/exe`)));
  assert.deepEqual(rendererExecutables, ['weber-obscura-renderer', 'weber-obscura-renderer']);
  for (const pid of rendererPids) {
    assert.ok(!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer'));
  }
  const closed = once(first, 'closed');
  first.close();
  await closed;
  assert.equal(first.isDestroyed(), true);
  assert.equal(BrowserWindow.fromId(first.id), null);
  assert.equal(await second.webContents.executeJavaScript('Promise.resolve(17)'), 17);
  finish(null, { rendererPids, rendererExecutables, windowsPresented: 2,
    sourceReuse: ['BrowserWindow', 'BaseWindow', 'WebContents'],
    tested: ['original-fs real filesystem access', ...(process.versions.bun ? [] : ['original-fs ESM named and default exports']), 'original loadFile/loadURL', 'Promise evaluation', 'isolated preload', 'contextBridge function calls', 'ipcMain.invoke round trip and rejection', 'DOM events', 'window isolation', 'native drawing', 'PNG capture', 'close lifecycle'],
    osSandbox: false, privilegedPreload: 'electron bridge subset', fullElectronCompatibility: false });
}).catch(finish);

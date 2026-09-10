'use strict';
// Ordinary Electron application imports. No alternate framework API is loaded.
const { app, BrowserWindow, ipcMain, utilityProcess, MessageChannelMain, crashReporter, contentTracing } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const originalFs = require('original-fs');
const nodeOriginalFs = require('node:original-fs');

app.on('window-all-closed', () => {});
assert.equal(crashReporter.getLastCrashReport(), null);
assert.equal(crashReporter.getUploadToServer(), false);
crashReporter.addExtraParameter('fixture', 'packaged-runtime');
assert.equal(crashReporter.getParameters().fixture, 'packaged-runtime');
crashReporter.removeExtraParameter('fixture');
assert.throws(() => crashReporter.start({ uploadToServer: false }), /native crash collection/);
ipcMain.handle('test:add', (event, left, right) => {
  assert.equal(event.senderFrame, event.sender.mainFrame);
  return left + right;
});
ipcMain.on('test:ping', (event, value) => {
  assert.equal(event.senderFrame, event.sender.mainFrame);
  event.reply('test:pong', value + 1);
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
  const bursts = await Promise.all([first, second].map((window, index) =>
    window.webContents.executeJavaScript(`Promise.all(Array.from({ length: 64 }, (_, n) =>
      weberTest.add(n, ${index * 1000})))`)));
  assert.deepEqual(bursts[0], Array.from({ length: 64 }, (_, n) => n));
  assert.deepEqual(bursts[1], Array.from({ length: 64 }, (_, n) => n + 1000));
  const mixed = await first.webContents.executeJavaScript(`Promise.all(Array.from({ length: 32 }, (_, n) =>
    (n % 2 ? weberTest.fail() : weberTest.add(n, 1)).then(value => ({ value }), error => ({ error: error.message }))))`);
  mixed.forEach((value, n) => n % 2 ? assert.match(value.error, /Expected main-process rejection/) : assert.equal(value.value, n + 1));
  assert.equal(await first.webContents.executeJavaScript('weberTest.ping(40)'), 41);
  assert.equal(await second.webContents.executeJavaScript('weberTest.ping(70)'), 71);
  first.webContents.send('test:push', 1);
  first.webContents.send('test:push', 2);
  // Commands share one ordered owner queue; this observation follows both sends.
  assert.deepEqual(await first.webContents.executeJavaScript('weberTest.pushes()'), [1, 1, 2]);
  assert.deepEqual(await second.webContents.executeJavaScript('weberTest.pushes()'), []);
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
  const utility = utilityProcess.fork(path.join(__dirname, 'utility.cjs'), [], { stdio: 'pipe' });
  utility.stdout.resume(); utility.stderr.resume();
  const utilityExit = once(utility, 'exit');
  const channel = new MessageChannelMain();
  const utilityReply = once(channel.port1, 'message'); channel.port1.start();
  channel.port1.postMessage(41); // Must survive ownership transfer and start.
  utility.postMessage('take-port', [channel.port2]);
  const [{ data: utilityResult }] = await utilityReply;
  assert.equal(utilityResult.answer, 42);
  assert.equal(utilityResult.pid, utility.pid);
  assert.notEqual(utility.pid, process.pid);
  assert.ok(!rendererPids.includes(utility.pid));
  channel.port1.close();
  const stopped = once(utility, 'message'); utility.postMessage('stop');
  assert.equal((await stopped)[0], 'stopped'); assert.equal((await utilityExit)[0], 0);
  finish(null, { rendererPids, rendererExecutables, windowsPresented: 2,
    sourceReuse: ['BrowserWindow', 'BaseWindow', 'WebContents'],
    tested: ['original-fs real filesystem access', ...(process.versions.bun ? [] : ['original-fs ESM named and default exports']), 'original loadFile/loadURL', 'Promise evaluation', 'isolated preload', 'contextBridge function calls', 'ipcMain.invoke round trip and rejection', 'ipcRenderer.send and event.reply', 'webContents.send, once and listener removal', 'DOM events', 'window isolation', 'native drawing', 'PNG capture', 'close lifecycle'],
    utilityProcess: { independentPid: utilityResult.pid, transferredPortRoundTrip: true, cleanExit: true },
    diagnostics: { nativeCrashCollection: false, traceCategories: await contentTracing.getCategories() },
    osSandbox: false, privilegedPreload: 'electron bridge subset', fullElectronCompatibility: false });
}).catch(finish);

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApplication } from '../packages/weber/index.mjs';
const fixture = fileURLToPath(new URL('./fixtures/host.mjs', import.meta.url));
test('queues window calls and restricts renderer IPC to the window allowlist', async t => {
  const { app, BrowserWindow, ipcMain } = createApplication({ hostPath: process.execPath, hostArgs: [fixture] });
  t.after(() => app.dispose());
  ipcMain.handle('system.info', (_event, payload) => ({ echoed: payload.value }));
  ipcMain.handle('forbidden', () => { throw new Error('Must never execute'); });
  assert.throws(() => ipcMain.handle('system.info', () => null), /already registered/);
  const win = new BrowserWindow({ allowedChannels: ['system.info'] });
  await win.loadFile('example.html');
  // FIFO on the private pipe puts ipc.reply before this query after the
  // event-handler microtasks have completed.
  let replies = [];
  for (let i = 0; i < 20 && replies.length < 2; i++) {
    replies = await win.webContents.executeJavaScript('test-query');
  }
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.find(r => r.call === 1).result, { echoed: 42 });
  assert.equal(replies.find(r => r.call === 2).error, 'IPC channel denied');
  assert.ok(replies.every(r => r.epoch === 1));
  await assert.rejects(win.loadURL('https://example.com'), /not implemented/);
  const closed = once(win, 'closed');
  await win.close(); await closed;
  await assert.rejects(win.show(), /closed/);
  await app.quit();
});
test('unsupported Electron options fail explicitly', () => {
  const { BrowserWindow } = createApplication();
  assert.throws(() => new BrowserWindow({ webPreferences: { nodeIntegration: true } }), /Unsupported/);
  assert.throws(() => new BrowserWindow({ allowedChannels: 'all' }), /Invalid/);
});

test('window identity is synchronous and does not reuse a recycled host ID', async t => {
  const { app, BrowserWindow } = createApplication({ hostPath: process.execPath, hostArgs: [fixture, 'reuse-id'] });
  t.after(() => app.dispose());
  let readyEvents = 0;
  app.on('ready', () => { readyEvents++; assert.equal(app.isReady(), true); });
  assert.equal(app.isReady(), false);
  assert.equal(app.whenReady(), app.whenReady());
  await app.whenReady();
  assert.equal(readyEvents, 1);
  const first = new BrowserWindow();
  const firstId = first.id;
  assert.equal(typeof firstId, 'number');
  assert.equal(BrowserWindow.fromId(firstId), first);
  assert.equal(BrowserWindow.fromWebContents(first.webContents), first);
  assert.deepEqual(BrowserWindow.getAllWindows(), [first]);
  assert.throws(() => { first.id = 999; }, TypeError);
  let destroyed = 0;
  first.webContents.on('destroyed', () => {
    destroyed++;
    assert.equal(first.webContents.isDestroyed(), true);
  });
  const closed = once(first, 'closed');
  await first.close(); await closed;
  assert.equal(destroyed, 1);
  assert.equal(first.isDestroyed(), true);
  assert.equal(BrowserWindow.fromId(firstId), null);
  assert.equal(BrowserWindow.fromWebContents(first.webContents), null);
  assert.throws(() => first.webContents.getURL(), /closed/);
  const second = new BrowserWindow();
  assert.notEqual(second.id, firstId);
  await second.ready;
  assert.deepEqual(BrowserWindow.getAllWindows(), [second]);
  await second.close();
  await app.quit();
});

test('loadFile resolves void and publishes a synchronous URL before did-finish-load', async t => {
  const { app, BrowserWindow } = createApplication({ hostPath: process.execPath, hostArgs: [fixture] });
  t.after(() => app.dispose());
  const win = new BrowserWindow();
  assert.equal(win.webContents.getURL(), '');
  let finished = 0;
  win.webContents.on('did-finish-load', () => {
    finished++;
    assert.equal(typeof win.webContents.getURL(), 'string');
    assert.ok(win.webContents.getURL().endsWith('/example.html'));
  });
  assert.equal(await win.loadFile('example.html'), undefined);
  const previous = win.webContents.getURL();
  assert.equal(finished, 1);
  await assert.rejects(win.loadFile('missing.html'), /file missing/);
  assert.equal(win.webContents.getURL(), previous);
  assert.equal(finished, 1);
  await app.quit();
});

test('handleOnce consumes registration before awaiting the handler', async t => {
  const { app, BrowserWindow, ipcMain } = createApplication({ hostPath: process.execPath, hostArgs: [fixture, 'once'] });
  t.after(() => app.dispose());
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  ipcMain.handleOnce('system.info', async () => { calls++; await blocked; return 42; });
  assert.throws(() => ipcMain.handleOnce('system.info', () => 0), /already registered/);
  assert.throws(() => ipcMain.handleOnce('bad', null), TypeError);
  const win = new BrowserWindow({ allowedChannels: ['system.info'] });
  await win.loadFile('example.html');
  let replies = [];
  for (let i = 0; i < 20 && !replies.length; i++) replies = await win.webContents.executeJavaScript('test-query');
  assert.equal(calls, 1);
  assert.equal(replies[0].call, 2);
  assert.match(replies[0].error, /No handler/);
  release();
  for (let i = 0; i < 20 && replies.length < 2; i++) replies = await win.webContents.executeJavaScript('test-query');
  assert.equal(replies.find(reply => reply.call === 1).result, 42);
  ipcMain.handle('system.info', () => 7);
  ipcMain.removeHandler('system.info');
  await app.quit();
});

test('failed creation removes the public window and invalidates webContents', async t => {
  const { app, BrowserWindow } = createApplication({ hostPath: process.execPath, hostArgs: [fixture, 'create-fail'] });
  t.after(() => app.dispose());
  const win = new BrowserWindow();
  await assert.rejects(win.ready, /creation failed/);
  assert.equal(win.isDestroyed(), true);
  assert.equal(win.webContents.isDestroyed(), true);
  assert.deepEqual(BrowserWindow.getAllWindows(), []);
  await app.quit();
});

test('host shutdown removes windows before notifying closed listeners', async t => {
  const { app, BrowserWindow } = createApplication({ hostPath: process.execPath, hostArgs: [fixture] });
  t.after(() => app.dispose());
  const win = new BrowserWindow();
  await win.ready;
  const closed = once(win, 'closed');
  win.on('closed', () => {
    assert.equal(win.isDestroyed(), true);
    assert.equal(BrowserWindow.fromId(win.id), null);
    assert.equal(app.isReady(), false);
  });
  app.dispose();
  await closed;
});

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

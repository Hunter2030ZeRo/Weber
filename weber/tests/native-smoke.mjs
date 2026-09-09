// Run under a real display or xvfb-run after building weber-host.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { app, BrowserWindow, ipcMain } from '../packages/weber/index.mjs';
try {
  ipcMain.handle('system.info', () => ({ backend: 'smoke', platform: process.platform }));
  await app.whenReady();
  const win = new BrowserWindow({ allowedChannels: ['system.info'] });
  const publicId = win.id;
  assert.equal(BrowserWindow.fromId(publicId), win);
  assert.equal(win.webContents.getURL(), '');
  let loaded = false;
  win.webContents.once('did-finish-load', () => {
    loaded = true;
    assert.ok(win.webContents.getURL().endsWith('/index.html'));
  });
  const frame = once(win, 'ready-to-show', { signal: AbortSignal.timeout(10000) });
  frame.catch(() => {});
  await win.loadFile(fileURLToPath(new URL('../examples/javascript/index.html', import.meta.url)));
  assert.equal(loaded, true);
  const [metrics] = await frame;
  assert.ok(metrics.nonwhite > 100, 'Expected nonblank Obscura pixels presented to the native surface');
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Weber');
  await assert.rejects(win.webContents.executeJavaScript('throw new Error("observable")'), /observable/);
  const invocationStarted = Date.now();
  await win.webContents.executeJavaScript('document.getElementById("info").click(); null');
  let text = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    text = await win.webContents.executeJavaScript('document.getElementById("result").textContent');
    if (text.includes('smoke')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(text, /smoke/);
  assert.ok(Date.now() - invocationStarted < 5000, 'IPC must not wait for the renderer timeout timer');
  const closed = once(win, 'closed');
  await win.close();
  await closed;
  assert.equal(win.isDestroyed(), true);
  assert.equal(win.webContents.isDestroyed(), true);
  assert.equal(BrowserWindow.fromId(publicId), null);
  const replacement = new BrowserWindow();
  assert.notEqual(replacement.id, publicId);
  await replacement.ready;
  assert.equal(BrowserWindow.fromWebContents(replacement.webContents), replacement);
  await replacement.close();
  await app.quit();
  console.log('Native Obscura surface + DOM + renderer/backend IPC smoke passed');
} finally { app.dispose(); }

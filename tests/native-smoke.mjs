// Run under a real display or xvfb-run after building weber-host.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { app, BrowserWindow, ipcMain } from '../packages/weber/index.mjs';
try {
  ipcMain.handle('system.info', () => ({ backend: 'smoke', platform: process.platform }));
  await app.whenReady();
  const win = new BrowserWindow({ allowedChannels: ['system.info'] });
  const frame = once(win, 'ready-to-show', { signal: AbortSignal.timeout(10000) });
  frame.catch(() => {});
  await win.loadFile(fileURLToPath(new URL('../examples/javascript/index.html', import.meta.url)));
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
  await win.close();
  await app.quit();
  console.log('Native Obscura surface + DOM + renderer/backend IPC smoke passed');
} finally { app.dispose(); }

// Run under a real display or xvfb-run after building weber-host.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from '../packages/weber/index.mjs';
try {
  ipcMain.handle('system.info', () => ({ backend: 'smoke', platform: process.platform }));
  await app.whenReady();
  const win = new BrowserWindow({ allowedChannels: ['system.info'] });
  await win.loadFile(fileURLToPath(new URL('../examples/javascript/index.html', import.meta.url)));
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Weber');
  await assert.rejects(win.webContents.executeJavaScript('throw new Error("observable")'), /observable/);
  await win.webContents.executeJavaScript('document.getElementById("info").click(); null');
  let text = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    text = await win.webContents.executeJavaScript('document.getElementById("result").textContent');
    if (text.includes('smoke')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(text, /smoke/);
  await win.close();
  await app.quit();
  console.log('Native Obscura DOM + renderer/backend IPC smoke passed');
} finally { app.dispose(); }

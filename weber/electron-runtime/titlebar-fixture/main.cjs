// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { app, BrowserWindow, Menu } = require('electron');
const wait = async predicate => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw Error('Title bar fixture timed out');
};
app.on('weber-error', error => { console.error(error); process.exit(1); });
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ title: 'weber-titlebar-test', width: 500, height: 300, frame: false,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#112233', symbolColor: '#ffffff', height: 29 } });
  await win.loadFile(path.join(__dirname, 'index.html'));
  const state = () => win._host('window.getTitleBarOverlayState');
  await wait(async () => (await state()).controls.height === 29);
  const first = await state();
  assert.equal(first.color, 'rgb(17,34,51)');
  assert.deepEqual(first.content, { width: 500, height: 300 });
  win.setTitleBarOverlay({ color: '#aabbcc', height: 44 });
  await wait(async () => (await state()).controls.height === 44);
  const updated = await state();
  assert.equal(updated.color, 'rgb(170,187,204)');
  assert.equal(updated.symbolColor, 'rgb(255,255,255)');
  assert.deepEqual(updated.content, first.content);
  assert.throws(() => win.setTitleBarOverlay({ height: -1 }), RangeError);
  const other = new BrowserWindow({ show: false });
  assert.throws(() => other.setTitleBarOverlay({ color: 'red' }), /not enabled/);
  await other._ready;
  assert.equal(await other._host('window.getTitleBarOverlayState'), null);
  other.close();
  const xid = execFileSync('xdotool', ['search', '--name', '^weber-titlebar-test$'], { encoding: 'utf8' }).trim().split('\n').at(-1);
  const { x, y, width, height } = updated.controls;
  const click = () => execFileSync('xdotool', ['mousemove', '--window', xid, String(x + width - 23), String(y + Math.floor(height / 2)), 'click', '1']);
  let closing = 0;
  win.once('close', event => { closing++; event.preventDefault(); });
  click(); await wait(() => closing === 1);
  assert.equal(win.isDestroyed(), false);
  assert.equal(await win.webContents.executeJavaScript('window.contentClicks'), 0, 'native controls must not click through');
  click(); await wait(() => win.isDestroyed());
  assert.throws(() => win.setTitleBarOverlay({}), /destroyed/);
  console.log(JSON.stringify({ kind: 'titlebar-runtime-acceptance', backend: process.versions.bun ? 'bun' : 'node', passed: true,
    checks: ['original-BrowserWindow', 'creation', 'partial-update', 'content-size', 'independent-window', 'native-X11-close', 'cancel-close', 'no-click-through', 'destroyed-window'] }));
  app.quit();
}).catch(error => { console.error(error); process.exit(1); });

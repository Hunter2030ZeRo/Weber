// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, Menu } = require('electron');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(predicate) {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await delay(20); }
  throw Error('Window state fixture timed out');
}
app.on('weber-error', error => { console.error(error); process.exit(1); });
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ title: 'weber-window-state-test', width: 500, height: 300,
    frame: false, titleBarStyle: 'hidden', titleBarOverlay: { height: 29 } });
  const events = [];
  for (const name of ['maximize', 'unmaximize', 'minimize', 'restore']) {
    win.on(name, () => {
      assert.equal(name === 'maximize' ? win.isMaximized() : name === 'unmaximize' ? !win.isMaximized()
        : name === 'minimize' ? win.isMinimized() : !win.isMinimized(), true);
      events.push(name);
    });
  }
  await win._ready;
  const native = () => win._host('window.getWindowState');
  const overlay = () => win._host('window.getTitleBarOverlayState');
  await wait(async () => (await overlay()).content.width === 500);
  assert.deepEqual(await native(), { maximized: false, minimized: false });
  win.maximize();
  await wait(async () => win.isMaximized() && (await native()).maximized);
  await wait(async () => (await overlay()).content.width === 1024);
  assert.equal(win.isFullScreen(), false, 'maximized is not fullscreen');
  win.maximize(); await native(); await delay(100);
  assert.deepEqual(events, ['maximize']);
  win.unmaximize(); await wait(() => !win.isMaximized());
  await wait(async () => (await overlay()).content.width === 500 && (await overlay()).content.height === 300);
  win.minimize(); await wait(async () => win.isMinimized() && (await native()).minimized);
  win.restore(); await wait(async () => !win.isMinimized() && !(await native()).minimized);
  assert.deepEqual(events, ['maximize', 'unmaximize', 'minimize', 'restore']);
  const xid = execFileSync('xdotool', ['search', '--name', '^weber-window-state-test$'], { encoding: 'utf8' }).trim().split('\n').at(-1);
  execFileSync('wmctrl', ['-i', '-r', xid, '-b', 'add,maximized_vert,maximized_horz']);
  await wait(() => win.isMaximized());
  execFileSync('wmctrl', ['-i', '-r', xid, '-b', 'remove,maximized_vert,maximized_horz']);
  await wait(() => !win.isMaximized());
  await wait(async () => (await overlay()).content.width === 500);
  // Exercise the actual GTK title-bar callbacks, not only programmatic setters.
  const controls = (await overlay()).controls;
  const click = offset => execFileSync('xdotool', ['mousemove', '--window', xid,
    String(controls.x + controls.width - offset), String(controls.y + 14), 'click', '1']);
  click(69); await wait(() => win.isMaximized());
  win.restore(); await wait(() => !win.isMaximized());
  await wait(async () => (await overlay()).content.width === 500);
  click(115); await wait(() => win.isMinimized());
  win.restore(); await wait(() => !win.isMinimized());
  const other = new BrowserWindow({ show: false, width: 400, height: 250 });
  other.maximize(); await wait(() => other.isMaximized() && other.isVisible());
  assert.equal(win.isMaximized(), false);
  other.close(); await wait(() => other.isDestroyed());
  win.close(); await wait(() => win.isDestroyed());
  for (const name of ['isMaximized', 'isMinimized', 'maximize', 'unmaximize', 'minimize', 'restore'])
    assert.throws(() => win[name](), /destroyed/);
  console.log(JSON.stringify({ kind: 'window-state-runtime-acceptance', backend: process.versions.bun ? 'bun' : 'node',
    passed: true, windowManager: 'Openbox', checks: ['native-state', 'event-order', 'maximize-geometry',
      'restore-geometry', 'minimize-restore', 'external-WM-change', 'native-titlebar-buttons',
      'duplicate-request', 'hidden-maximize', 'independent-windows', 'destroyed-window'] }));
  app.quit();
}).catch(error => { console.error(error); process.exit(1); });

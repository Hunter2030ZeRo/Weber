// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, Menu } = require('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate) {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await delay(20); }
  throw Error('Fullscreen fixture timed out');
}
app.on('weber-error', error => { console.error(error); process.exit(1); });
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  assert.throws(() => new BrowserWindow({ fullscreen: 'yes' }), TypeError);
  const win = new BrowserWindow({ title: 'weber-fullscreen-test', width: 500, height: 300,
    frame: false, titleBarStyle: 'hidden', titleBarOverlay: { height: 29 } });
  const transitions = [];
  win.on('enter-full-screen', () => { assert.equal(win.isFullScreen(), true); transitions.push(true); });
  win.on('leave-full-screen', () => { assert.equal(win.fullScreen, false); transitions.push(false); });
  await win._ready;
  const state = () => win._host('window.getFullScreenState');
  const overlay = () => win._host('window.getTitleBarOverlayState');
  await wait(async () => (await overlay()).content.width === 500);
  assert.equal(win.isFullScreen(), false);
  assert.equal(await state(), false);
  const before = (await overlay()).content;
  assert.throws(() => win.setFullScreen(1), TypeError);
  win.setFullScreen(true);
  // The setter cannot turn a queued request into confirmed native state.
  assert.equal(win.isFullScreen(), false);
  await wait(async () => win.fullScreen && await state() && !(await overlay()).visible);
  await wait(async () => (await overlay()).content.width === 1024 && (await overlay()).content.height === 768);
  win.setFullScreen(true);
  await win._host('window.getFullScreenState'); await delay(100);
  assert.deepEqual(transitions, [true], 'duplicate request must not duplicate transition');
  win.fullScreen = false;
  await wait(async () => !win.isFullScreen() && !(await state()) && (await overlay()).visible);
  await wait(async () => JSON.stringify((await overlay()).content) === JSON.stringify(before));
  const xid = execFileSync('xdotool', ['search', '--name', '^weber-fullscreen-test$'], { encoding: 'utf8' }).trim().split('\n').at(-1);
  const external = action => execFileSync('wmctrl', ['-i', '-r', xid, '-b', action + ',fullscreen']);
  external('add'); await wait(() => win.isFullScreen());
  assert.equal(await state(), true);
  external('remove'); await wait(() => !win.isFullScreen());
  assert.deepEqual(transitions, [true, false, true, false]);
  const other = new BrowserWindow({ show: false, fullscreen: true, width: 400, height: 250 });
  await other._ready;
  assert.equal(other.isVisible(), false);
  other.show(); await wait(() => other.isFullScreen());
  assert.equal(await other._host('window.getFullScreenState'), true);
  assert.equal(win.isFullScreen(), false, 'windows have independent state');
  other.setFullScreen(false); await wait(() => !other.isFullScreen());
  other.close(); await wait(() => other.isDestroyed());
  win.setFullScreen(true); await wait(() => win.isFullScreen());
  win.close(); await wait(() => win.isDestroyed());
  assert.throws(() => win.isFullScreen(), /destroyed/);
  assert.throws(() => win.setFullScreen(false), /destroyed/);
  console.log(JSON.stringify({ kind: 'fullscreen-runtime-acceptance', backend: process.versions.bun ? 'bun' : 'node',
    passed: true, windowManager: 'Openbox', checks: ['original-BrowserWindow', 'native-state', 'event-order',
      'screen-geometry', 'overlay-hide-restore', 'bounds-restore', 'duplicate-request', 'external-WM-change',
      'hidden-creation', 'independent-windows', 'argument-validation', 'destroy-in-fullscreen'] }));
  app.quit();
}).catch(error => { console.error(error); process.exit(1); });

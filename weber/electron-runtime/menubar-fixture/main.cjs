// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, Menu } = require('electron');
const delay = ms => new Promise(r => setTimeout(r, ms));
let diagnostic = async () => ({});
async function wait(predicate) {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await delay(20); }
  throw Error('Menu bar fixture timed out: ' + JSON.stringify(await diagnostic()));
}
app.on('weber-error', error => { console.error(error); process.exit(1); });
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ title: 'weber-menubar-test', width: 500, height: 300 });
  let clicked = 0;
  const menu = () => Menu.buildFromTemplate([{ label: '&File', submenu: [
    { label: 'Count', accelerator: 'Ctrl+K', click: () => clicked++ }
  ] }]);
  win.setMenu(menu()); await win._menuReady;
  const state = () => win._host('window.getMenuState');
  diagnostic = async () => ({ native: await state(), visible: win.isMenuBarVisible(), clicked });
  await wait(async () => {
    const current = await state();
    return win.isMenuBarVisible() && current.barMapped && current.barHeight > 1 &&
      current.content.height + current.barHeight === current.clientHeight;
  });
  const shownHeight = (await state()).content.height;
  win.setMenuBarVisibility(false);
  await wait(async () => !win.isMenuBarVisible() && !(await state()).barMapped && (await state()).content.height > shownHeight);
  const hiddenHeight = (await state()).content.height;
  win.hide(); await wait(() => !win.isVisible()); win.show(); await wait(() => win.isVisible());
  assert.equal((await state()).barVisible, false, 'show_all must preserve hidden menu');
  win.setMenu(menu()); await win._menuReady;
  assert.equal((await state()).barVisible, false, 'replacement preserves visibility');
  const xid = execFileSync('xdotool', ['search', '--name', '^weber-menubar-test$'], { encoding: 'utf8' }).trim().split('\n').at(-1);
  execFileSync('xdotool', ['windowactivate', '--sync', xid]);
  const key = value => execFileSync('xdotool', ['key', '--clearmodifiers', value]);
  key('ctrl+k'); await wait(() => clicked === 1);
  assert.equal(win.isMenuBarVisible(), false, 'hidden accelerator must not expose bar');
  win.autoHideMenuBar = true;
  await wait(async () => (await state()).autoHide);
  assert.equal(win.isMenuBarAutoHide(), true);
  key('Alt_L'); await wait(async () => win.isMenuBarVisible() && (await state()).barMapped);
  key('Escape'); await wait(() => !win.isMenuBarVisible());
  key('alt+x'); await delay(100);
  assert.equal(win.isMenuBarVisible(), false, 'Alt chord must not toggle the bar');
  key('Alt_L'); await wait(() => win.isMenuBarVisible());
  win.setAutoHideMenuBar(false); await state();
  assert.equal(win.isMenuBarVisible(), true, 'auto-hide setting alone does not change visibility');
  key('Alt_L'); await delay(100); assert.equal(win.isMenuBarVisible(), true);
  win.setMenuBarVisibility(false); await wait(() => !win.isMenuBarVisible());
  win.setMenuBarVisibility(true); await wait(async () => (await state()).content.height === shownHeight);
  const other = new BrowserWindow({ show: false, autoHideMenuBar: true });
  other.setMenu(menu()); await other._menuReady;
  assert.equal(other.isMenuBarVisible(), false);
  other.show(); await wait(() => other.isVisible());
  assert.equal((await other._host('window.getMenuState')).barVisible, false);
  assert.equal(win.isMenuBarVisible(), true);
  other.close(); await wait(() => other.isDestroyed());
  const frameless = new BrowserWindow({ show: false, frame: false });
  frameless.setMenu(menu()); await frameless._menuReady;
  frameless.setMenuBarVisibility(true); await frameless._host('window.getMenuState');
  assert.equal(frameless.isMenuBarVisible(), false);
  frameless.close(); await wait(() => frameless.isDestroyed());
  assert.throws(() => win.setMenuBarVisibility(1), TypeError);
  assert.throws(() => win.setAutoHideMenuBar('true'), TypeError);
  win.setMenu(null); await win._menuReady;
  await wait(async () => !win.isMenuBarVisible() && (await state()).content.height === hiddenHeight);
  win.close(); await wait(() => win.isDestroyed());
  assert.throws(() => win.isMenuBarVisible(), /destroyed/);
  assert.throws(() => win.setAutoHideMenuBar(false), /destroyed/);
  console.log(JSON.stringify({ kind: 'menubar-runtime-acceptance', backend: process.versions.bun ? 'bun' : 'node', passed: true,
    checks: ['native-mapping', 'content-resize', 'show-hide-preservation', 'menu-replacement', 'hidden-accelerator',
      'Alt-toggle', 'Escape', 'Alt-chord', 'auto-hide-policy', 'hidden-creation', 'independent-windows',
      'frameless-policy', 'detach', 'argument-validation', 'destroyed-window'] }));
  app.quit();
}).catch(error => { console.error(error); process.exit(1); });

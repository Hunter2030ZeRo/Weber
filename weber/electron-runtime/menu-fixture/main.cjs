'use strict';
const { app, BrowserWindow, Menu } = require('electron');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const state = { ready: false, clicks: 0, checkbox: false, radio: '', accelerator: 0, removed: false };
let first, second;
let inspectTimer;
const report = () => fs.writeFileSync(process.env.WEBER_MENU_RESULT, JSON.stringify(state));
const fail = error => { state.error = error.stack; report(); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.on('weber-error', fail);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => fail(new Error('Native menu verification timed out')), 60000);
const menu = Menu.buildFromTemplate([{ label: '&Test', submenu: [
  { id: 'click', label: '&Click', click(_item, window) {
    state.clicks++; state.windowId = window?.id; report();
  } },
  { id: 'enabled', label: '&Enabled', type: 'checkbox', click(item) {
    state.checkbox = item.checked; report();
  } },
  { id: 'first', label: '&First', type: 'radio', click(item) {
    assert.equal(item.checked, true);
    assert.equal(menu.getMenuItemById('second').checked, false);
    state.radio = 'first'; report();
  } },
  { id: 'second', label: '&Second', type: 'radio', checked: true },
  { id: 'disabled', label: 'Disabled', enabled: false, click() { fail(new Error('Disabled item activated')); } },
  { id: 'accelerator', label: 'Accelerator', accelerator: 'Control+Shift+Y', click(_item, window, event) {
    assert.equal(event.ctrlKey, true); assert.equal(event.shiftKey, true);
    state.accelerator++; state.windowId = window?.id; report();
  } },
  { id: 'remove', label: '&Remove menu', async click() {
    Menu.setApplicationMenu(null);
    assert.equal(Menu.getApplicationMenu(), null);
    assert.equal(app.applicationMenu, null);
    // These promises diagnose native transport completion; the app-facing API
    // operations above are unchanged Electron calls.
    await Promise.all([first._menuReady, second._menuReady]);
    state.removed = true; report();
    clearInterval(inspectTimer);
    clearTimeout(timeout);
    app.exit(0);
  } },
] }]);
Menu.setApplicationMenu(menu);
assert.equal(app.applicationMenu, menu);

app.whenReady().then(async () => {
  first = new BrowserWindow({ width: 480, height: 320, title: 'Weber menu first' });
  second = new BrowserWindow({ width: 480, height: 320, title: 'Weber menu second' });
  const firstFrame = once(first.webContents, 'weber-first-frame-presented');
  const secondFrame = once(second.webContents, 'weber-first-frame-presented');
  await Promise.all([first.loadFile(path.join(__dirname, 'index.html')),
    second.loadFile(path.join(__dirname, 'index.html')), first._menuReady, second._menuReady]);
  await Promise.all([firstFrame, secondFrame]);
  state.ready = true; state.firstId = first.id; state.secondId = second.id;
  state.topCommandId = menu.items[0].commandId;
  state.commandIds = Object.fromEntries(['click', 'enabled', 'first', 'remove'].map(id => [id, menu.getMenuItemById(id).commandId]));
  state.nativeMenu = 'gtk'; state.templatePolicy = 'unmodified Electron Menu and MenuItem';
  let inspecting = false;
  inspectTimer = setInterval(async () => {
    if (inspecting || state.removed) return;
    inspecting = true;
    try {
      const layouts = await Promise.all([first, second].map(win => win._host('window.getMenuState')));
      state.layouts = { [first.id]: layouts[0], [second.id]: layouts[1] };
      report();
    } catch (error) { if (!state.removed) fail(error); }
    finally { inspecting = false; }
  }, 50);
  report();
}).catch(fail);

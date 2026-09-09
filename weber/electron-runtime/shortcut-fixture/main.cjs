'use strict';
const { app, BrowserWindow, globalShortcut } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const primary = 'Control+Shift+F8';
const secondary = 'Control+Shift+F9';
const role = process.env.WEBER_SHORTCUT_ROLE || 'owner';
const state = { ready: false, role, pid: process.pid, primary: 0, secondary: 0, command: 0 };
let poller;
const report = () => {
  const temporary = `${process.env.WEBER_SHORTCUT_RESULT}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, process.env.WEBER_SHORTCUT_RESULT);
};
const fail = error => {
  state.error = error?.stack || String(error);
  report();
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.on('weber-error', fail);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => fail(new Error('Native global shortcut verification timed out')), 65000);
const onPrimary = () => { state.primary++; report(); };
const onSecondary = () => { state.secondary++; report(); };

app.whenReady().then(async () => {
  if (role === 'contender' || role === 'after-exit') {
    const registered = globalShortcut.register(primary, onPrimary);
    assert.equal(typeof registered, 'boolean');
    assert.equal(registered, role === 'after-exit');
    assert.equal(globalShortcut.isRegistered(primary), registered);
    // A client that did not own a grab must not release another client's grab.
    globalShortcut.unregister(primary);
    globalShortcut.unregisterAll();
    assert.equal(globalShortcut.isRegistered(primary), false);
    state.registered = registered;
    state.ready = true;
    report();
    clearTimeout(timeout);
    app.exit(0);
    return;
  }

  const window = new BrowserWindow({ width: 420, height: 220, title: 'Weber shortcut owner' });
  await window.loadFile(path.join(__dirname, 'index.html'));
  assert.equal(globalShortcut.isRegistered(primary), false);
  const first = globalShortcut.register(primary, onPrimary);
  assert.equal(typeof first, 'boolean');
  assert.equal(first, true);
  assert.equal(globalShortcut.isRegistered(primary), true);
  assert.equal(globalShortcut.register(primary, () => fail(new Error('Duplicate callback ran'))), false);
  assert.equal(globalShortcut.register(secondary, onSecondary), true);
  assert.equal(globalShortcut.isRegistered(secondary), true);
  const rolledBack = 'Control+Shift+F10';
  assert.equal(globalShortcut.registerAll([rolledBack, primary], onPrimary), false);
  assert.equal(globalShortcut.isRegistered(rolledBack), false);
  assert.equal(globalShortcut.isRegistered(primary), true);
  assert.equal(globalShortcut.isRegistered('Ctrl+Shift+F8'), true);
  state.synchronousRegistration = true;
  state.ready = true;
  report();

  poller = setInterval(() => {
    try {
      let command;
      try { command = JSON.parse(fs.readFileSync(process.env.WEBER_SHORTCUT_CONTROL, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (!Number.isSafeInteger(command.id) || command.id <= state.command) return;
      switch (command.action) {
        case 'unregister-primary':
          globalShortcut.unregister(primary);
          assert.equal(globalShortcut.isRegistered(primary), false);
          assert.equal(globalShortcut.isRegistered(secondary), true);
          break;
        case 'unregister-all':
          globalShortcut.unregisterAll();
          assert.equal(globalShortcut.isRegistered(primary), false);
          assert.equal(globalShortcut.isRegistered(secondary), false);
          break;
        case 'reregister-primary':
          assert.equal(globalShortcut.register(primary, onPrimary), true);
          assert.equal(globalShortcut.isRegistered(primary), true);
          break;
        case 'quit':
          // Leave primary registered to verify OS ownership is released on exit.
          clearInterval(poller);
          clearTimeout(timeout);
          state.command = command.id;
          state.finished = true;
          report();
          app.exit(0);
          return;
        default: throw new Error(`Unknown command: ${command.action}`);
      }
      state.command = command.id;
      state.action = command.action;
      report();
    } catch (error) { fail(error); }
  }, 20);
}).catch(fail);

// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// Runs the compiled, unmodified Electron Menu and MenuItem implementations.
// Only native transport and window state are test doubles; GTK input is covered
// separately by the live desktop test. Run build.cjs before this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createMenuBinding } = require('./menu-binding.cjs');
const dist = path.resolve(process.env.WEBER_ELECTRON_TEST_DIST || path.join(__dirname, 'dist'));

function harness() {
  const host = new EventEmitter();
  const app = new EventEmitter();
  app.name = 'Menu binding test';
  app.quit = () => { app.quitCalls = (app.quitCalls || 0) + 1; };
  const errors = [];
  app.on('weber-error', error => errors.push(error));
  const windows = new Map();
  const requests = [];
  const native = createMenuBinding({ host, app, windows, unsupported(name) {
    const error = new Error(`Unsupported ${name}`);
    error.code = 'ERR_WEBER_UNSUPPORTED';
    throw error;
  } });
  const electron = {
    app,
    BaseWindow: {
      getAllWindows: () => [...windows.values()],
      getFocusedWindow: () => [...windows.values()].find(window => window._focused) || null,
    },
    webContents: {
      getFocusedWebContents: () => null,
      getAllWebContents: () => [],
    },
  };
  const cache = new Map();
  const sourceProcess = Object.create(process);
  sourceProcess._linkedBinding = name => {
    assert.equal(name, 'electron_browser_menu', 'unexpected native binding dependency');
    return native;
  };
  const allowed = new Set(['browser/api/menu', 'browser/api/menu-item',
    'browser/api/menu-utils', 'browser/api/menu-item-roles', 'browser/default-menu']);
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'source-manifest.json'), 'utf8'));
  function load(id) {
    assert.ok(allowed.has(id), `Unexpected internal module ${id}`);
    if (cache.has(id)) return cache.get(id).exports;
    assert.ok(manifest.sources.some(source => source.path === `lib/${id}.ts`),
      `Original Electron source absent from compiler manifest: ${id}`);
    const filename = path.join(dist, `${id}.js`);
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    cache.set(id, module);
    const localRequire = name => {
      if (name === 'electron/main' || name === 'electron') return electron;
      const prefix = '@electron/internal/';
      if (name.startsWith(prefix)) return load(name.slice(prefix.length));
      throw new Error(`Unexpected original menu import ${name}`);
    };
    vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname', 'process'],
      { filename })(module.exports, localRequire, module, filename, path.dirname(filename), sourceProcess);
    return module.exports;
  }
  Object.defineProperty(electron, 'Menu', { get: () => load('browser/api/menu') });
  Object.defineProperty(electron, 'MenuItem', { get: () => load('browser/api/menu-item') });
  const Menu = electron.Menu;
  function window(options = {}) {
    const result = {
      id: windows.size + 1, _focused: false, _destroyed: false, _closing: false,
      closable: true, minimizable: true, fullScreenable: true, closeCalls: 0,
      ...options,
      _host(method, payload) {
        requests.push({ windowId: this.id, method, ...structuredClone(payload) });
        return Promise.resolve({});
      },
      setMenu(menu) { return native.setWindowMenu(this, menu); },
      isClosable() { return this.closable; },
      isMinimizable() { return this.minimizable; },
      isFullScreenable() { return this.fullScreenable; },
      close() { this.closeCalls++; },
    };
    windows.set(result.id, result);
    return result;
  }
  function click(owner, item, details = {}) {
    host.emit('event', { event: 'menu-click', windowId: owner.id,
      menuId: item.menu._menuId, commandId: item.commandId, ...details });
  }
  function latest(owner) { return requests.filter(request => request.windowId === owner.id).at(-1); }
  return { Menu, MenuItem: electron.MenuItem, host, app, errors, requests, window, click, latest };
}

test('original Electron template sorting, separators and recursive item lookup survive the binding', () => {
  const h = harness();
  const menu = h.Menu.buildFromTemplate([
    { type: 'separator' },
    { id: 'second', label: 'Second', after: ['first'] },
    { id: 'first', label: 'First' },
    { type: 'separator' }, { type: 'separator' },
    { id: 'nested', label: 'Nested', submenu: [{ id: 'leaf', label: 'Leaf' }] },
    { type: 'separator' },
  ]);
  assert.deepEqual(menu.items.map(item => item.id || item.type), ['first', 'second', 'separator', 'nested']);
  assert.equal(menu.getItemCount(), 4);
  assert.equal(menu.getMenuItemById('leaf').label, 'Leaf');
  assert.equal(menu.getMenuItemById('absent'), null);
  assert.throws(() => menu.append({ label: 'Impostor' }), /Invalid item/);
  const owner = h.window();
  h.Menu.setApplicationMenu(menu);
  assert.equal(h.Menu.getApplicationMenu(), menu);
  assert.equal(owner._menu, menu);
  assert.deepEqual(h.latest(owner).menu.items.map(item => item.label), ['First', 'Second', '', 'Nested']);
  assert.deepEqual(h.errors, []);
});

test('original checkbox and radio callbacks update shared windows and preserve event ownership', () => {
  const h = harness();
  const calls = [];
  const menu = h.Menu.buildFromTemplate([{ label: 'Options', submenu: [
    { id: 'check', label: 'Check', type: 'checkbox', click: (...args) => calls.push(args) },
    { type: 'separator' },
    { id: 'radio-a', label: 'A', type: 'radio' },
    { id: 'radio-b', label: 'B', type: 'radio' },
  ] }]);
  const first = h.window({ _focused: true });
  const second = h.window();
  h.Menu.setApplicationMenu(menu);
  const checkbox = menu.getMenuItemById('check');
  const a = menu.getMenuItemById('radio-a');
  const b = menu.getMenuItemById('radio-b');
  assert.equal(a.checked, true, 'first radio item becomes selected when menu is attached');
  assert.equal(b.checked, false);
  h.click(second, checkbox, { modifiers: 10, accelerator: true });
  assert.equal(checkbox.checked, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], checkbox);
  assert.equal(calls[0][1], second);
  assert.equal(calls[0][2].shiftKey, true);
  assert.equal(calls[0][2].ctrlKey, true);
  assert.equal(calls[0][2].altKey, false);
  assert.equal(calls[0][2].triggeredByAccelerator, true);
  assert.equal(first._focused, false);
  assert.equal(second._focused, true);
  for (const owner of [first, second]) {
    assert.equal(h.latest(owner).method, 'window.updateMenu');
    assert.equal(h.latest(owner).menu.items[0].submenu[0].checked, true);
  }
  h.click(second, b);
  assert.equal(a.checked, false);
  assert.equal(b.checked, true);
  h.click(second, b);
  assert.equal(b.checked, true, 'clicking the selected radio does not clear its group');
  h.click(first, checkbox);
  assert.equal(checkbox.checked, false);
  assert.deepEqual(h.errors, []);
});

test('disabled items, obsolete command IDs, detached menus and destroyed windows cannot execute', () => {
  const h = harness();
  let clicks = 0;
  const oldMenu = h.Menu.buildFromTemplate([{ id: 'old', label: 'Old', click: () => clicks++ }]);
  const first = h.window();
  const second = h.window();
  h.Menu.setApplicationMenu(oldMenu);
  const old = oldMenu.getMenuItemById('old');
  old.enabled = false;
  h.click(first, old);
  assert.equal(clicks, 0);
  old.enabled = true;
  first.setMenu(null);
  assert.equal(first._menu, null);
  assert.equal(h.latest(first).menu, null);
  assert.equal(second._menu, oldMenu);
  h.click(first, old);
  assert.equal(clicks, 0);
  h.click(second, old);
  assert.equal(clicks, 1);
  const newMenu = h.Menu.buildFromTemplate([{ id: 'new', label: 'New', click: () => clicks += 10 }]);
  h.Menu.setApplicationMenu(newMenu);
  assert.equal(first._menu, newMenu);
  assert.equal(second._menu, newMenu);
  h.click(second, old);
  assert.equal(clicks, 1);
  const current = newMenu.getMenuItemById('new');
  h.click(second, current);
  assert.equal(clicks, 11);
  second._destroyed = true;
  h.click(second, current);
  assert.equal(clicks, 11);
  h.Menu.setApplicationMenu(null);
  assert.equal(h.Menu.getApplicationMenu(), null);
  assert.equal(first._menu, null);
  assert.deepEqual(h.errors, []);
});

test('hidden commands require a permitted accelerator, not a stale mouse activation', () => {
  const h = harness();
  let clicks = 0;
  const menu = h.Menu.buildFromTemplate([{ id: 'hidden', label: 'Hidden', visible: false,
    accelerator: 'Control+H', click: () => clicks++ }]);
  const owner = h.window();
  owner.setMenu(menu);
  const item = menu.getMenuItemById('hidden');
  h.click(owner, item, { accelerator: false });
  assert.equal(clicks, 0, 'hidden item must reject mouse activation');
  h.click(owner, item, { accelerator: true });
  assert.equal(clicks, 1);
  item.acceleratorWorksWhenHidden = false;
  h.click(owner, item, { accelerator: true });
  assert.equal(clicks, 1);
  assert.deepEqual(h.errors, []);
});

test('disabled or hidden ancestor submenus reject queued descendant mouse commands', () => {
  const h = harness();
  let clicks = 0;
  const menu = h.Menu.buildFromTemplate([{ id: 'parent', label: 'Parent', submenu: [
    { id: 'child', label: 'Child', click: () => clicks++ },
  ] }]);
  const owner = h.window();
  owner.setMenu(menu);
  const parent = menu.getMenuItemById('parent');
  const child = menu.getMenuItemById('child');
  parent.enabled = false;
  h.click(owner, child);
  assert.equal(clicks, 0);
  parent.enabled = true;
  parent.visible = false;
  h.click(owner, child);
  assert.equal(clicks, 0);
  parent.visible = true;
  h.click(owner, child);
  assert.equal(clicks, 1);
  assert.deepEqual(h.errors, []);
});

test('original role capability checks use the window owning the menu event', () => {
  const h = harness();
  const menu = h.Menu.buildFromTemplate([{ id: 'close', role: 'close' }]);
  const first = h.window({ _focused: true, closable: true });
  const second = h.window({ closable: false });
  h.Menu.setApplicationMenu(menu);
  assert.equal(h.latest(first).menu.items[0].enabled, true);
  assert.equal(h.latest(second).menu.items[0].enabled, false,
    'native menu snapshot must use its own window capabilities');
  assert.equal(first._focused, true, 'serializing another window must not change focus');
  assert.equal(second._focused, false);
  const item = menu.getMenuItemById('close');
  h.click(second, item);
  assert.equal(second.closeCalls, 0, 'the previously focused window cannot authorize this close role');
  h.click(first, item);
  assert.equal(first.closeCalls, 1);
  assert.deepEqual(h.errors, []);
});

test('menu open refreshes mutable item state and unsupported rebuild leaves attached menu intact', () => {
  const h = harness();
  const menu = h.Menu.buildFromTemplate([{ id: 'item', label: 'Before' }]);
  const owner = h.window();
  owner.setMenu(menu);
  const item = menu.getMenuItemById('item');
  item.label = 'After';
  item.enabled = false;
  h.host.emit('event', { event: 'menu-will-show', windowId: owner.id, menuId: menu._menuId });
  assert.equal(h.latest(owner).method, 'window.updateMenu');
  assert.equal(h.latest(owner).menu.items[0].label, 'After');
  assert.equal(h.latest(owner).menu.items[0].enabled, false);
  const unsupported = h.Menu.buildFromTemplate([{ label: 'Unsupported', sublabel: 'Detail' }]);
  const count = h.requests.length;
  assert.throws(() => owner.setMenu(unsupported), { code: 'ERR_WEBER_UNSUPPORTED' });
  assert.equal(h.requests.length, count);
  assert.equal(owner._menu, menu);
  assert.deepEqual(h.errors, []);
});

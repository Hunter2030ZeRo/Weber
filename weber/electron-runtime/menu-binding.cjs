// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

const { EventEmitter } = require('node:events');

// Electron's original Menu/MenuItem sources own template sorting, roles, radio
// groups, lookup and click callbacks. This replaces their native menu boundary.
function createMenuBinding({ host, windows, app, unsupported }) {
  let nextMenuId = 0;
  function Menu() {
    EventEmitter.call(this);
    this._menuId = ++nextMenuId;
    this._entries = [];
    this._init();
  }
  Object.setPrototypeOf(Menu.prototype, EventEmitter.prototype);
  function insert(menu, position, entry) { menu._entries.splice(position, 0, entry); }
  Object.assign(Menu.prototype, {
    getItemCount() { return this._entries.length; },
    getIndexOfCommandId(id) { return this._entries.findIndex(entry => entry.commandId === id); },
    insertItem(position, commandId, label) { insert(this, position, { commandId, label }); },
    insertCheckItem(position, commandId, label) { insert(this, position, { commandId, label }); },
    insertRadioItem(position, commandId, label, groupId) { insert(this, position, { commandId, label, groupId }); },
    insertSeparator(position) { insert(this, position, { type: 'separator' }); },
    insertSubMenu(position, commandId, label, submenu) { insert(this, position, { commandId, label, submenu }); },
    setToolTip(position, toolTip) { this._entries[position].toolTip = toolTip; },
    setRole(position, role) { this._entries[position].role = role; },
    setIcon() { return unsupported('MenuItem.icon'); },
    setCustomType(_position, type) { return unsupported(`MenuItem.type ${type}`); },
    popupAt() { return unsupported('Menu.popup'); },
    closePopupAt() { return unsupported('Menu.closePopup'); },
  });

  function serialize(menu, window, opening = false, depth = 0, budget = { remaining: 2048 }) {
    if (depth > 16) throw new RangeError('Menu nesting exceeds 16 levels');
    if (opening) {
      menu._menuWillShow();
      menu.emit('menu-will-show');
    }
    return menu.items.map(item => {
      if (--budget.remaining < 0) throw new RangeError('Menu exceeds 2048 entries');
      if (item.icon || item.sublabel) unsupported(item.icon ? 'MenuItem.icon' : 'MenuItem.sublabel');
      // The same application menu is attached to several native windows. These
      // three upstream role checks must use this menu's owner while preparing a
      // snapshot, even when another window currently owns desktop focus.
      const capability = { close: 'isClosable', minimize: 'isMinimizable', togglefullscreen: 'isFullScreenable' }[item.role];
      const enabled = capability ? window[capability]() : menu._isCommandIdEnabled(item.commandId);
      const entry = { menuId: menu._menuId, commandId: item.commandId,
        type: item.type, label: String(item.label), toolTip: String(item.toolTip || ''),
        enabled: Boolean(enabled), visible: Boolean(item.visible),
        checked: Boolean(item.getCheckStatus()),
        accelerator: item.registerAccelerator ? (item.accelerator || '') : '',
        acceleratorWorksWhenHidden: Boolean(item.acceleratorWorksWhenHidden) };
      if (item.type === 'radio') entry.groupId = item.groupId;
      if (item.submenu) entry.submenu = serialize(item.submenu, window, opening, depth + 1, budget);
      return entry;
    });
  }
  function send(window, method, menu, opening = false) {
    const payload = menu === null ? null : { menuId: menu._menuId, items: serialize(menu, window, opening) };
    const request = window._host(method, { menu: payload });
    request.catch(error => app.emit('weber-error', error));
    window._menuReady = request;
    return request;
  }
  function setWindowMenu(window, menu) {
    if (menu !== null && !(menu instanceof Menu)) throw new TypeError('Invalid menu');
    // Serialize first, so an unsupported item cannot silently replace the menu.
    const result = send(window, 'window.setMenu', menu, true);
    window._menu = menu;
    return result;
  }
  function findMenu(menu, id, ancestors = []) {
    if (!menu) return null;
    if (menu._menuId === id) return { menu, ancestors };
    for (const item of menu.items) {
      const found = findMenu(item.submenu, id, [...ancestors, { menu, item }]);
      if (found) return found;
    }
    return null;
  }
  host.on('event', message => {
    if (message.event !== 'menu-click' && message.event !== 'menu-will-show') return;
    const window = windows.get(message.windowId);
    if (!window || window._destroyed || !window._menu) return;
    try {
      if (message.event === 'menu-will-show') {
        send(window, 'window.updateMenu', window._menu, true);
        return;
      }
      const selected = findMenu(window._menu, message.menuId);
      const menu = selected?.menu;
      const item = menu?.commandsMap[message.commandId];
      // The main process validates current state again, including changes made
      // after the last native menu snapshot or queued clicks on removed items.
      if (!item) return;
      for (const candidate of windows.values()) candidate._focused = candidate === window;
      const canActivate = (owner, entry) => owner._isCommandIdEnabled(entry.commandId) &&
        (entry.visible || (message.accelerator && entry.acceleratorWorksWhenHidden));
      if (!canActivate(menu, item) || selected.ancestors.some(parent => !canActivate(parent.menu, parent.item))) return;
      const modifiers = message.modifiers || 0;
      const keyboardEvent = { shiftKey: Boolean(modifiers & 8), ctrlKey: Boolean(modifiers & 2),
        altKey: Boolean(modifiers & 1), metaKey: Boolean(modifiers & 4), triggeredByAccelerator: Boolean(message.accelerator) };
      // GTK focus notifications precede menu events; preserve the owning native
      // window as focused while its attached menu temporarily owns keyboard focus.
      const activatedRoot = window._menu;
      menu._executeCommand(keyboardEvent, message.commandId);
      for (const candidate of windows.values()) {
        // A user callback can detach or replace the application/window menu.
        // Refresh only windows still displaying the menu that was activated.
        if (candidate._menu === activatedRoot && !candidate._destroyed && !candidate._closing) {
          send(candidate, 'window.updateMenu', candidate._menu);
        }
      }
    } catch (error) { app.emit('weber-error', error); }
  });
  return { Menu, setWindowMenu,
    sendActionToFirstResponder: () => unsupported('Menu.sendActionToFirstResponder'),
    setApplicationMenu: () => unsupported('macOS native application menu') };
}

module.exports = { createMenuBinding };

// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

function createGlobalShortcutBinding({ host, app }) {
  const callbacks = new Map();
  let nextCallback = 0;
  const ready = () => {
    if (!app.isReady()) throw new Error('globalShortcut cannot be used before app is ready');
  };
  const accelerator = value => {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256) {
      throw new TypeError('Accelerator must be a nonempty string of at most 256 bytes');
    }
    return value;
  };
  const api = {
    register(value, callback) {
      ready(); accelerator(value);
      if (typeof callback !== 'function') throw new TypeError('Shortcut callback must be a function');
      if (!Number.isSafeInteger(++nextCallback)) throw new Error('Shortcut callback id exhausted');
      const result = host.requestSync('globalShortcut.register', { accelerator: value, callbackId: nextCallback });
      if (typeof result !== 'boolean') throw new Error('Invalid native shortcut registration result');
      if (result) callbacks.set(nextCallback, callback);
      return result;
    },
    registerAll(values, callback) {
      ready();
      if (!Array.isArray(values)) throw new TypeError('Accelerators must be an array');
      if (values.length > 256) throw new RangeError('At most 256 global shortcuts may be registered');
      if (typeof callback !== 'function') throw new TypeError('Shortcut callback must be a function');
      values.forEach(accelerator);
      // Match the pinned Electron native implementation: roll back this call's
      // successful registrations when any member is already owned.
      const registered = [];
      try {
        for (const value of values) {
          if (!api.register(value, callback)) {
            for (const previous of registered) api.unregister(previous);
            return false;
          }
          registered.push(value);
        }
        return true;
      } catch (error) {
        for (const previous of registered) api.unregister(previous);
        throw error;
      }
    },
    isRegistered(value) {
      accelerator(value);
      const result = host.requestSync('globalShortcut.isRegistered', { accelerator: value });
      if (typeof result !== 'boolean') throw new Error('Invalid native shortcut ownership result');
      return result;
    },
    unregister(value) {
      ready(); accelerator(value);
      const callbackId = host.requestSync('globalShortcut.unregister', { accelerator: value });
      if (callbackId !== null) callbacks.delete(callbackId);
    },
    unregisterAll() {
      ready(); host.requestSync('globalShortcut.unregisterAll'); callbacks.clear();
    },
    setSuspended() { throw new Error('Weber has not implemented globalShortcut.setSuspended'); },
    isSuspended() { throw new Error('Weber has not implemented globalShortcut.isSuspended'); },
  };
  host.on('event', message => {
    if (message.event === 'global-shortcut') callbacks.get(message.callbackId)?.();
  });
  host.on('closed', () => callbacks.clear());
  return { createGlobalShortcut: () => api };
}
module.exports = { createGlobalShortcutBinding };

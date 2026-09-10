// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');
function createNotificationBinding({ host, app, unsupported }) {
  let nextId = 0;
  const objects = new Map();
  const live = new Map();
  const pending = new Map();
  const visible = new Set();
  const cleanup = new FinalizationRegistry(id => objects.delete(id));
  const ids = new WeakMap();
  function ready() { if (!app.isReady()) throw new Error('Notification requires app ready'); }
  class Notification extends EventEmitter {
    constructor(options = {}) {
      super(); ready();
      if (!options || typeof options !== 'object') throw new TypeError('Notification options must be an object');
      const id = ++nextId;
      ids.set(this, id); objects.set(id, new WeakRef(this)); cleanup.register(this, id);
      Object.assign(this, { title: '', subtitle: '', body: '', silent: false, icon: '',
        timeoutType: 'default', urgency: 'normal', actions: [], hasReply: false, replyPlaceholder: '',
        sound: '', closeButtonText: '', toastXml: '' }, options);
    }
    show() {
      ready();
      if (typeof this.icon !== 'string') return unsupported('Notification NativeImage icons');
      const options = { title: this.title, body: this.body, silent: this.silent, icon: this.icon,
        timeoutType: this.timeoutType, urgency: this.urgency, appName: app.getName() };
      // GTK only admits a bounded operation here. Waiting for the desktop
      // daemon and delivering show/click/close happen asynchronously in the host.
      const id = ids.get(this);
      live.set(id, this);
      pending.set(id, (pending.get(id) || 0) + 1);
      try { host.requestSync('notification.show', { notificationId: id, options }); }
      catch (error) {
        pending.set(id, pending.get(id) - 1);
        if (!pending.get(id) && !visible.has(id)) { live.delete(id); pending.delete(id); }
        throw error;
      }
    }
    close() { ready(); host.requestSync('notification.close', { notificationId: ids.get(this) }); }
  }
  host.on('event', message => {
    if (message.event !== 'notification') return;
    const id = message.notificationId;
    const instance = live.get(id) || objects.get(id)?.deref();
    if (!instance) return;
    // Native operations keep their JS owner alive until completion. In
    // particular, cross-realm wrappers must survive Bun's garbage collection.
    if (message.type === 'show' || message.type === 'failed') pending.set(id, Math.max(0, (pending.get(id) || 0) - 1));
    if (message.type === 'show') visible.add(id);
    if (message.type === 'close') visible.delete(id);
    if (!visible.has(id) && !pending.get(id)) { live.delete(id); pending.delete(id); }
    if (process.env.WEBER_NOTIFICATION_TRACE === '1') console.log(JSON.stringify({ kind: 'notification-event', id, type: message.type }));
    if (message.type === 'failed') instance.emit('failed', {}, message.error);
    else if (['show', 'click', 'close'].includes(message.type)) instance.emit(message.type, {});
  });
  return { Notification, isSupported: () => { ready(); return host.requestSync('notification.isSupported'); },
    getHistory: () => unsupported('Notification.getHistory on Linux'),
    remove: () => unsupported('Notification.remove on Linux'),
    removeAll: () => unsupported('Notification.removeAll on Linux'),
    removeGroup: () => unsupported('Notification.removeGroup on Linux') };
}
module.exports = { createNotificationBinding };

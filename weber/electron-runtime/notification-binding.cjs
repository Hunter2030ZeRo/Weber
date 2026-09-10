// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');
function createNotificationBinding({ host, app, unsupported }) {
  let nextId = 0;
  const objects = new Map();
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
      host.requestSync('notification.show', { notificationId: ids.get(this), options });
    }
    close() { ready(); host.requestSync('notification.close', { notificationId: ids.get(this) }); }
  }
  host.on('event', message => {
    if (message.event !== 'notification') return;
    const instance = objects.get(message.notificationId)?.deref();
    if (!instance) return;
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

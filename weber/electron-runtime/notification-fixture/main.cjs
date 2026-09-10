'use strict';
const { app, Notification } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const deadline = setTimeout(() => { console.error('Notification integration timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  const supported = Notification.isSupported();
  const notification = new Notification({ title: 'First', body: 'Text < & >', silent: true,
    urgency: 'low', timeoutType: 'never' });
  if (process.env.WEBER_NOTIFICATION_NO_SERVICE === '1') {
    assert.equal(supported, false);
    let shown = false; notification.on('show', () => { shown = true; });
    const failed = once(notification, 'failed'); notification.show();
    assert.ok((await failed)[1]); assert.equal(shown, false);
  } else {
    assert.equal(supported, true);
    notification.on('failed', (_event, error) => { console.error(error); app.exit(1); });
    const click = once(notification, 'click');
    const shown = once(notification, 'show'); notification.show();
    await shown; await click;
    let updates = 0;
    const updated = new Promise(resolve => notification.on('show', () => { if (++updates === 2) resolve(); }));
    notification.title = 'Second'; notification.show();
    notification.title = 'Third'; notification.show();
    await updated;
    let closed = 0; notification.on('close', () => { closed++; });
    const close = once(notification, 'close'); notification.close(); await close;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(closed, 1);
  }
  clearTimeout(deadline);
  console.log(JSON.stringify({ kind: 'native-notification-integration', backend: process.versions.bun ? 'bun' : 'node',
    supported, passed: true }));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

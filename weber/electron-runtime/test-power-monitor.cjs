// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createPowerBinding } = require('./power-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
function original() {
  const calls = [];
  const app = Object.assign(new EventEmitter(), {
    isReady: () => true, whenReady: () => Promise.resolve(), getName: () => 'shutdown test',
  });
  const host = Object.assign(new EventEmitter(), { requestSync(method, values) { calls.push({ method, ...values }); return true; } });
  const binding = createPowerBinding({ host, app });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_power_monitor' ? binding : saved(name);
  let api;
  try { api = createCommonJSLoader(() => undefined).load(path.join(__dirname, 'dist/browser/api/power-monitor.js')); }
  finally { process._linkedBinding = saved; }
  return { api, host, app, calls };
}
const shutdown = (host, generation) => host.emit('event', { event: 'power-monitor', type: 'shutdown', generation });
test('first shutdown listener enables native observation; first/last transitions only', () => {
  const { api, calls } = original();
  const a = () => {}, b = () => {};
  api.on('shutdown', a); api.on('shutdown', b); api.removeListener('shutdown', a); api.removeListener('shutdown', b);
  assert.deepEqual(calls.filter(c => c.method.endsWith('setListeningForShutdown')).map(c => c.listening), [true, false]);
});
test('non-shutdown first listener preserves later shutdown subscription', () => {
  const { api, calls } = original();
  api.on('suspend', () => {});
  assert.equal(calls.some(c => c.listening), false);
  api.on('shutdown', () => {});
  assert.equal(calls.at(-1).listening, true);
});
test('last once listener still supplies its synchronous cancellation decision', () => {
  const { api, host, calls } = original();
  let observed;
  api.once('shutdown', event => { observed = event; event.preventDefault(); });
  shutdown(host, 10);
  assert.equal(api.listenerCount('shutdown'), 0);
  assert.equal(observed.defaultPrevented, true);
  assert.deepEqual(calls.slice(-2), [
    { method: 'powerMonitor.setListeningForShutdown', listening: false, who: 'shutdown test' },
    { method: 'powerMonitor.shutdownDecision', generation: 10, prevented: true },
  ]);
});
test('ordinary completion, stale delivery and asynchronous preventDefault', () => {
  const { api, host, calls } = original();
  let event, count = 0;
  api.on('shutdown', value => { event = value; count++; });
  shutdown(host, 3); event.preventDefault();
  assert.equal(event.defaultPrevented, false);
  assert.equal(calls.at(-1).prevented, false);
  shutdown(host, 3); shutdown(host, 2); shutdown(host, NaN);
  assert.equal(count, 1);
});
test('listener exceptions still send a decision, then propagate the exception', () => {
  const { api, host, calls } = original();
  api.on('shutdown', () => { throw Error('listener failed'); });
  assert.throws(() => shutdown(host, 1), /listener failed/);
  assert.equal(calls.at(-1).prevented, false);
});
test('queued event after removal is released without invoking a removed listener', () => {
  const { api, host, calls } = original();
  const listener = () => assert.fail('removed');
  api.on('shutdown', listener); api.removeListener('shutdown', listener); shutdown(host, 1);
  assert.equal(calls.at(-1).prevented, false);
});
test('app quit closes cancellation lease; host closure prevents subsequent requests', () => {
  const { api, host, app, calls } = original();
  api.on('shutdown', event => { event.preventDefault(); app.emit('quit'); });
  shutdown(host, 1);
  assert.equal(calls.at(-1).method, 'powerMonitor.close');
  const other = original(); other.api.on('shutdown', () => {}); other.host.emit('closed');
  const count = other.calls.length;
  other.app.emit('quit'); shutdown(other.host, 4); other.api.removeAllListeners('shutdown');
  assert.equal(other.calls.length, count);
});

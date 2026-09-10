// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createPowerSaveBinding } = require('./power-save-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
function original() {
  const calls = [];
  let gen = 0;
  const app = Object.assign(new EventEmitter(), { getName: () => 'Owned inhibitor test' });
  const host = Object.assign(new EventEmitter(), { requestSync: (method, value) => { calls.push({ method, ...value }); return { generation: ++gen }; } });
  const powerSaveBlocker = createPowerSaveBinding({ host, app });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_power_save_blocker' ? { powerSaveBlocker } : saved(name);
  let api;
  try { api = createCommonJSLoader(() => undefined).load(path.join(__dirname, 'dist/browser/api/power-save-blocker.js')).default; }
  finally { process._linkedBinding = saved; }
  return { api, host, app, calls };
}
const weak = 'prevent-app-suspension', strong = 'prevent-display-sleep';
test('original API aggregates ids and only sends effective strength transitions', () => {
  const { api, calls } = original();
  const a = api.start(weak), b = api.start(weak), c = api.start(strong), d = api.start(strong);
  assert.equal(a, 0); assert.equal(new Set([a,b,c,d]).size, 4);
  for (let i = 0; i < 1000; i++) assert.equal(api.isStarted(b), true);
  assert.equal(api.stop(a), true); assert.equal(api.stop(c), true);
  assert.equal(calls.length, 2);
  assert.equal(api.stop(d), true); assert.equal(api.stop(b), true);
  assert.equal(api.stop(b), false); assert.equal(api.isStarted(b), false);
  assert.deepEqual(calls.map(x => x.mode), [weak, strong, weak, 'none']);
});
test('failed acquisition and downgrade preserve ids and cannot re-enter a mutation', () => {
  const { api, host } = original();
  const a = api.start(weak), saved = host.requestSync;
  host.requestSync = () => { assert.throws(() => api.start(strong), /Re-entrant/); throw Error('denied'); };
  assert.throws(() => api.start(strong), /denied/); assert.equal(api.isStarted(a), true);
  host.requestSync = saved;
  const b = api.start(strong); assert.equal(b, a + 1);
  host.requestSync = () => { throw Error('denied'); };
  assert.throws(() => api.stop(b), /denied/); assert.equal(api.isStarted(b), true);
  assert.equal(api.stop(a), true);
  host.requestSync = saved; assert.equal(api.stop(b), true);
});
test('lost generations, host closure and quit invalidate ownership without stale events', () => {
  const { api, host, app, calls } = original();
  const errors = []; app.on('weber-error', error => errors.push(error));
  const a = api.start(weak); const b = api.start(strong);
  host.emit('event', { event: 'power-save-blocker-lost', generation: 1 });
  assert.equal(api.isStarted(a), true);
  host.emit('event', { event: 'power-save-blocker-lost', generation: 2 });
  assert.equal(api.isStarted(a), false); assert.equal(api.isStarted(b), false); assert.equal(errors.length, 1);
  const c = api.start(weak); app.emit('quit');
  assert.equal(calls.at(-1).mode, 'none'); assert.equal(api.isStarted(c), false);
  assert.throws(() => api.start(weak), /closed/);
  const other = original(); other.api.start(weak); other.host.emit('closed');
  assert.equal(other.api.isStarted(0), false); assert.equal(other.api.stop(0), false);
});
test('bounded ids and input validation do not send spurious native calls', () => {
  const { api, calls } = original();
  assert.throws(() => api.start('idle'), TypeError);
  for (const id of [NaN, Infinity, 0.5, '0', 2147483648]) assert.throws(() => api.stop(id), TypeError);
  assert.equal(api.stop(-1), false);
  for (let i = 0; i < 128; i++) api.start(weak);
  assert.throws(() => api.start(weak), RangeError); assert.equal(calls.length, 1);
});

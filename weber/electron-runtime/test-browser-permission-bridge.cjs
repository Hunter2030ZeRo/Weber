// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
// Execute the actual trusted main-world bootstrap. Rust owns the dispatcher and
// stamps document identity in production; this suite checks its JS boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../crates/weber-engine/src/preload_main.js'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));

function realm() {
  const originalCalls = [];
  const old = name => () => { originalCalls.push(name); return Promise.resolve('old browser value'); };
  const navigator = {
    clipboard: { readText: old('clipboard.readText'), writeText: old('clipboard.writeText') },
    permissions: { query: old('permissions.query') },
    geolocation: {
      getCurrentPosition(success) { originalCalls.push('geolocation.getCurrentPosition'); success({ coords: { latitude: 0, longitude: 0 } }); },
      watchPosition(success) { originalCalls.push('geolocation.watchPosition'); success({ coords: { latitude: 0, longitude: 0 } }); return 99; },
      clearWatch: old('geolocation.clearWatch'),
    },
    mediaDevices: { getUserMedia: old('mediaDevices.getUserMedia'), getDisplayMedia: old('mediaDevices.getDisplayMedia') },
  };
  const context = vm.createContext({ navigator, DOMException });
  const privateDispatch = vm.runInContext(source, context, { filename: 'preload_main.js' });
  const command = payload => JSON.parse(privateDispatch(JSON.stringify(payload)));
  assert.equal(command({ method: 'install', exports: {} }).ok, true);
  const evaluate = code => vm.runInContext(code, context);
  const drain = () => {
    const response = command({ method: 'drain' });
    assert.equal(response.ok, true);
    return response.value;
  };
  const settle = (event, fields) => command({ method: 'resolveBrowserOperation', id: event.id, ...fields });
  return { context, command, evaluate, drain, settle, originalCalls };
}

test('clipboard APIs enqueue browser operations and settle their original promises', async () => {
  const r = realm();
  const result = r.evaluate(`Promise.all([
    navigator.clipboard.readText(),
    navigator.clipboard.writeText('Weber\\n한글🙂')
  ])`);
  const events = r.drain();
  assert.deepEqual(events, [
    { type: 'browser-operation', id: 1, action: 'clipboard-read', args: [] },
    { type: 'browser-operation', id: 2, action: 'clipboard-write', args: ['Weber\n한글🙂'] },
  ]);
  assert.equal(r.settle(events[0], { ok: true, value: 'native clipboard' }).ok, true);
  assert.equal(r.settle(events[1], { ok: true, value: null }).ok, true);
  assert.deepEqual(Array.from(await result), ['native clipboard', null]);
  assert.deepEqual(r.originalCalls, []);
  assert.deepEqual(r.drain(), []);
});

test('ordinary pages receive browser APIs without IPC or the private operation dispatcher', async () => {
  const r = realm();
  assert.deepEqual(Array.from(r.evaluate(`[
    typeof require, typeof ipcRenderer, typeof electron, typeof process,
    typeof dispatch, typeof browserOperation, typeof resolveBrowserOperation,
    typeof browserPending, typeof __weberDispatch,
    navigator.clipboard.readText.constructor('return typeof browserPending')()
  ]`)), Array(10).fill('undefined'));
  const result = r.evaluate(`
    globalThis.finished = false;
    globalThis.resolveBrowserOperation = () => 'forged';
    globalThis.dispatch = () => 'forged';
    navigator.clipboard.readText().then(value => { finished = true; return value; });
  `);
  const [event] = r.drain();
  r.evaluate(`resolveBrowserOperation({ id: 1, ok: true, value: 'forged' }); dispatch({ method: 'drain' });`);
  await turn();
  assert.equal(r.evaluate('finished'), false);
  assert.equal(r.settle(event, { ok: true, value: 'trusted response' }).ok, true);
  assert.equal(await result, 'trusted response');
});

test('browser operation tickets reject unknown, duplicate, malformed, and wrong-channel settlements', async () => {
  const r = realm();
  const result = r.evaluate('navigator.clipboard.readText()');
  const [event] = r.drain();
  const unknown = r.command({ method: 'resolveBrowserOperation', id: 999, ok: true, value: 'forged' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown browser operation ticket/);
  const wrongChannel = r.command({ method: 'settle', id: event.id, ok: true, value: 'forged' });
  assert.equal(wrongChannel.ok, false);
  assert.match(wrongChannel.error, /Unknown bridge call ticket/);
  for (const id of [0, -1, '1', 1.5]) {
    const invalid = r.command({ method: 'resolveBrowserOperation', id, ok: true, value: 'forged' });
    assert.equal(invalid.ok, false);
  }
  assert.equal(r.settle(event, { ok: 'yes', value: 'forged' }).ok, false);
  assert.equal(r.settle(event, { ok: true, value: 'once' }).ok, true);
  assert.equal(await result, 'once');
  const duplicate = r.settle(event, { ok: true, value: 'twice' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /Unknown browser operation ticket/);
});

test('permission queries snapshot descriptors and return the actual denied state', async () => {
  const r = realm();
  const result = r.evaluate(`
    const descriptor = { name: 'clipboard-read' };
    const result = navigator.permissions.query(descriptor);
    descriptor.name = 'geolocation';
    result.then(value => [value.state, Object.getPrototypeOf(value) === Object.prototype]);
  `);
  const [event] = r.drain();
  assert.deepEqual(event, { type: 'browser-operation', id: 1, action: 'permission-query', args: [{ name: 'clipboard-read' }] });
  assert.equal(r.settle(event, { ok: true, value: { state: 'denied' } }).ok, true);
  assert.deepEqual(Array.from(await result), ['denied', true]);
  assert.deepEqual(r.originalCalls, []);
});

test('media and display capture rejections preserve allowed DOMException names', async () => {
  const r = realm();
  const result = r.evaluate(`Promise.all([
    navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
    navigator.mediaDevices.getDisplayMedia({ audio: false, video: true }),
    navigator.clipboard.readText()
  ].map(result => result.then(() => ['unexpected success'], error =>
    [error.name, error instanceof DOMException, error.message])))`);
  const events = r.drain();
  assert.deepEqual(events.map(event => [event.type, event.action, event.args]), [
    ['browser-operation', 'media', [{ audio: true, video: false }]],
    ['browser-operation', 'display-media', [{ audio: false, video: true }]],
    ['browser-operation', 'clipboard-read', []],
  ]);
  for (const [i, name] of ['NotAllowedError', 'NotSupportedError', 'UntrustedErrorName'].entries()) {
    assert.equal(r.settle(events[i], { ok: false, error: 'denied by host', errorName: name }).ok, true);
  }
  assert.deepEqual(Array.from(await result, row => Array.from(row)), [
    ['NotAllowedError', true, 'denied by host'],
    ['NotSupportedError', true, 'denied by host'],
    ['NotAllowedError', true, 'denied by host'],
  ]);
  assert.deepEqual(r.originalCalls, []);
});

test('geolocation replaces permissive native stubs and reports permission denial without a position', async () => {
  const r = realm();
  const result = r.evaluate(`new Promise(resolve => navigator.geolocation.getCurrentPosition(
    () => resolve(['unexpected success']),
    error => resolve([error.code, error.PERMISSION_DENIED, error.POSITION_UNAVAILABLE,
      error.TIMEOUT, Object.isFrozen(error)])
  ))`);
  const [event] = r.drain();
  assert.deepEqual(event, { type: 'browser-operation', id: 1, action: 'geolocation', args: [] });
  assert.deepEqual(r.originalCalls, []);
  assert.equal(r.settle(event, { ok: false, error: 'location denied', errorName: 'NotAllowedError' }).ok, true);
  assert.deepEqual(Array.from(await result), [1, 1, 2, 3, true]);
  assert.deepEqual(r.originalCalls, []);
});

test('clearing a geolocation watch suppresses its pending failure callback', async () => {
  const r = realm();
  r.evaluate(`
    globalThis.successes = 0;
    globalThis.failures = 0;
    const watch = navigator.geolocation.watchPosition(() => successes++, () => failures++);
    navigator.geolocation.clearWatch(watch);
  `);
  const [event] = r.drain();
  assert.equal(event.action, 'geolocation');
  assert.equal(r.settle(event, { ok: false, error: 'location denied', errorName: 'NotAllowedError' }).ok, true);
  await turn();
  assert.deepEqual(Array.from(r.evaluate('[successes, failures]')), [0, 0]);
  assert.deepEqual(r.originalCalls, []);
});

test('inherited serialization hooks cannot intercept browser operation arguments or responses', async () => {
  const r = realm();
  const result = r.evaluate(`
    globalThis.hooks = 0;
    for (const prototype of [Object.prototype, Array.prototype]) {
      Object.defineProperty(prototype, 'toJSON', {
        configurable: true,
        get() { hooks++; throw Error('untrusted inherited serialization'); }
      });
    }
    Promise.all([
      navigator.clipboard.readText(),
      navigator.clipboard.writeText('copied'),
      navigator.permissions.query({ name: 'clipboard-read' }).then(value => value.state)
    ]);
  `);
  const events = r.drain();
  assert.deepEqual(events.map(event => event.type), Array(3).fill('browser-operation'));
  assert.deepEqual(events[1].args, ['copied']);
  for (const [i, value] of ['native value', null, { state: 'denied' }].entries()) {
    assert.equal(r.settle(events[i], { ok: true, value }).ok, true);
  }
  assert.deepEqual(Array.from(await result), ['native value', null, 'denied']);
  assert.equal(r.evaluate('hooks'), 0);
  assert.deepEqual(r.originalCalls, []);
});

test('renderer notifications remain denied when delivery is unsupported', async () => {
  const r = realm();
  assert.equal(r.evaluate('Notification.permission'), 'denied');
  assert.equal(r.evaluate(`(() => { try { new Notification('test'); } catch (error) { return error.name; } })()`), 'NotSupportedError');
  const result = r.evaluate(`
    globalThis.notificationCallbacks = 0;
    Notification.requestPermission(value => { if (value === 'denied') notificationCallbacks++; });
  `);
  const [event] = r.drain();
  assert.deepEqual(event, { type: 'browser-operation', id: 1, action: 'notification-permission', args: [] });
  assert.equal(r.settle(event, { ok: true, value: 'granted' }).ok, true);
  assert.equal(await result, 'denied');
  assert.equal(r.evaluate('notificationCallbacks'), 1);
  assert.equal(r.evaluate('Notification.permission'), 'denied');
});

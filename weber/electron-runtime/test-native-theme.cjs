// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createNativeThemeBinding } = require('./native-theme-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
function original() {
  const calls = [];
  let state = { themeSource: 'system', shouldUseDarkColors: false,
    shouldUseHighContrastColors: false, shouldUseDarkColorsForSystemIntegratedUI: false,
    shouldUseInvertedColorScheme: false, inForcedColorsMode: false };
  const host = Object.assign(new EventEmitter(), {
    requestSync(method) { calls.push(method); return state; },
  });
  const unsupported = name => { throw Object.assign(new Error(`Unsupported: ${name}`), { code: 'ERR_WEBER_UNSUPPORTED' }); };
  const binding = createNativeThemeBinding({ host, unsupported });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_native_theme' ? binding : saved(name);
  let api;
  try { api = createCommonJSLoader(() => undefined).load(path.join(__dirname, 'dist/browser/api/native-theme.js')); }
  finally { process._linkedBinding = saved; }
  return { api, host, calls, setState: value => { state = value; }, getState: () => state };
}
test('original nativeTheme module reads a real-host snapshot once, without app-ready restriction', () => {
  const { api, calls } = original();
  assert.ok(api instanceof EventEmitter);
  assert.deepEqual(calls, []);
  assert.equal(api.themeSource, 'system');
  assert.equal(api.shouldUseDarkColors, false);
  assert.equal(api.shouldUseHighContrastColors, false);
  assert.equal(api.shouldUseDarkColorsForSystemIntegratedUI, false);
  assert.equal(api.shouldUseInvertedColorScheme, false);
  assert.equal(api.inForcedColorsMode, false);
  for (let i = 0; i < 1000; i++) assert.equal(api.shouldUseDarkColors, false);
  assert.deepEqual(calls, ['nativeTheme.snapshot']);
  assert.throws(() => { api.shouldUseDarkColors = true; }, TypeError);
});
test('GTK updates invalidate cached reads; delayed event payloads cannot restore old state', () => {
  const { api, host, calls, setState, getState } = original();
  assert.equal(api.shouldUseDarkColors, false);
  const readings = [];
  api.on('updated', () => readings.push(api.shouldUseDarkColors));
  setState({ ...getState(), shouldUseDarkColors: true, shouldUseDarkColorsForSystemIntegratedUI: true });
  host.emit('event', { event: 'unrelated' });
  assert.equal(calls.length, 1);
  host.emit('event', { event: 'native-theme-updated', snapshot: { shouldUseDarkColors: false } });
  assert.deepEqual(readings, [true]);
  assert.equal(api.shouldUseDarkColorsForSystemIntegratedUI, true);
  setState({ ...getState(), shouldUseHighContrastColors: true });
  host.emit('event', { event: 'native-theme-updated' });
  assert.equal(api.shouldUseHighContrastColors, true);
  assert.equal(calls.length, 3);
});
test('system remains observational and unsupported theme overrides cannot change reported state', () => {
  const { api, calls } = original();
  let updates = 0;
  api.on('updated', () => updates++);
  api.themeSource = 'system';
  for (const value of ['light', 'dark']) assert.throws(() => { api.themeSource = value; }, { code: 'ERR_WEBER_UNSUPPORTED' });
  for (const value of ['', 'auto', null, undefined, 0, new String('system')])
    assert.throws(() => { api.themeSource = value; }, TypeError);
  assert.throws(() => api.prefersReducedTransparency, { code: 'ERR_WEBER_UNSUPPORTED' });
  assert.equal(api.themeSource, 'system');
  assert.equal(updates, 0);
  assert.deepEqual(calls, ['nativeTheme.snapshot']);
});
test('malformed snapshots and native failures never synthesize or retain appearance data', () => {
  const { api, host, setState, getState } = original();
  const valid = getState();
  setState({ ...valid, shouldUseDarkColors: 'false' });
  assert.throws(() => api.shouldUseDarkColors, /Invalid native theme snapshot/);
  setState({ ...valid, themeSource: 'dark' });
  assert.throws(() => api.themeSource, /Invalid native theme snapshot/);
  setState(valid);
  assert.equal(api.shouldUseDarkColors, false);
  host.emit('event', { event: 'native-theme-updated' });
  const saved = host.requestSync;
  host.requestSync = () => { throw new Error('GTK unavailable'); };
  assert.throws(() => api.shouldUseDarkColors, /GTK unavailable/);
  host.requestSync = saved;
  assert.equal(api.shouldUseDarkColors, false);
  let updates = 0;
  api.on('updated', () => updates++);
  host.emit('closed');
  host.emit('event', { event: 'native-theme-updated' });
  assert.equal(updates, 0);
  assert.throws(() => api.themeSource, /closed/);
  assert.throws(() => { api.themeSource = 'system'; }, /closed/);
  assert.equal(host.listenerCount('event'), 0);
});

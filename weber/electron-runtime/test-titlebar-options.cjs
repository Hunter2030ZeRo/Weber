// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowTitleBarOptions, titleBarOptions } = require('./titlebar-options.cjs');
test('VS Code hidden/frameless creation retains its overlay settings', () => {
  const input = { frame: false, titleBarStyle: 'hidden', titleBarOverlay: { height: 29, color: '#1e1e1e', symbolColor: '#fff' } };
  assert.deepEqual(windowTitleBarOptions(input), input);
  assert.deepEqual(windowTitleBarOptions({ titleBarStyle: 'hidden', titleBarOverlay: true }).titleBarOverlay, {});
  assert.equal(windowTitleBarOptions({}).titleBarOverlay, false);
});
test('updates preserve omission and reject invalid inputs before native dispatch', () => {
  assert.deepEqual(titleBarOptions({ height: 40 }), { height: 40 });
  assert.deepEqual(titleBarOptions({ color: '#fafafa' }), { color: '#fafafa' });
  for (const value of [false, null, [], 'red']) assert.throws(() => titleBarOptions(value), TypeError);
  for (const height of [-1, 0.5, NaN, Infinity, 513]) assert.throws(() => titleBarOptions({ height }), RangeError);
  for (const color of ['', 123, 'x'.repeat(257)]) assert.throws(() => titleBarOptions({ color }), TypeError);
  assert.throws(() => windowTitleBarOptions({ titleBarOverlay: true }), /requires/);
  assert.throws(() => windowTitleBarOptions({ titleBarStyle: 'hiddenInset' }), /Unsupported/);
});

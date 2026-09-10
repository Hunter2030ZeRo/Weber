// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
const { createDesktopCapturerBinding } = require('./desktop-capturer-binding.cjs');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN0cAAAAASUVORK5CYII=';
const source = () => ({ id: 'window:123:0', name: 'Test', display_id: '',
  thumbnail: { data: png, size: { width: 1, height: 1 } }, appIcon: null });
const turn = () => new Promise(resolve => setImmediate(resolve));
function setup(t, request) {
  const app = Object.assign(new EventEmitter(), { isReady: () => true });
  const host = Object.assign(new EventEmitter(), { request });
  const binding = createDesktopCapturerBinding({ app, host });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_desktop_capturer' ? binding : saved(name);
  let api;
  try {
    const loader = createCommonJSLoader(request => request === 'electron/main' ? { value: { BrowserWindow: {} } } : undefined);
    api = loader.load(path.join(__dirname, 'dist/browser/api/desktop-capturer.js'));
  } finally { process._linkedBinding = saved; }
  t.after(() => app.emit('quit'));
  return { api, app, host };
}
test('Electron source coalesces identical captures and returns copied PNG data', async t => {
  let calls = 0, resolve;
  const { api } = setup(t, (method, args) => {
    assert.equal(method, 'desktop.captureSources');
    assert.deepEqual(args, { captureWindow: true, captureScreen: false,
      thumbnailSize: { width: 150, height: 150 }, fetchWindowIcons: false });
    calls++; return new Promise(yes => { resolve = yes; });
  });
  const a = api.getSources({ types: ['window'] }), b = api.getSources({ types: ['window'] });
  await turn(); assert.equal(calls, 1); resolve([source()]);
  const [first, second] = await Promise.all([a, b]); assert.equal(first, second);
  const image = first[0].thumbnail;
  assert.equal(image.isEmpty(), false); assert.deepEqual(image.getSize(), { width: 1, height: 1 });
  assert.equal(image.toDataURL(), `data:image/png;base64,${png}`);
  const bytes = image.toPNG(); bytes.fill(0);
  assert.equal(image.toPNG().toString('base64'), png);
  const size = image.getSize(); size.width = 99; assert.equal(image.getSize().width, 1);
  assert.throws(() => image.toPNG({ scaleFactor: 2 }), /scale factor/);
  assert.throws(() => image.getAspectRatio(2), /scale factor/);
  assert.equal(first[0].appIcon, null); assert.equal(api.isDisplayMediaSystemPickerAvailable(), false);
});
test('failed captures clear Electron coalescing state and permit the same retry', async t => {
  let calls = 0;
  const { api } = setup(t, async () => { if (++calls === 1) throw new Error('Window disappeared'); return [source()]; });
  await assert.rejects(api.getSources({ types: ['window'] }), error => error === 'Window disappeared');
  assert.equal((await api.getSources({ types: ['window'] })).length, 1); assert.equal(calls, 2);
});
test('invalid dimensions and readiness fail through cleanup; zero thumbnails remain empty', async t => {
  let calls = 0;
  const { api, app } = setup(t, async () => { calls++; return [{ ...source(), thumbnail: { data: '', size: { width: 0, height: 0 } } }]; });
  for (let i = 0; i < 2; i++) await assert.rejects(api.getSources({ types: ['window'], thumbnailSize: { width: -1, height: 150 } }), error => /Invalid/.test(error));
  app.isReady = () => false;
  await assert.rejects(api.getSources({ types: ['screen'] }), error => /ready/.test(error));
  app.isReady = () => true;
  assert.deepEqual(await api.getSources({ types: [] }), []); assert.equal(calls, 0);
  const [item] = await api.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  assert.equal(item.thumbnail.isEmpty(), true); assert.equal(item.thumbnail.toPNG().length, 0);
});
test('native malformed image data is rejected and subsequent captures still work', async t => {
  let bad = true;
  const { api } = setup(t, async () => {
    const item = source(); if (bad) item.thumbnail.size.width = 2; return [item];
  });
  await assert.rejects(api.getSources({ types: ['window'] }), error => /PNG/.test(error));
  bad = false; assert.equal((await api.getSources({ types: ['window'] }))[0].thumbnail.getSize().width, 1);
});
test('quit and host loss reject outstanding captures and ignore late replies', async t => {
  for (const kind of ['quit', 'closed']) {
    let resolve;
    const { api, app, host } = setup(t, () => new Promise(yes => { resolve = yes; }));
    const pending = api.getSources({ types: ['window'] });
    const rejected = assert.rejects(pending, error => /closed/.test(error));
    await turn(); (kind === 'quit' ? app : host).emit(kind);
    await rejected; resolve([source()]); await turn();
    await assert.rejects(api.getSources({ types: ['window'] }), error => /closed/.test(error));
  }
});
test('distinct pending captures are bounded without preventing a later retry', async t => {
  const finishes = [];
  const { api } = setup(t, () => new Promise(yes => finishes.push(yes)));
  const args = width => ({ types: ['window'], thumbnailSize: { width, height: 100 } });
  const pending = Array.from({ length: 8 }, (_, i) => api.getSources(args(i + 1)));
  await assert.rejects(api.getSources(args(9)), error => /Too many/.test(error));
  for (const finish of finishes) finish([]); await Promise.all(pending);
  const retry = api.getSources(args(9)); await turn(); finishes.at(-1)([]); assert.deepEqual(await retry, []);
});

test('capture dimensions are copied before deferred native dispatch', async t => {
  let received;
  const { api } = setup(t, async (_method, args) => { received = args.thumbnailSize; return []; });
  const thumbnailSize = { width: 80, height: 60 };
  const result = api.getSources({ types: ['window'], thumbnailSize });
  thumbnailSize.width = 999;
  await result;
  assert.deepEqual(received, { width: 80, height: 60 });
});

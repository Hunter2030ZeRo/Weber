// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCipheriv } = require('node:crypto');
const path = require('node:path');
const { createSafeStorageBinding } = require('./safe-storage-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');

function original(options = {}) {
  let ready = false;
  const app = Object.assign(new EventEmitter(), { isReady: () => ready, getName: () => 'Safe storage test',
    commandLine: { getSwitchValue: () => options.backend || 'gnome-libsecret' } });
  const binding = createSafeStorageBinding({ app, unsupported: name => { throw Error('Unsupported: ' + name); },
    getPassword: () => Buffer.from('unit test password'), ...options });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_safe_storage' ? binding : saved(name);
  let api;
  try { api = createCommonJSLoader(() => undefined).load(path.join(__dirname, 'dist/browser/api/safe-storage.js')).default; }
  finally { process._linkedBinding = saved; }
  return { api, app, ready() { binding.freezeConfiguration(); ready = true; } };
}

test('original safeStorage enforces readiness, explicit basic opt-in and quit cleanup', async () => {
  const { api, app, ready } = original({ backend: 'basic' });
  assert.equal(api.getSelectedStorageBackend(), 'unknown');
  assert.equal(api.isEncryptionAvailable(), false);
  assert.throws(() => api.encryptString(''), /not available/);
  api.setUsePlainTextEncryption(true);
  assert.equal(api.isEncryptionAvailable(), false);
  ready(); assert.equal(api.getSelectedStorageBackend(), 'basic_text');
  assert.equal(api.isEncryptionAvailable(), true);
  assert.equal(api.encryptString('').length, 0);
  assert.equal(api.decryptString(Buffer.alloc(0)), '');
  const buffer = api.encryptString('한글\0 test 😀');
  assert.equal(buffer.subarray(0, 3).toString(), 'v10');
  assert.equal(api.decryptString(buffer), '한글\0 test 😀');
  api.setUsePlainTextEncryption(false);
  assert.throws(() => api.decryptString(buffer), /not available/);
  assert.throws(() => api.setUsePlainTextEncryption('true'), TypeError);
  assert.equal(await api.isAsyncEncryptionAvailable(), false);
  await assert.rejects(api.encryptStringAsync('text'), /Unsupported/);
  app.emit('quit'); api.setUsePlainTextEncryption(true);
  assert.equal(api.isEncryptionAvailable(), false);
});

test('OS password lookup happens once, is erased, and preserves Electron v11 and legacy reads', () => {
  let reads = 0; const secret = Buffer.from('unit test password');
  const { api, app, ready } = original({ getPassword: () => { reads++; return secret; } });
  ready(); app.getName = () => 'Renamed after ready';
  for (let n = 0; n < 100; n++) assert.equal(api.isEncryptionAvailable(), true);
  assert.equal(reads, 1); assert.ok(secret.every(n => n === 0));
  const buffer = api.encryptString('persistent text');
  assert.equal(buffer.subarray(0, 3).toString(), 'v11');
  assert.equal(api.decryptString(Buffer.from(JSON.parse(JSON.stringify(buffer)).data)), 'persistent text');
  const basic = original({ backend: 'basic' }); basic.ready(); basic.api.setUsePlainTextEncryption(true);
  assert.equal(api.decryptString(basic.api.encryptString('legacy text')), 'legacy text');
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('d0d0ec9c7d77d43ac54187fa4818d17f', 'hex'), Buffer.alloc(16, 32));
  const legacy = Buffer.concat([Buffer.from('v11'), cipher.update('old empty-password data'), cipher.final()]);
  assert.equal(api.decryptString(legacy), 'old empty-password data');
  app.emit('quit'); assert.equal(api.isEncryptionAvailable(), false);
});

test('unavailable and unsupported keyrings never silently become basic encryption', () => {
  let reads = 0;
  const { api, ready } = original({ getPassword: () => { reads++; return null; } });
  ready(); api.setUsePlainTextEncryption(true);
  assert.equal(api.isEncryptionAvailable(), false); assert.equal(api.isEncryptionAvailable(), false);
  assert.equal(reads, 1); assert.throws(() => api.encryptString('secret'), /not available/);
  const kde = original({ backend: 'kwallet6', getPassword: () => { throw Error('must not invoke libsecret'); } });
  kde.ready(); kde.api.setUsePlainTextEncryption(true);
  assert.equal(kde.api.getSelectedStorageBackend(), 'kwallet6');
  assert.equal(kde.api.isEncryptionAvailable(), false);
});

test('wrong types, prefixes, padding and bounded oversized payloads fail', () => {
  const { api, ready } = original(); ready();
  assert.throws(() => api.encryptString({}), TypeError);
  assert.throws(() => api.decryptString(new Uint8Array(19)), TypeError);
  assert.throws(() => api.encryptString('x'.repeat(4 * 1024 * 1024 + 1)), RangeError);
  const invalid = [Buffer.from('raw text'), Buffer.from('v11'), Buffer.concat([Buffer.from('v20'), Buffer.alloc(16)]),
    Buffer.concat([Buffer.from([0xf6, 0x31, 0x31]), Buffer.alloc(16)]), Buffer.concat([Buffer.from('v11'), Buffer.alloc(16)])];
  for (const value of invalid) assert.throws(() => api.decryptString(value));
});
module.exports = { original };

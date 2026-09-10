// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const options = JSON.parse(process.env.WEBER_SAFE_CASE);
let app, safeStorage, start;
if (process.versions.electron) {
  ({ app, safeStorage } = require('electron'));
  app.setName(options.application);
  app.commandLine.appendSwitch('password-store', options.backend);
  start = () => app.whenReady();
} else {
  let ready = false;
  app = Object.assign(new EventEmitter(), { getName: () => options.application, isReady: () => ready,
    commandLine: { getSwitchValue: () => options.backend } });
  const binding = require('../safe-storage-binding.cjs').createSafeStorageBinding({ app,
    unsupported: name => { throw Error(name); } });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_safe_storage' ? binding : saved(name);
  try { safeStorage = require('../commonjs-loader.cjs').createCommonJSLoader(() => undefined)
    .load(path.join(__dirname, '../dist/browser/api/safe-storage.js')).default; }
  finally { process._linkedBinding = saved; }
  start = async () => { binding.freezeConfiguration(); ready = true; };
}
assert.equal(safeStorage.isEncryptionAvailable(), false);
start().then(() => {
  if (options.basicOptIn) safeStorage.setUsePlainTextEncryption(true);
  const available = safeStorage.isEncryptionAvailable();
  const result = { available, backend: safeStorage.getSelectedStorageBackend() };
  if (available) {
    result.ciphertexts = (options.texts || []).map(text => safeStorage.encryptString(text).toString('base64'));
    result.plaintexts = (options.ciphertexts || []).map(text => safeStorage.decryptString(Buffer.from(text, 'base64')));
  } else assert.throws(() => safeStorage.encryptString('must not be stored'));
  fs.writeFileSync(options.output, JSON.stringify(result), { mode: 0o600 });
  if (process.versions.electron) app.exit(0); else app.emit('quit');
}).catch(error => { console.error(error.stack); if (process.versions.electron) app.exit(1); else process.exitCode = 1; });

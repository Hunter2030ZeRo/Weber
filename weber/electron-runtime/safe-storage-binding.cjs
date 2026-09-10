// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { spawnSync } = require('node:child_process');
const { pbkdf2Sync, createCipheriv, createDecipheriv } = require('node:crypto');
const path = require('node:path');

// Electron's retained OSCrypt Linux sync format. See safe-storage/README.md.
// This legacy CBC format is not authenticated; do not advertise tamper detection.
const iv = Buffer.alloc(16, 32);
const v10Key = Buffer.from('fd621fe5a2b402539dfa147ca9272778', 'hex');
const emptyKey = Buffer.from('d0d0ec9c7d77d43ac54187fa4818d17f', 'hex');
const maxBytes = 4 * 1024 * 1024;

function readSystemPassword(application, env) {
  const result = spawnSync(path.join(__dirname, 'dist/native/weber-secret-store'), [application], {
    env, shell: false, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 8192,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Never include helper stdout/stderr or subprocess errors in exceptions: they
  // can contain credentials or details from the user's keyring service.
  result.stderr?.fill(0);
  if (result.error || result.status !== 0 || !result.stdout?.length || result.stdout.length > 4096) {
    result.stdout?.fill(0); return null;
  }
  return result.stdout;
}

function createSafeStorageBinding({ app, unsupported, env = process.env, getPassword = readSystemPassword }) {
  let configuration, key, attempted = false, closed = false, allowBasic = false;
  function freezeConfiguration() {
    if (configuration) return;
    const requested = app.commandLine.getSwitchValue('password-store');
    const desktop = env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '';
    let backend = 'basic_text';
    if (requested === 'gnome-libsecret' || (!requested && /gnome|unity|xfce|cinnamon|deepin|pantheon|ukui|cosmic/i.test(desktop))) backend = 'gnome_libsecret';
    else if (/^kwallet[56]?$/.test(requested)) backend = requested;
    else if (!requested && /kde/i.test(desktop)) backend = 'kwallet' + (env.KDE_SESSION_VERSION || '5');
    else if (requested && requested !== 'basic') backend = 'unknown';
    const application = app.getName();
    if (typeof application !== 'string' || !application || application.includes('\0') || Buffer.byteLength(application) > 1024)
      throw new TypeError('Invalid safeStorage application name');
    configuration = { backend, application };
  }
  function available() {
    if (!app.isReady() || closed) return false;
    freezeConfiguration();
    if (configuration.backend === 'basic_text') return allowBasic;
    if (configuration.backend !== 'gnome_libsecret') return false;
    if (!attempted) {
      attempted = true;
      const password = getPassword(configuration.application, env);
      if (Buffer.isBuffer(password)) {
        try { if (password.length && password.length <= 4096) key = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1'); }
        finally { password.fill(0); }
      }
    }
    return !!key;
  }
  function requireAvailable() {
    if (!available()) throw new Error('safeStorage encryption is not available (ready app and unlocked supported keyring required)');
  }
  const safeStorage = {
    isEncryptionAvailable: available,
    getSelectedStorageBackend() {
      if (!app.isReady()) return 'unknown';
      freezeConfiguration(); return configuration.backend;
    },
    setUsePlainTextEncryption(value) {
      if (typeof value !== 'boolean') throw new TypeError('usePlainTextEncryption must be boolean');
      allowBasic = value;
    },
    encryptString(value) {
      if (typeof value !== 'string') throw new TypeError('safeStorage.encryptString requires a string');
      if (Buffer.byteLength(value) > maxBytes) throw new RangeError('safeStorage input exceeds 4 MiB');
      requireAvailable();
      if (!value.length) return Buffer.alloc(0);
      const cipher = createCipheriv('aes-128-cbc', key || v10Key, iv);
      return Buffer.concat([Buffer.from(key ? 'v11' : 'v10'), cipher.update(value, 'utf8'), cipher.final()]);
    },
    decryptString(value) {
      if (!Buffer.isBuffer(value)) throw new TypeError('safeStorage.decryptString requires a Buffer');
      if (value.length > maxBytes + 19) throw new RangeError('safeStorage input exceeds 4 MiB');
      requireAvailable();
      if (!value.length) return '';
      const prefix = value.subarray(0, 3).toString('latin1');
      if ((prefix !== 'v10' && prefix !== 'v11') || value.length <= 3 || (value.length - 3) % 16 || (prefix === 'v11' && !key))
        throw new Error('Invalid or unavailable safeStorage ciphertext');
      for (const candidate of [prefix === 'v11' ? key : v10Key, emptyKey]) {
        let first;
        try {
          const decipher = createDecipheriv('aes-128-cbc', candidate, iv);
          first = decipher.update(value.subarray(3));
          const last = decipher.final();
          const plaintext = Buffer.concat([first, last]);
          try { return plaintext.toString('utf8'); }
          finally { plaintext.fill(0); last.fill(0); }
        } catch { /* Retain Electron's legacy empty-password read fallback. */ }
        finally { first?.fill(0); }
      }
      throw new Error('Could not decrypt safeStorage ciphertext');
    },
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => unsupported('safeStorage async encryption and key migration'),
    decryptStringAsync: async () => unsupported('safeStorage async decryption and key migration'),
  };
  app.once('quit', () => { closed = true; key?.fill(0); key = undefined; });
  return { safeStorage, freezeConfiguration };
}
module.exports = { createSafeStorageBinding };

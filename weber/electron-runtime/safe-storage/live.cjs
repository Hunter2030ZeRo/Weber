// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync, spawn, execFileSync } = require('node:child_process');
const root = process.env.WEBER_SAFE_TEST_ROOT;
if (!root || process.env.HOME !== root || !process.env.DBUS_SESSION_BUS_ADDRESS) throw Error('Private test session required');
const electron = process.argv[2];
const runtimes = { ...(electron ? { electron } : {}), node: process.execPath, bun: 'bun' };
let counter = 0;
const texts = ['', 'public fixture text', '한글 😀\0 newline\n', 'test'.repeat(2048)];
const unlock = () => {
  const result = spawnSync('/usr/bin/gnome-keyring-daemon', ['--unlock', '--components=secrets'], {
    input: 'weber-owned-test-keyring-password\n', encoding: 'utf8', timeout: 10000,
  });
  if (result.error || result.status) throw Error('Could not unlock owned test keyring');
  const control = result.stdout.match(/^GNOME_KEYRING_CONTROL=(.+)$/m)?.[1];
  if (control) process.env.GNOME_KEYRING_CONTROL = control;
  // --unlock is the PAM-style first phase. Start the same daemon explicitly
  // so D-Bus activation cannot create another instance with a different control
  // socket, which would make a later --unlock target the wrong daemon.
  const started = spawnSync('/usr/bin/gnome-keyring-daemon', ['--start', '--components=secrets'], {
    encoding: 'utf8', timeout: 10000,
  });
  if (started.error || started.status) throw Error('Could not start owned test keyring');
};
function invocation(runtime, options, env = {}) {
  const output = path.join(root, 'result-' + counter++ + '.json');
  const args = [...(runtime === 'electron' ? ['--no-sandbox', '--disable-gpu', '--password-store=' + options.backend] : []), path.join(__dirname, 'probe.cjs')];
  return { output, executable: runtimes[runtime], args,
    env: { ...process.env, ...env, WEBER_SAFE_CASE: JSON.stringify({ ...options, output }) } };
}
function run(runtime, options, env) {
  const command = invocation(runtime, options, env);
  const result = spawnSync(command.executable, command.args, { env: command.env, timeout: 15000, encoding: 'utf8', maxBuffer: 16384 });
  if (result.error || result.status) throw Error(runtime + ' probe failed: ' + (result.stderr || result.error?.code));
  return JSON.parse(fs.readFileSync(command.output));
}
function concurrent(options) {
  const command = invocation('node', options);
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { env: command.env, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Concurrent probe timeout')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code) reject(Error('Concurrent probe failed')); else resolve(JSON.parse(fs.readFileSync(command.output)));
    });
  });
}
function dbus(method, args = []) {
  return execFileSync('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets',
    '--object-path', '/org/freedesktop/secrets', '--method', 'org.freedesktop.Secret.Service.' + method, ...args],
  { encoding: 'utf8', timeout: 5000 });
}
(async () => {
  unlock();
  let crossReads = 0;
  for (const backend of ['gnome-libsecret', 'basic']) {
    for (const writer of Object.keys(runtimes)) {
      const options = { application: 'Weber owned ' + backend + ' ' + writer, backend, basicOptIn: backend === 'basic' };
      const encrypted = run(writer, { ...options, texts });
      assert.equal(encrypted.available, true);
      assert.equal(encrypted.backend, backend === 'basic' ? 'basic_text' : 'gnome_libsecret');
      assert.equal(Buffer.from(encrypted.ciphertexts[1], 'base64').subarray(0, 3).toString(), backend === 'basic' ? 'v10' : 'v11');
      for (const reader of Object.keys(runtimes)) {
        assert.deepEqual(run(reader, { ...options, ciphertexts: encrypted.ciphertexts }).plaintexts, texts);
        crossReads++;
      }
    }
  }
  const options = { application: 'Weber concurrent owned key', backend: 'gnome-libsecret', texts: ['concurrent fixture'] };
  const results = await Promise.all(Array.from({ length: 6 }, () => concurrent(options)));
  for (const result of results) { assert.equal(result.available, true); assert.deepEqual(result.ciphertexts, results[0].ciphertexts); }
  const alias = dbus('ReadAlias', ['default']).match(/'(\/org\/freedesktop\/secrets\/collection\/[^']+)'/);
  assert.ok(alias, 'default collection exists');
  dbus('Lock', [JSON.stringify([alias[1]])]);
  for (const runtime of ['node', 'bun']) {
    assert.equal(run(runtime, options).available, false);
    assert.equal(run(runtime, { ...options, application: 'Missing key while locked' }).available, false);
    assert.equal(run(runtime, options, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + root + '/missing-bus' }).available, false);
    assert.equal(run(runtime, { ...options, backend: 'basic', basicOptIn: false }).available, false);
  }
  unlock();
  for (const runtime of ['node', 'bun']) {
    const restored = run(runtime, { ...options, ciphertexts: results[0].ciphertexts });
    assert.equal(restored.available, true, 'owned keyring was unlocked');
    assert.deepEqual(restored.plaintexts, options.texts, 'locked calls did not rotate the existing key');
  }
  console.log(JSON.stringify({ safeStorage: true, runtimes: Object.keys(runtimes), crossProcessReadCases: crossReads,
    concurrentFirstUse: 6, lockedAndUnavailableFailClosed: true, existingKeyPreservedAfterUnlock: true }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

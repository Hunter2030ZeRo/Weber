// Reject native objects owned by other addons before dereferencing their data.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const transport = require('../../dist/native/weber_platform.node');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weber-foreign-wrapper-'));

try {
  const headers = path.dirname(require.resolve('node-api-headers/package.json'));
  const addon = path.join(temporary, 'foreign-wrapper.node');
  const build = spawnSync(process.env.CXX || 'c++', [
    '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-shared',
    '-I', path.join(headers, 'include'), path.join(__dirname, 'foreign-wrapper.cc'), '-o', addon,
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, shell: false });
  if (build.error) throw build.error;
  assert.equal(build.status, 0, `Cannot compile foreign-wrapper fixture:\n${build.stderr}`);
  const foreign = require(addon);
  const operations = [
    ['childFd', value => transport.childFd(value)],
    ['releaseChild', value => transport.releaseChild(value)],
    ['request', value => transport.request(value, '{"id":1}', 100)],
    ['close', value => transport.close(value)],
  ];
  for (const [name, invoke] of operations) {
    const value = foreign.create();
    const before = foreign.inspect(value);
    assert.deepEqual(before, [2147483647, 2147483646]);
    let caught;
    try { invoke(value); } catch (error) { caught = error; }
    assert.deepEqual(foreign.inspect(value), before,
      `${name} must not modify another addon's native object`);
    assert.ok(caught instanceof Error, `${name} must reject another addon's native object`);
    assert.equal(caught.code, 'ERR_WEBER_PLATFORM_SYNC');
  }
  console.log(JSON.stringify({ ok: true, runtime: process.versions.bun ? 'Bun' : 'Node.js',
    foreignNativeWrapperRejectedBy: operations.map(([name]) => name), nativeStateUnchanged: true }));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

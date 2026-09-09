// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const transport = require('../dist/native/weber_platform.node');

async function peer(test) {
  const channel = transport.create();
  const child = spawn('python3', [path.join(__dirname, 'test-peer.py')], {
    stdio: ['ignore', 'ignore', 'inherit', transport.childFd(channel)], shell: false,
  });
  const exited = once(child, 'exit');
  transport.releaseChild(channel);
  try { test(channel); }
  finally {
    transport.close(channel);
    child.kill('SIGTERM');
    await exited;
  }
}
(async () => {
  await peer(channel => {
    for (let id = 1; id <= 10; id++) {
      const value = { id, unicode: 'Obscura 한글', nested: [true, false, null] };
      assert.deepEqual(JSON.parse(transport.request(channel, JSON.stringify({ id, value }), 1000)), { id, result: value });
    }
  });
  for (const method of ['close', 'oversize', 'delay']) {
    await peer(channel => {
      const start = performance.now();
      assert.throws(() => transport.request(channel, JSON.stringify({ id: 1, method }), method === 'delay' ? 100 : 1000));
      assert.ok(performance.now() - start < 1500, 'Native request must remain bounded');
      assert.throws(() => transport.request(channel, '{"id":2}', 100), /closed/);
    });
  }
  const channel = transport.create();
  assert.throws(() => transport.request(channel, 'x'.repeat(65537), 100), /64 KiB/);
  assert.throws(() => transport.request(channel, '{}', 100), /closed/);
  transport.close(channel);
  console.log(`Private synchronous Node-API transport passed on ${process.versions.bun ? 'Bun' : 'Node.js'}`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

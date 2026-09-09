'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { snapshot, ticksPerSecond, idleCpu } = require('./proc-tree.cjs');
const fs = require('node:fs');

test('Linux accounting includes the real child process and its CPU work', { timeout: 10000 }, async context => {
  if (Number(fs.readlinkSync('/proc/self')) !== process.pid) {
    context.skip('This environment exposes a /proc PID namespace different from the process API');
    return;
  }
  const child = spawn(process.execPath, ['-e', `
    process.stdin.once('data', () => {
      const start = performance.now();
      while (performance.now() - start < 200) {}
      process.stdout.write('done\\n');
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  try {
    assert.equal((await once(lines, 'line'))[0], 'ready');
    const first = snapshot(process.pid);
    assert.ok(first.processes.some(process => process.pid === child.pid));
    assert.ok(first.processes.some(process => process.pid === global.process.pid));
    assert.deepEqual(first.errors, []);
    assert.ok(first.pssBytes > 0);
    assert.ok(first.rssBytes >= first.pssBytes);
    const started = performance.now();
    child.stdin.write('work');
    assert.equal((await once(lines, 'line'))[0], 'done');
    const last = snapshot(process.pid);
    const result = idleCpu(first, last, performance.now() - started, ticksPerSecond());
    assert.equal(result.stableProcessSet, true);
    assert.ok(result.cpuTimeMs > 0);
    assert.ok(result.oneCorePercent > 0);
  } finally {
    child.kill('SIGTERM');
    lines.close();
    await once(child, 'exit');
  }
});

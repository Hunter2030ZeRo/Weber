'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { once } = require('node:events');
const { trackChild } = require('./process-cleanup.cjs');
const { snapshot, readStat } = require('./proc-tree.cjs');

test('cleanup reaps its child and terminates an owned helper that ignores SIGTERM', { timeout: 10000 }, async context => {
  if (Number(fs.readlinkSync('/proc/self')) !== process.pid) {
    context.skip('This environment exposes a different /proc PID namespace; group signaling is not safe here');
    return;
  }
  const helperSource = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready\\n');`;
  const child = spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helperSource)}], {stdio:['ignore','pipe','inherit']});
    helper.stdout.once('data', () => process.stdout.write('ready\\n'));
    process.stdin.once('data', () => process.exit(0));
  `], { detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const tracker = trackChild(child);
  const lines = readline.createInterface({ input: child.stdout });
  let cleaned = false;
  try {
    assert.equal((await once(lines, 'line'))[0], 'ready');
    const before = snapshot(child.pid);
    tracker.observe(before);
    const helper = before.processes.find(process => process.pid !== child.pid);
    assert.ok(helper, 'The actual helper process must be observed before cleanup');
    child.stdin.write('exit');
    await once(child, 'exit');
    const result = await tracker.cleanup();
    cleaned = true;
    assert.equal(result.status, 'drained');
    assert.equal(result.reaped, true);
    assert.equal(result.sentTerm, true);
    assert.equal(result.escalated, true);
    try {
      const current = readStat(helper.pid);
      assert.ok(current.startTicks !== helper.startTicks || ['Z', 'X'].includes(current.state));
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  } finally {
    child.stdin.destroy();
    lines.close();
    if (!cleaned) await tracker.cleanup();
  }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IpcReplyQueue } = require('./ipc-reply-queue.cjs');
const reply = (id, value, generation = 1) => ({ method: 'resolveIpc', generation, id: String(id), ok: true, value });

test('concurrent replies are ordered, bounded, copied once and flushed without a timer', async () => {
  const sent = [];
  const queue = new IpcReplyQueue(command => sent.push(command), error => { throw error; });
  const value = { number: 0 };
  for (let id = 0; id < 70; id++) { value.number = id; queue.push(reply(id, value)); }
  value.number = 999;
  await Promise.resolve();
  assert.deepEqual(sent.map(command => command.replies.length), [32, 32, 6]);
  assert.deepEqual(sent.flatMap(command => command.replies.map(item => item.value.number)), Array.from({ length: 70 }, (_, id) => id));
  queue.push(reply(100, 1));
  queue.clear(); // A replaced document cannot receive the queued reply.
  queue.push(reply(101, 2, 2));
  await Promise.resolve();
  assert.equal(sent.at(-1).method, 'resolveIpc');
  assert.equal(sent.at(-1).generation, 2);
  assert.equal(sent.at(-1).id, '101');
});

test('byte limits split batches without losing accepted replies', async () => {
  const sent = [];
  const queue = new IpcReplyQueue(command => sent.push(command), error => { throw error; });
  for (let id = 0; id < 4; id++) queue.push(reply(id, 'x'.repeat(160 * 1024)));
  assert.throws(() => queue.push(reply(99, 'x'.repeat(800 * 1024))), /768 KiB/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => queue.push(reply(100, cycle)), /circular|cyclic/i);
  await Promise.resolve();
  assert.deepEqual(sent.map(command => command.id), ['0', '1', '2', '3']);
  assert.ok(sent.every(command => Buffer.byteLength(JSON.stringify(command)) < 1024 * 1024));
});

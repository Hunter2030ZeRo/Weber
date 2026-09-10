const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const Module = require('node:module');
const nativeBinding = process._linkedBinding;
const originalLoad = Module._load;
process._linkedBinding = name => name === 'electron_browser_message_port' ? require('./message-port-binding.cjs') : nativeBinding(name);
Module._load = function(id, ...args) {
  if (id === '@electron/internal/browser/message-port-main') return originalLoad.call(this, require.resolve('./dist/browser/message-port-main.js'), ...args);
  return originalLoad.call(this, id, ...args);
};
const MessageChannelMain = require('./dist/browser/api/message-channel.js').default;
Module._load = originalLoad; process._linkedBinding = nativeBinding;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('original MessagePortMain queues until start and preserves structured values', { timeout: 2000 }, async () => {
  const { port1, port2 } = new MessageChannelMain();
  const data = { bytes: new Uint8Array([0, 128, 255]), value: 3n, map: new Map([['a', 1]]) }; data.self = data;
  port1.postMessage(data);
  let arrived = false; port2.on('message', () => { arrived = true; });
  await tick(); assert.equal(arrived, false);
  const received = once(port2, 'message'); port2.start();
  const [{ data: actual }] = await received;
  assert.equal(actual.self, actual); assert.deepEqual(actual.bytes, data.bytes);
  assert.equal(actual.value, 3n); assert.deepEqual(actual.map, data.map);
  assert.throws(() => port1.postMessage(() => {}), /clone/i);
  port1.close();
});

test('port ownership moves and queued messages survive transfer', { timeout: 2000 }, async () => {
  const transport = new MessageChannelMain(), payload = new MessageChannelMain();
  payload.port1.postMessage('queued before transfer');
  transport.port1.postMessage('take', [payload.port2]);
  assert.throws(() => payload.port2.postMessage('old owner'), /transferred/);
  const message = once(transport.port2, 'message'); transport.port2.start();
  const [{ ports }] = await message; assert.equal(ports.length, 1);
  const queued = once(ports[0], 'message'); ports[0].start();
  assert.equal((await queued)[0].data, 'queued before transfer');
  const response = once(payload.port1, 'message'); payload.port1.start(); ports[0].postMessage('new owner');
  assert.equal((await response)[0].data, 'new owner');
  payload.port1.close(); transport.port1.close();
});

test('full queues reject before transferring ownership and resume without loss', { timeout: 3000 }, async () => {
  const channel = new MessageChannelMain(), payload = new MessageChannelMain();
  for (let i = 0; i < 256; ++i) channel.port1.postMessage(i);
  assert.throws(() => channel.port1.postMessage('overflow', [payload.port2]), /256 messages/);
  const usable = once(payload.port1, 'message'); payload.port1.start(); payload.port2.postMessage('still owned');
  assert.equal((await usable)[0].data, 'still owned');
  const seen = []; channel.port2.on('message', event => seen.push(event.data)); channel.port2.start();
  while (seen.length < 256) await tick();
  assert.deepEqual(seen, Array.from({ length: 256 }, (_, i) => i));
  const resumed = once(channel.port2, 'message'); channel.port1.postMessage('resumed');
  assert.equal((await resumed)[0].data, 'resumed');
  assert.throws(() => channel.port1.postMessage(new Uint8Array(4 * 1024 * 1024 + 1)), /4 MiB/);
  const closed = once(channel.port2, 'close'); channel.port1.close(); await closed;
  payload.port1.close();
});

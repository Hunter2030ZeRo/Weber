// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { once, EventEmitter } = require('node:events');
const path = require('node:path');
const { createNetBinding } = require('./net-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
function original(t) {
  const app = Object.assign(new EventEmitter(), { isReady: () => true });
  const runtime = createNetBinding({ app }); t.after(() => runtime.close());
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_common_net' ? runtime.binding : saved(name);
  try {
    const loader = createCommonJSLoader(name => name === 'electron/main' ? { value: { app } } : undefined);
    return loader.load(path.join(__dirname, 'dist/browser/api/net-websocket.js')).WebSocket;
  } finally { process._linkedBinding = saved; }
}
async function echo(t) {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: echo\r\n\r\n');
    let buffer = Buffer.alloc(0);
    socket.on('data', part => {
      buffer = Buffer.concat([buffer, part]);
      while (buffer.length >= 2) {
        const length = buffer[1] & 127;
        assert.ok(length < 126); assert.ok(buffer[1] & 128);
        if (buffer.length < length + 6) return;
        const opcode = buffer[0] & 15, mask = buffer.subarray(2, 6);
        const payload = Buffer.from(buffer.subarray(6, 6 + length));
        for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(6 + length);
        const reply = Buffer.concat([Buffer.from([128 | opcode, length]), payload]);
        if (opcode === 8) socket.end(reply); else socket.write(reply);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `ws://127.0.0.1:${server.address().port}`;
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('WebSocket failed before ' + name));
    socket.addEventListener('error', fail, { once: true });
    socket.addEventListener(name, value => { socket.removeEventListener('error', fail); resolve(value); }, { once: true });
  });
}
test('original WebSocket transfers ordered text/binary/blob and exact ArrayBuffers over a real connection', { timeout: 10000 }, async t => {
  const WebSocket = original(t), url = await echo(t);
  const socket = new WebSocket(url, 'echo');
  await event(socket, 'open'); assert.equal(socket.protocol, 'echo');
  const values = [];
  socket.addEventListener('message', event => values.push(event.data));
  const first = event(socket, 'message'); socket.send('hello'); await first;
  assert.equal(values[0], 'hello');
  socket.binaryType = 'arraybuffer';
  const second = event(socket, 'message'); socket.send(new Uint8Array([0, 128, 255])); await second;
  assert.deepEqual([...new Uint8Array(values[1])], [0, 128, 255]); assert.equal(values[1].byteLength, 3);
  socket.binaryType = 'nodebuffer';
  const ordered = new Promise(resolve => {
    socket.addEventListener('message', () => { if (values.length === 4) resolve(); });
  });
  socket.send(new Blob([new Uint8Array([7, 8])])); socket.send('after blob'); await ordered;
  assert.deepEqual(values[2], Buffer.from([7, 8])); assert.equal(values[3], 'after blob');
  const closed = event(socket, 'close'); socket.close(1000, 'done');
  const close = await closed; assert.equal(close.code, 1000); assert.equal(close.reason, 'done'); assert.equal(close.wasClean, true);
});
test('WebSocket session options fail explicitly and original validation remains intact', t => {
  const WebSocket = original(t);
  assert.throws(() => new WebSocket('ws://127.0.0.1/', { useSessionCookies: true }), /session cookies/);
  assert.throws(() => new WebSocket('ws://127.0.0.1/', { headers: { Authorization: 'secret' } }), /headers/);
  assert.throws(() => new WebSocket('ws://127.0.0.1/#fragment'), /fragment/);
  assert.throws(() => new WebSocket('ws://127.0.0.1/', ['same', 'same']), /invalid/);
});

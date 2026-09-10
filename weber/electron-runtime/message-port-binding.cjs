// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { serialize, deserialize } = require('node:v8');
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 256;
const endpoints = new WeakMap();
const cloneError = message => new DOMException(message, 'DataCloneError');

function wrap(endpoint) {
  const port = { emit() {}, start() {
    const state = endpoints.get(this);
    if (!state || state.closed) return;
    state.started = true; schedule(state);
  }, close() {
    const state = endpoints.get(this);
    if (!state || state.closed) return;
    close(state);
  }, postMessage(data, transfer = []) {
    const state = endpoints.get(this);
    if (!state) throw cloneError('MessagePort has been transferred');
    if (state.closed || !state.peer || state.peer.closed) return;
    if (!Array.isArray(transfer) || transfer.length > 64) throw cloneError('Invalid MessagePort transfer list');
    const moved = transfer.map(port => endpoints.get(port));
    if (new Set(moved).size !== moved.length || moved.some(endpoint => !endpoint || endpoint.closed || endpoint === state))
      throw cloneError('Duplicate, closed, detached or self-transferred MessagePort');
    // Native structuredClone rejects functions and preserves cycles, typed
    // arrays, Maps, Sets and BigInts. The serialized queue stores one payload
    // until delivery, rather than a second persistent object graph.
    const payload = serialize(structuredClone(data));
    const peer = state.peer;
    if (payload.length > MAX_BYTES || peer.bytes + payload.length > MAX_BYTES || peer.queue.length >= MAX_MESSAGES)
      throw new RangeError('MessagePort delivery queue exceeds 4 MiB or 256 messages');
    // Validate and reserve before moving ownership: failed admission never
    // detaches transfer-list ports or silently drops an accepted message.
    const ports = moved.map((endpoint, index) => {
      endpoints.delete(transfer[index]);
      endpoint.started = false;
      return wrap(endpoint);
    });
    peer.bytes += payload.length;
    peer.queue.push({ payload, ports });
    schedule(peer);
  } };
  endpoints.set(port, endpoint); endpoint.owner = port;
  return port;
}
function schedule(endpoint) {
  if (endpoint.scheduled || !endpoint.started || endpoint.closed || !endpoint.queue.length) return;
  endpoint.scheduled = true;
  setImmediate(() => {
    endpoint.scheduled = false;
    if (!endpoint.started || endpoint.closed) return;
    // Yield after a bounded batch so a busy extension channel cannot starve
    // native window events or another channel's messages.
    let count = 0;
    try {
      while (endpoint.started && !endpoint.closed && endpoint.queue.length && count++ < 32) {
        const message = endpoint.queue.shift(); endpoint.bytes -= message.payload.length;
        endpoint.owner.emit('message', { data: deserialize(message.payload), ports: message.ports });
      }
    } finally { schedule(endpoint); }
  });
}
function close(endpoint) {
  if (endpoint.closed) return;
  endpoint.closed = true;
  const queued = endpoint.queue.splice(0); endpoint.bytes = 0;
  for (const message of queued) for (const port of message.ports) port.close();
  const peer = endpoint.peer; endpoint.peer = null;
  if (peer) { peer.peer = null; close(peer); }
  setImmediate(() => endpoint.owner.emit('close'));
}
function createPair() {
  const endpoint = () => ({ owner: null, peer: null, queue: [], bytes: 0, started: false, scheduled: false, closed: false });
  const first = endpoint(), second = endpoint(); first.peer = second; second.peer = first;
  return { port1: wrap(first), port2: wrap(second) };
}
module.exports = { createPair };

// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { serialize, deserialize } = require('node:v8');
const { EventEmitter } = require('node:events');
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 256;

// Same-backend, private socket protocol. It is not exposed to document scripts.
// Retain serialized bytes while paused; never accumulate decoded object graphs.
class UtilityWire extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.outgoing = 0;
    this.length = null;
    this.closed = false;
    socket.on('readable', () => this.read());
    socket.on('error', error => this.fail(error));
    socket.on('end', () => {
      if (this.length !== null || socket.readableLength) this.fail(new Error('Truncated utility message'));
      else this.close();
    });
    socket.on('close', () => this.close());
  }
  prepare(message, copied = false) {
    if (this.closed) throw new Error('Utility channel is closed');
    const bytes = serialize(copied ? message : structuredClone(message));
    if (bytes.length > MAX_BYTES || this.socket.writableLength + bytes.length + 4 > MAX_BYTES || this.outgoing >= MAX_MESSAGES)
      throw new RangeError('Utility channel exceeds 4 MiB or 256 pending messages');
    const frame = Buffer.allocUnsafe(bytes.length + 4);
    frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
    return frame;
  }
  sendPrepared(frame) {
    if (this.closed) throw new Error('Utility channel is closed');
    this.outgoing++;
    this.socket.write(frame, error => {
      this.outgoing--;
      if (error) this.fail(error);
    });
  }
  send(message) { this.sendPrepared(this.prepare(message)); }
  read() {
    try {
      // Node's readable buffering assembles chunks; no repeated Buffer.concat
      // of a growing large message, and no idle polling timer.
      for (let n = 0; n < 32 && !this.closed; n++) {
        if (this.length === null) {
          const header = this.socket.read(4);
          if (!header) return;
          this.length = header.readUInt32BE();
          if (!this.length || this.length > MAX_BYTES) throw new Error('Invalid utility frame length');
        }
        const bytes = this.socket.read(this.length);
        if (!bytes) return;
        this.length = null;
        this.emit('message', deserialize(bytes), bytes.length);
      }
      if (!this.closed && this.socket.readableLength) setImmediate(() => this.read());
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    try { this.emit('failure', error); }
    finally { this.emit('closed'); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('closed');
  }
}
module.exports = { UtilityWire, MAX_BYTES, MAX_MESSAGES };

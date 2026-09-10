// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// Batch replies produced by the same event-loop turn without a timer or an
// additional task delay. Admission remains bounded by bytes and message count.
class IpcReplyQueue {
  constructor(send, onError) {
    this.send = send;
    this.onError = onError;
    this.clear();
    this.scheduled = false;
  }
  clear() { this.items = []; this.bytes = 0; }
  push(reply) {
    // Copy once at admission: mutations/getters in an application's return
    // value must not change a reply while it waits for the microtask flush.
    const encoded = JSON.stringify(reply);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > 768 * 1024) throw new RangeError('IPC reply exceeds 768 KiB');
    const value = JSON.parse(encoded);
    if (this.items.length && (this.bytes + bytes > 256 * 1024 ||
        this.items[0].generation !== value.generation)) this.flush();
    this.items.push(value);
    this.bytes += bytes;
    if (this.items.length >= 32 || this.bytes >= 256 * 1024) this.flush();
    if (!this.scheduled && this.items.length) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; this.flush(); });
    }
  }
  flush() {
    if (!this.items.length) return;
    const replies = this.items;
    this.clear();
    const command = replies.length === 1 ? replies[0] : {
      method: 'resolveIpcBatch', generation: replies[0].generation, replies,
    };
    try { Promise.resolve(this.send(command)).catch(this.onError); }
    catch (error) { this.onError(error); }
  }
}
module.exports = { IpcReplyQueue };

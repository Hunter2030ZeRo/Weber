// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { serialize, deserialize } = require('node:v8');
const { MAX_BYTES, MAX_MESSAGES } = require('./utility-wire.cjs');
class UtilityInbox {
  constructor(deliver) {
    this.deliver = deliver; this.queue = []; this.bytes = 0;
    this.started = false; this.closed = false; this.scheduled = false;
  }
  receive(data, ports) {
    if (this.closed) return;
    const bytes = serialize(data);
    if (this.queue.length >= MAX_MESSAGES || this.bytes + bytes.length > MAX_BYTES)
      throw new RangeError('Paused utility port exceeds 4 MiB or 256 messages');
    this.bytes += bytes.length; this.queue.push({ bytes, ports }); this.schedule();
  }
  start() { this.started = true; this.schedule(); }
  pause() { this.started = false; }
  close() { this.closed = true; this.queue.length = 0; this.bytes = 0; }
  schedule() {
    if (this.scheduled || this.closed || !this.started || !this.queue.length) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        for (let n = 0; n < 32 && this.started && !this.closed && this.queue.length; n++) {
          const { bytes, ports } = this.queue.shift(); this.bytes -= bytes.length;
          this.deliver({ data: deserialize(bytes), ports });
        }
      } finally { this.schedule(); }
    });
  }
}
module.exports = { UtilityInbox };

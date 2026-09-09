// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

class HostClient extends EventEmitter {
  constructor(executable, args = []) {
    super();
    if (!path.isAbsolute(executable)) throw new Error('Weber desktop host path must be absolute');
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`Weber desktop host exited (${signal || code})`));
    });
    this.child.stdin.on('error', error => this.fail(error));
  }

  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 96 * 1024 * 1024) {
      this.fail(new Error('Weber host response exceeded the frame limit'));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch {
        this.fail(new Error('Weber host returned malformed JSON'));
        return;
      }
      if (message.event) {
        this.emit('event', message);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.fail(new Error('Weber host returned an unknown request id'));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error(String(message.error)));
      else pending.resolve(message.result);
    }
  }

  request(method, parameters = {}) {
    if (this.closed) return Promise.reject(new Error('Weber desktop host is closed'));
    if (this.pending.size >= 256) return Promise.reject(new Error('Too many pending Weber host requests'));
    const id = ++this.nextId;
    const line = JSON.stringify({ ...parameters, id, method }) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024) return Promise.reject(new Error('Weber host request exceeds 1 MiB'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Weber host request timed out: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(line);
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.child.stdin.destroy();
    // EOF is the host's graceful shutdown signal; it must reap its renderers.
    this.emit('closed', error);
  }

  close() {
    if (this.closed) return;
    this.child.stdin.end();
  }
}

module.exports = { HostClient };

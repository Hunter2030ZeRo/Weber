import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export const MAX_FRAME = 1024 * 1024;
const PREFIX = '@weber:';

/** A private child-process pipe, never a listening TCP/WebSocket server. */
export class Transport extends EventEmitter {
  #child;
  #pending = new Map();
  #sequence = 0;
  #buffer = Buffer.alloc(0);
  #failure;
  #ready;
  #resolveReady;
  #rejectReady;
  #readyTimer;

  constructor(executable, { args = [], timeout = 30_000 } = {}) {
    super();
    this.timeout = timeout;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // Prevent an unhandled rejection before the application awaits ready().
    this.#ready.catch(() => {});
    this.#readyTimer = setTimeout(() => this.#fail(new Error('Weber host startup timed out')), timeout);
    this.#child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
    this.#child.stdin.on('error', error => this.#fail(error));
    this.#child.on('error', error => this.#fail(error));
    this.#child.on('exit', (code, signal) => {
      this.#fail(new Error(`Weber host exited (${signal ?? code})`));
      this.emit('exit', code, signal);
    });
  }

  ready() { return this.#ready; }

  #fail(error) {
    if (this.#failure) return;
    this.#failure = error;
    clearTimeout(this.#readyTimer);
    this.#rejectReady(error);
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.#child.kill();
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let newline;
    while ((newline = this.#buffer.indexOf(10)) !== -1) {
      if (newline > MAX_FRAME) return this.#fail(new Error('Host frame exceeds 1 MiB'));
      const line = this.#buffer.subarray(0, newline).toString('utf8');
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (!line.startsWith(PREFIX)) continue;
      let message;
      try { message = JSON.parse(line.slice(PREFIX.length)); }
      catch { return this.#fail(new Error('Invalid JSON from Weber host')); }
      if (!message || typeof message !== 'object') return this.#fail(new Error('Invalid host frame'));
      if (message.event === 'ready') {
        if (message.protocol !== 1) return this.#fail(new Error('Unsupported Weber protocol'));
        clearTimeout(this.#readyTimer);
        this.#resolveReady();
      } else if (message.event) {
        this.emit('event', message);
      } else {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (typeof message.error === 'string') pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      }
    }
    if (this.#buffer.length > MAX_FRAME) this.#fail(new Error('Host frame exceeds 1 MiB'));
  }

  async request(method, params = {}) {
    await this.ready();
    if (this.#failure) throw this.#failure;
    if (this.#pending.size >= 256) throw new Error('Too many pending Weber requests');
    const id = ++this.#sequence;
    const frame = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('Request exceeds 1 MiB');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Weber request timed out: ${method}`));
      }, this.timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(frame, error => { if (error) this.#fail(error); });
    });
  }

  close() { this.#fail(new Error('Weber transport closed')); }
}

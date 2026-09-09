import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transport } from './transport.mjs';

/** One host per application. Node and Bun use the same protocol and API. */
export function createApplication({ hostPath, hostArgs = [], timeout = 30_000 } = {}) {
  const binary = hostPath ?? process.env.WEBER_HOST ?? fileURLToPath(new URL(
    `../../target/release/weber-host${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
  let transport;
  const windows = new Map();
  const handlers = new Map();
  const app = new EventEmitter();
  const getTransport = () => {
    if (!transport) {
      transport = new Transport(binary, { args: hostArgs, timeout });
      transport.on('exit', (code, signal) => {
        for (const win of windows.values()) win.emit('closed');
        windows.clear();
        app.emit('quit', code, signal);
      });
      transport.on('event', message => {
        if (message.event === 'frame-presented') windows.get(message.window)?.emit('ready-to-show', message);
        if (message.event === 'closed') {
          const win = windows.get(message.window);
          windows.delete(message.window);
          win?.emit('closed');
          if (!windows.size) app.emit('window-all-closed');
        }
        if (message.event === 'invoke') void handleInvoke(message);
      });
    }
    return transport;
  };
  async function handleInvoke(message) {
    const win = windows.get(message.window);
    let result = null;
    let error;
    try {
      if (!win || !win.allowedChannels.has(message.channel)) throw new Error('IPC channel denied');
      const handler = handlers.get(message.channel);
      if (!handler) throw new Error(`No handler for ${message.channel}`);
      result = await handler({ sender: win.webContents }, message.payload);
      // Serialize here so non-JSON handler output becomes a renderer error.
      result = JSON.parse(JSON.stringify(result ?? null));
    } catch (cause) { error = String(cause?.message ?? cause); }
    try {
      await getTransport().request('ipc.reply', {
        window: message.window, epoch: message.epoch, call: message.call, result, error
      });
    } catch (cause) { app.emit('ipc-error', cause); }
  }
  app.whenReady = () => getTransport().ready();
  app.quit = async () => {
    if (!transport) return;
    try { await transport.request('app.quit'); } finally { transport.close(); }
  };
  // Explicit immediate cleanup for startup failures and tests.
  app.dispose = () => transport?.close();
  const ipcMain = {
    handle(channel, handler) {
      if (typeof channel !== 'string' || !channel || typeof handler !== 'function') throw new TypeError('Expected a channel and handler');
      if (handlers.has(channel)) throw new Error(`Handler already registered: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) { handlers.delete(channel); }
  };
  class BrowserWindow extends EventEmitter {
    constructor({ width = 960, height = 640, title = 'Weber', show = true, allowedChannels = [], ...unsupported } = {}) {
      super();
      if (Object.keys(unsupported).length) throw new Error(`Unsupported BrowserWindow options: ${Object.keys(unsupported).join(', ')}`);
      if (!Array.isArray(allowedChannels) || allowedChannels.some(c => typeof c !== 'string' || !c)) throw new TypeError('Invalid allowedChannels');
      this.allowedChannels = new Set(allowedChannels);
      this.ready = getTransport().request('window.create', { width, height, title, show, allowedChannels }).then(id => {
        this.id = id;
        windows.set(id, this);
        return this;
      });
      this.ready.catch(() => {});
      this.webContents = {
        executeJavaScript: source => this.#request('window.evaluate', { source }),
        getURL: () => this.#request('window.url')
      };
    }
    async #request(method, params = {}) {
      await this.ready;
      if (!windows.has(this.id)) throw new Error('Window is closed');
      return getTransport().request(method, { ...params, window: this.id });
    }
    loadFile(path) { return this.#request('window.loadFile', { path: resolve(path) }); }
    setTitle(title) { return this.#request('window.title', { title }); }
    show() { return this.#request('window.visible', { visible: true }); }
    hide() { return this.#request('window.visible', { visible: false }); }
    close() { return this.#request('window.close'); }
    // Remote pages are deliberately outside this trusted-local-app prototype.
    loadURL() { return Promise.reject(new Error('loadURL is not implemented; use loadFile for a trusted local app')); }
  }
  return { app, BrowserWindow, ipcMain };
}

const defaults = createApplication();
export const { app, BrowserWindow, ipcMain } = defaults;

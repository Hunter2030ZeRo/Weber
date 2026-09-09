import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transport } from './transport.mjs';

/** One host per application. Node and Bun use the same protocol and API. */
export function createApplication({ hostPath, hostArgs = [], timeout = 30_000 } = {}) {
  const binary = hostPath ?? process.env.WEBER_HOST ?? fileURLToPath(new URL(
    `../../target/release/weber-host${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
  let transport;
  const windows = new Map(); // Public IDs, allocated synchronously and never reused.
  const hostWindows = new Map();
  const state = new WeakMap();
  let nextWindowId = 0;
  let readyPromise;
  let isReady = false;
  function forgetWindow(win) {
    const entry = state.get(win);
    if (entry.destroyed) return;
    entry.destroyed = true;
    windows.delete(win.id);
    if (entry.hostId !== undefined) hostWindows.delete(entry.hostId);
    win.webContents.emit('destroyed');
    win.emit('closed');
  }
  const handlers = new Map();
  const app = new EventEmitter();
  const getTransport = () => {
    if (!transport) {
      transport = new Transport(binary, { args: hostArgs, timeout });
      transport.on('exit', (code, signal) => {
        isReady = false;
        for (const win of [...windows.values()]) forgetWindow(win);
        app.emit('quit', code, signal);
      });
      transport.on('event', message => {
        if (message.event === 'frame-presented') hostWindows.get(message.window)?.emit('ready-to-show', message);
        if (message.event === 'closed') {
          const win = hostWindows.get(message.window);
          if (win) {
            forgetWindow(win);
            if (!windows.size) app.emit('window-all-closed');
          }
        }
        if (message.event === 'invoke') void handleInvoke(message);
      });
    }
    return transport;
  };
  async function handleInvoke(message) {
    const win = hostWindows.get(message.window);
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
  app.whenReady = () => {
    if (!readyPromise) {
      readyPromise = getTransport().ready().then(() => {
        isReady = true;
        app.emit('ready');
      });
      readyPromise.catch(() => {});
    }
    return readyPromise;
  };
  app.isReady = () => isReady;
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
    handleOnce(channel, handler) {
      if (typeof handler !== 'function') throw new TypeError('Expected a channel and handler');
      ipcMain.handle(channel, (...args) => {
        // Remove before user code runs, including before its first await.
        handlers.delete(channel);
        return handler(...args);
      });
    },
    removeHandler(channel) { handlers.delete(channel); }
  };
  class BrowserWindow extends EventEmitter {
    constructor({ width = 960, height = 640, title = 'Weber', show = true, allowedChannels = [], ...unsupported } = {}) {
      super();
      if (Object.keys(unsupported).length) throw new Error(`Unsupported BrowserWindow options: ${Object.keys(unsupported).join(', ')}`);
      if (!Array.isArray(allowedChannels) || allowedChannels.some(c => typeof c !== 'string' || !c)) throw new TypeError('Invalid allowedChannels');
      Object.defineProperty(this, 'id', { value: ++nextWindowId, enumerable: true });
      this.allowedChannels = new Set(allowedChannels);
      const entry = { destroyed: false, hostId: undefined, url: '' };
      state.set(this, entry);
      windows.set(this.id, this);
      this.webContents = Object.assign(new EventEmitter(), {
        executeJavaScript: source => this.#request('window.evaluate', { source }),
        getURL: () => { this.#assertAlive(); return entry.url; },
        isDestroyed: () => entry.destroyed
      });
      Object.defineProperty(this.webContents, 'id', { value: this.id, enumerable: true });
      this.ready = app.whenReady().then(() => getTransport().request('window.create', {
        width, height, title, show, allowedChannels
      })).then(id => {
        if (entry.destroyed) throw new Error('Window is closed');
        entry.hostId = id;
        hostWindows.set(id, this);
        return this;
      }).catch(error => {
        forgetWindow(this);
        throw error;
      });
      this.ready.catch(() => {});
    }
    static getAllWindows() { return [...windows.values()]; }
    static fromId(id) { return windows.get(id) ?? null; }
    static fromWebContents(contents) {
      return [...windows.values()].find(win => win.webContents === contents) ?? null;
    }
    isDestroyed() { return state.get(this).destroyed; }
    #assertAlive() {
      if (this.isDestroyed()) throw new Error('Window is closed');
    }
    async #request(method, params = {}) {
      await this.ready;
      this.#assertAlive();
      return getTransport().request(method, { ...params, window: state.get(this).hostId });
    }
    async loadFile(path) {
      await this.#request('window.loadFile', { path: resolve(path) });
      const url = await this.#request('window.url');
      this.#assertAlive();
      state.get(this).url = url;
      this.webContents.emit('did-finish-load');
    }
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

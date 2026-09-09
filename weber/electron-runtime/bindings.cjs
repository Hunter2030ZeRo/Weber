// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// These objects replace Electron's native binding boundary. Public BrowserWindow
// and WebContents JavaScript behavior is loaded from the original Electron tree.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const os = require('node:os');

function unsupported(name) {
  const error = new Error(`Weber has not implemented ${name}`);
  error.code = 'ERR_WEBER_UNSUPPORTED';
  throw error;
}
function event(sender) {
  return { sender, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

function createBindings(host, appPath, loadInternal) {
  const windows = new Map();
  const contents = new Map();
  const bindings = new Map();
  let nextId = 0;
  let ready = false;
  let quitting = false;
  let resolveReady;
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });
  const nativeExit = process.exit.bind(process);
  const app = new EventEmitter();
  let applicationPath = appPath;
  let name = path.basename(appPath);
  let version = '0.0.0';
  const appPaths = new Map();
  Object.assign(app, {
    applicationMenu: null,
    commandLine: {
      hasSwitch: value => process.argv.includes(`--${value}`),
      getSwitchValue: value => process.argv.find(a => a.startsWith(`--${value}=`))?.slice(value.length + 3) || '',
      appendSwitch: () => unsupported('app.commandLine.appendSwitch after runtime startup'),
    },
    isReady: () => ready,
    whenReady: () => readyPromise,
    getAppPath: () => applicationPath,
    setAppPath: value => { applicationPath = path.resolve(value); },
    getName: () => name,
    setName: value => { name = String(value); },
    getVersion: () => version,
    setVersion: value => { version = String(value); },
    getPath(key) {
      if (appPaths.has(key)) return appPaths.get(key);
      const known = { home: os.homedir(), temp: os.tmpdir(), exe: process.execPath,
        appData: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        userData: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name) };
      if (!(key in known)) return unsupported(`app.getPath(${key})`);
      return known[key];
    },
    setPath: (key, value) => { if (!path.isAbsolute(value)) throw new Error('Path must be absolute'); appPaths.set(key, value); },
    exit(code = 0) {
      if (quitting) return;
      quitting = true;
      app.emit('quit', event(app), code);
      // Ask the native host to close windows and reap its renderer processes.
      host.close();
      const timer = setTimeout(() => { host.child.kill('SIGTERM'); nativeExit(code); }, 3000);
      timer.unref();
      host.child.once('exit', () => nativeExit(code));
      if (host.child.exitCode !== null) nativeExit(code);
    },
    quit() {
      const before = event(app);
      app.emit('before-quit', before);
      if (before.defaultPrevented) return;
      for (const win of [...windows.values()]) win.close();
      if (windows.size === 0) app.exit(0);
      else quittingAfterWindows = true;
    },
  });
  let quittingAfterWindows = false;
  Object.defineProperty(app, 'name', { get: () => name, set: value => { name = String(value); } });

  function startWindow(self, options) {
    if (!ready) throw new Error('Cannot create BrowserWindow before app is ready');
    EventEmitter.call(self);
    self.id = ++nextId;
    self._destroyed = false;
    self._visible = options.show !== false;
    self._focused = false;
    self._bounds = { x: options.x ?? 0, y: options.y ?? 0,
      width: options.width ?? 800, height: options.height ?? 600 };
    self._title = options.title ?? name;
    self._options = options;
    self._parent = options.parent ?? null;
    self._ready = host.request('window.create', { windowId: self.id,
      options: { ...self._bounds, title: self._title, show: self._visible } });
    self._ready.catch(error => { self.emit('creation-failed', error); app.emit('weber-error', error); });
    windows.set(self.id, self);
  }

  function BaseWindow(options = {}) {
    startWindow(this, options);
    this._init();
  }
  Object.assign(BaseWindow, {
    fromId: id => windows.get(id) || null,
    getAllWindows: () => [...windows.values()],
    clearPersistedState: () => unsupported('BaseWindow.clearPersistedState'),
  });
  Object.assign(BaseWindow.prototype, {
    isDestroyed() { return this._destroyed; },
    isVisible() { return this._visible && !this._destroyed; },
    isFocused() { return this._focused && !this._destroyed; },
    isMinimized() { return false; },
    isEnabled() { return !this._destroyed; },
    getBounds() { return { ...this._bounds }; },
    getContentBounds() { return { ...this._bounds }; },
    getSize() { return [this._bounds.width, this._bounds.height]; },
    getContentSize() { return this.getSize(); },
    getTitle() { return this._title; },
    setTitle(title) {
      this._title = String(title);
      this._host('window.setTitle', { title: this._title }).catch(error => app.emit('weber-error', error));
    },
    getParentWindow() { return this._parent; },
    getChildWindows() { return [...windows.values()].filter(w => w._parent === this); },
    _host(method, parameters = {}) {
      if (this._destroyed) return Promise.reject(new Error('Object has been destroyed'));
      return this._ready.then(() => host.request(method, { ...parameters, windowId: this.id }));
    },
    setBounds(bounds) {
      const updated = { ...this._bounds, ...bounds };
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isFinite(updated[key])) throw new TypeError(`Invalid ${key}`);
      }
      if (updated.width <= 0 || updated.height <= 0) throw new RangeError('Window dimensions must be positive');
      this._bounds = updated;
      this._host('window.setBounds', { bounds: updated }).catch(error => app.emit('weber-error', error));
    },
    setSize(width, height) { this.setBounds({ width, height }); },
    setContentSize(width, height) { this.setSize(width, height); },
    show() { this._host('window.show').then(() => { this._visible = true; this.emit('show'); }).catch(error => app.emit('weber-error', error)); },
    hide() { this._host('window.hide').then(() => { this._visible = false; this.emit('hide'); }).catch(error => app.emit('weber-error', error)); },
    close() {
      if (this._destroyed || this._closing) return;
      const closing = event(this);
      this.emit('close', closing);
      if (closing.defaultPrevented) return;
      this._closing = true;
      this._host('window.close').then(() => finishWindow(this)).catch(error => {
        this._closing = false;
        app.emit('weber-error', error);
      });
    },
    destroy() {
      if (this._destroyed) return;
      this._host('window.close').then(() => finishWindow(this)).catch(error => app.emit('weber-error', error));
    },
    setMenu(menu) { if (menu !== null) return unsupported('native window menu'); },
  });
  for (const method of ['focus', 'blur', 'maximize', 'unmaximize', 'minimize',
    'restore', 'setFullScreen', 'setAlwaysOnTop', 'setResizable', 'center', 'setBackgroundColor']) {
    BaseWindow.prototype[method] = function () { return unsupported(`BaseWindow.${method}`); };
  }

  function finishWindow(win) {
    if (win._destroyed) return;
    win._destroyed = true;
    win._visible = false;
    windows.delete(win.id);
    win.webContents?._destroy();
    win.emit('closed');
    if (windows.size === 0) {
      app.emit('window-all-closed');
      if (quittingAfterWindows) app.exit(0);
    }
  }

  class WebContents extends EventEmitter {
    constructor(options = {}, owner) {
      super();
      if (!owner) return unsupported('standalone WebContents without a native view');
      this.id = owner.id;
      this._owner = owner;
      this._url = '';
      this._title = '';
      this._loading = false;
      this._destroyed = false;
      this._navigation = 0;
      this._history = [];
      this._historyIndex = -1;
      this._prefs = { contextIsolation: true, nodeIntegration: false, sandbox: true, ...options };
      this._rendererPid = 0;
      owner._ready.then(result => { this._rendererPid = result?.rendererPid || 0; }).catch(() => {});
      this.mainFrame = {
        frameTreeNodeId: this.id, routingId: this.id,
        get processId() { return owner.webContents?._rendererPid || 0; },
        _sendInternal: (command, requestId, method, ...args) => this._invokeFrame(command, requestId, method, args),
        send: () => unsupported('webContents.send renderer IPC'),
        postMessage: () => unsupported('webContents.postMessage and transferred ports'),
      };
      this.mainFrame.top = this.mainFrame;
      contents.set(this.id, this);
      this._init();
    }
    _command(command) { return this._owner._host('page.command', { command }); }
    _invokeFrame(command, requestId, method, args) {
      const ipc = loadInternal('browser/ipc-main-internal').ipcMainInternal;
      const response = `${command}_RESPONSE_${requestId}`;
      const senderEvent = { type: 'frame', sender: this, frameTreeNodeId: this.id };
      let promise;
      if (command !== 'RENDERER_WEB_FRAME_METHOD') {
        promise = Promise.reject(new Error(`Unsupported internal message ${command}`));
      } else if (method === 'executeJavaScript') {
        promise = this._command({ method: 'evaluate', source: args[0] });
      } else {
        promise = Promise.reject(new Error(`Weber has not implemented webFrame.${method}`));
      }
      promise.then(result => ipc.emit(response, senderEvent, null, result),
        error => ipc.emit(response, senderEvent, error));
    }
    _loadURL(target, options = {}) {
      if (this._destroyed) throw new Error('Object has been destroyed');
      if (Object.keys(options).some(key => options[key] !== undefined)) {
        return unsupported('loadURL options (referrer, headers, postData and userAgent)');
      }
      const serial = ++this._navigation;
      this._loading = true;
      this.emit('did-start-loading');
      this.emit('did-start-navigation', event(this), target, false, true);
      this._command({ method: 'loadURL', url: String(target) }).then(state => {
        if (this._destroyed || serial !== this._navigation) return;
        this._url = state?.url || String(target);
        this._title = state?.title || '';
        this._loading = false;
        this._history.splice(this._historyIndex + 1);
        this._history.push({ url: this._url, title: this._title });
        this._historyIndex = this._history.length - 1;
        this.emit('dom-ready', event(this));
        this.emit('did-navigate', event(this), this._url, 200, 'OK');
        this.emit('did-frame-finish-load', event(this), true, this._rendererPid, this.id);
        this.emit('did-finish-load', event(this));
        this.emit('did-stop-loading', event(this));
        this.emit('ready-to-show');
      }, error => {
        if (this._destroyed || serial !== this._navigation) return;
        this._loading = false;
        this.emit('did-fail-load', event(this), -2, error.message, String(target), true);
        this.emit('did-stop-loading', event(this));
      });
    }
    getURL() { return this._url; }
    getTitle() { return this._title; }
    isLoading() { return this._loading; }
    isLoadingMainFrame() { return this._loading; }
    isDestroyed() { return this._destroyed; }
    getLastWebPreferences() { return { ...this._prefs }; }
    getType() { return 'window'; }
    getOwnerBrowserWindow() { return this._owner; }
    getOSProcessId() { return this._rendererPid; }
    isFocused() { return this._owner.isFocused(); }
    isDevToolsFocused() { return false; }
    isDevToolsOpened() { return false; }
    _setConsoleMessageObserved(enabled) { if (enabled) return unsupported('console-message subscription'); }
    _destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._loading = false;
      contents.delete(this.id);
      this.emit('destroyed');
    }
    close() { this._owner.close(); }
    destroy() { this._owner.destroy(); }
    reload() { this.loadURL(this._url).catch(error => app.emit('weber-error', error)); }
    _canGoBack() { return this._historyIndex > 0; }
    _canGoForward() { return this._historyIndex + 1 < this._history.length; }
    _canGoToOffset(offset) { return this._historyIndex + offset >= 0 && this._historyIndex + offset < this._history.length; }
    _getActiveIndex() { return this._historyIndex; }
    _historyLength() { return this._history.length; }
    _getNavigationEntryAtIndex(index) { return this._history[index] ? { ...this._history[index] } : null; }
    _getHistory() { return this._history.map(entry => ({ ...entry })); }
    async capturePage(rect) {
      if (rect !== undefined) return unsupported('capturePage subrectangle');
      const result = await this._command({ method: 'capturePng' });
      if (result?.encoding !== 'base64' || typeof result.data !== 'string') throw new Error('Invalid capture response');
      const png = Buffer.from(result.data, 'base64');
      return { isEmpty: () => png.length === 0, toPNG: () => Buffer.from(png),
        getSize: () => ({ width: this._owner._bounds.width, height: this._owner._bounds.height }) };
    }
  }
  for (const method of ['_clearHistory', '_goBack', '_goForward', '_goToIndex', '_goToOffset',
    '_removeNavigationEntryAtIndex', '_restoreHistory', 'openDevTools', 'closeDevTools',
    'executeJavaScriptInIsolatedWorld']) {
    WebContents.prototype[method] = function () { return unsupported(`WebContents.${method}`); };
  }

  function BrowserWindow(options = {}) {
    const preferences = options.webPreferences || {};
    if (preferences.preload) return unsupported('isolated Electron preload; main-world injection is not a substitute');
    if (preferences.nodeIntegration) return unsupported('Node integration inside the Obscura renderer');
    if (process.env.WEBER_UNSANDBOXED_DEVELOPMENT !== '1') {
      throw new Error('The development host has no OS sandbox. Explicitly set WEBER_UNSANDBOXED_DEVELOPMENT=1 for trusted local development.');
    }
    startWindow(this, options);
    this.webContents = new WebContents(preferences, this);
    this.contentView = {
      addChildView: () => unsupported('embedding additional WebContentsView'),
      removeChildView: () => unsupported('embedding additional WebContentsView'),
    };
    this._init();
  }

  function View() { unsupported('View construction'); }
  function WebContentsView() { unsupported('WebContentsView construction'); }
  bindings.set('electron_browser_base_window', { BaseWindow });
  bindings.set('electron_browser_window', { BrowserWindow });
  bindings.set('electron_browser_web_contents', { WebContents,
    fromId: id => contents.get(id), getAllWebContents: () => [...contents.values()],
    fromFrame: frame => contents.get(frame?.frameTreeNodeId),
    fromDevToolsTargetId: () => unsupported('DevTools target lookup') });
  bindings.set('electron_browser_view', { View });
  bindings.set('electron_browser_web_contents_view', { WebContentsView });
  bindings.set('electron_browser_printing', { getPrinterListAsync: () => unsupported('printing') });
  bindings.set('electron_common_command_line', app.commandLine);
  bindings.set('electron_common_environment', { hasVar: key => process.env[key] !== undefined });

  host.on('event', message => {
    const win = windows.get(message.windowId);
    if (!win) return;
    const type = message.event.replace(/^window\./, '');
    if (type === 'closed') finishWindow(win);
    else if (type === 'close-requested') win.close();
    else if (type === 'focus' || type === 'blur') {
      win._focused = type === 'focus';
      win.emit(type, event(win));
    } else if (type === 'resize') {
      if (message.width && message.height) Object.assign(win._bounds, { width: message.width, height: message.height });
      win.emit('resize');
    } else if (type === 'render-process-gone') {
      win.webContents.emit('render-process-gone', event(win.webContents), {
        reason: 'crashed', exitCode: message.exitCode ?? -1,
      });
    } else if (type === 'frame-presented') {
      win.webContents.emit('weber-first-frame-presented', message);
    } else if (type === 'frame-error') {
      app.emit('weber-error', new Error(message.error || 'Native frame presentation failed'));
    }
  });
  host.on('closed', error => {
    for (const win of [...windows.values()]) finishWindow(win);
    if (!quitting) app.emit('weber-error', error);
  });

  return { app, bindings, unsupported,
    finishStartup() {
      app.emit('will-finish-launching');
      ready = true;
      app.emit('ready', event(app), {});
      resolveReady();
    },
  };
}

module.exports = { createBindings };

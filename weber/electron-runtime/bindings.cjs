// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// These objects replace Electron's native binding boundary. Public BrowserWindow
// and WebContents JavaScript behavior is loaded from the original Electron tree.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createMenuBinding } = require('./menu-binding.cjs');
const { createClipboardBinding } = require('./clipboard-binding.cjs');
const { attachPlatformApp } = require('./platform-app.cjs');
const { createProtocolBinding } = require('./protocol-binding.cjs');
const { createGlobalShortcutBinding } = require('./global-shortcut-binding.cjs');
const { IpcReplyQueue } = require('./ipc-reply-queue.cjs');

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
  Object.assign(app, {
    applicationMenu: null,
    commandLine: {
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
  attachPlatformApp(app, { getName: () => name });
  const protocolRuntime = createProtocolBinding({ app, host, windows, unsupported });
  const menuBinding = createMenuBinding({ host, windows, app, unsupported });
  Object.defineProperty(app, 'applicationMenu', {
    get: () => loadInternal('browser/api/menu').getApplicationMenu(),
    set: menu => loadInternal('browser/api/menu').setApplicationMenu(menu),
  });

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
      options: { ...self._bounds, title: self._title, show: self._visible, closable: options.closable !== false } });
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
    isClosable() { return this._options.closable !== false; },
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
    setMenu(menu) { menuBinding.setWindowMenu(this, menu); },
  });
  for (const method of ['focus', 'blur', 'maximize', 'unmaximize', 'minimize',
    'restore', 'setFullScreen', 'setAlwaysOnTop', 'setResizable', 'center', 'setBackgroundColor',
    'isMinimizable', 'isFullScreenable']) {
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
      this.session = options.session || protocolRuntime.session.fromPartition(options.partition || '');
      this._url = '';
      this._title = '';
      this._loading = false;
      this._destroyed = false;
      this._navigation = 0;
      this._generation = null;
      this._evaluations = new Map();
      this._nextEvaluation = 0;
      this._ipcRequests = new Set();
      this._ipcReplies = new IpcReplyQueue(command => this._command(command),
        error => app.emit('weber-error', error));
      this._deferredEvents = [];
      this._history = [];
      this._historyIndex = -1;
      this._prefs = { contextIsolation: true, nodeIntegration: false, sandbox: true, ...options };
      this._preloadSource = owner._preloadSource;
      this._rendererPid = 0;
      owner._ready.then(result => { this._rendererPid = result?.rendererPid || 0; }).catch(() => {});
      this.mainFrame = {
        frameTreeNodeId: this.id, routingId: this.id,
        get processId() { return owner.webContents?._rendererPid || 0; },
        _sendInternal: (command, requestId, method, ...args) => this._invokeFrame(command, requestId, method, args),
        send: (channel, ...args) => this._sendToRenderer(channel, args),
        postMessage: () => unsupported('webContents.postMessage and transferred ports'),
      };
      this.mainFrame.top = this.mainFrame;
      contents.set(this.id, this);
      this._init();
    }
    _command(command) { return this._owner._host('page.command', { command }); }
    _sendToRenderer(channel, args) {
      if (this._destroyed) throw new Error('Object has been destroyed');
      if (typeof channel !== 'string' || !channel || Buffer.byteLength(channel) > 1024) throw new TypeError('Invalid IPC channel');
      if (this._generation === null) throw new Error('Renderer document is not ready for IPC');
      const command = { method: 'sendToRenderer', generation: this._generation, channel, args };
      // Validate before enqueueing so obvious serialization failures remain
      // synchronous, as with Electron's send API.
      JSON.stringify(command);
      this._command(command).catch(error => app.emit('weber-error', error));
    }
    _invokeFrame(command, requestId, method, args) {
      const ipc = loadInternal('browser/ipc-main-internal').ipcMainInternal;
      const response = `${command}_RESPONSE_${requestId}`;
      const senderEvent = { type: 'frame', sender: this, frameTreeNodeId: this.id };
      let promise;
      if (command !== 'RENDERER_WEB_FRAME_METHOD') {
        promise = Promise.reject(new Error(`Unsupported internal message ${command}`));
      } else if (method === 'executeJavaScript') {
        // A pending Promise that invokes ipcMain must yield the renderer's
        // command loop so its reply can be delivered. Synchronous evaluate
        // cannot provide that bidirectional progress.
        promise = this._preloadSource === undefined ?
          this._command({ method: 'evaluate', source: args[0] }) : this._evaluateTicket(args[0]);
      } else {
        promise = Promise.reject(new Error(`Weber has not implemented webFrame.${method}`));
      }
      promise.then(result => ipc.emit(response, senderEvent, null, result),
        error => ipc.emit(response, senderEvent, error));
    }
    _evaluateTicket(source) {
      if (this._evaluations.size >= 256) return Promise.reject(new Error('Too many pending evaluations'));
      const id = String(++this._nextEvaluation);
      const generation = this._generation;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._evaluations.delete(id);
          reject(new Error('JavaScript evaluation timed out'));
        }, 15000);
        this._evaluations.set(id, { resolve, reject, timer, generation });
        this._command({ method: 'startEvaluation', id, source }).then(ack => {
          if (ack?.generation !== generation) {
            const pending = this._evaluations.get(id);
            if (pending) { clearTimeout(pending.timer); this._evaluations.delete(id); pending.reject(new Error('Document changed during evaluation')); }
          }
        }, error => {
          const pending = this._evaluations.get(id);
          if (pending) { clearTimeout(pending.timer); this._evaluations.delete(id); pending.reject(error); }
        });
      });
    }
    _rejectEvaluations(message) {
      for (const pending of this._evaluations.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      this._evaluations.clear();
      this._ipcRequests.clear();
      this._ipcReplies.clear();
    }
    _engineEvent(message) {
      if (this._destroyed || !message || typeof message !== 'object') return;
      if (this._loading && ['ipc-invoke', 'ipc-send', 'evaluation-result'].includes(message.type)) {
        if (this._deferredEvents.length >= 256) {
          this._rejectEvaluations('Renderer event queue overflow during navigation');
          app.emit('weber-error', new Error('Too many renderer events during navigation'));
        } else this._deferredEvents.push(message);
        return;
      }
      if (message.type === 'evaluation-result') {
        const pending = this._evaluations.get(message.id);
        if (!pending || message.generation !== pending.generation || message.generation !== this._generation) return;
        clearTimeout(pending.timer);
        this._evaluations.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(String(message.error || 'JavaScript evaluation failed')));
      } else if (message.type === 'ipc-send') {
        if (message.generation !== this._generation || typeof message.channel !== 'string' || !Array.isArray(message.args)) return;
        const ipcEvent = { type: 'frame', sender: this, senderFrame: this.mainFrame,
          processId: this._rendererPid, frameId: this.id, frameTreeNodeId: this.id,
          reply: (channel, ...args) => this._sendToRenderer(channel, args) };
        const ipc = loadInternal('browser/api/ipc-main').default;
        this.emit('ipc-message', ipcEvent, message.channel, ...message.args);
        this.ipc.emit(message.channel, ipcEvent, ...message.args);
        ipc.emit(message.channel, ipcEvent, ...message.args);
      } else if (message.type === 'ipc-invoke') {
        if (message.generation !== this._generation || typeof message.id !== 'string' ||
            typeof message.channel !== 'string' || !Array.isArray(message.args) || this._ipcRequests.has(message.id)) return;
        if (this._ipcRequests.size >= 256) return;
        this._ipcRequests.add(message.id);
        const ipc = loadInternal('browser/api/ipc-main').default;
        const handler = this.ipc._invokeHandlers.get(message.channel) || ipc._invokeHandlers.get(message.channel);
        const ipcEvent = { type: 'frame', sender: this, senderFrame: this.mainFrame,
          processId: this._rendererPid, frameId: this.id, frameTreeNodeId: this.id };
        Promise.resolve().then(() => {
          if (!handler) throw new Error(`No handler registered for '${message.channel}'`);
          return handler(ipcEvent, ...message.args);
        }).then(value => this._resolveIpc(message, true, value), error => this._resolveIpc(message, false, String(error.message || error)));
      }
    }
    _resolveIpc(request, ok, result) {
      this._ipcRequests.delete(request.id);
      if (this._destroyed || request.generation !== this._generation) return;
      const command = { method: 'resolveIpc', generation: request.generation, id: request.id, ok,
        ...(ok ? { value: result === undefined ? null : result } : { error: result }) };
      try { this._ipcReplies.push(command); } catch {
        command.ok = false;
        delete command.value;
        command.error = 'IPC result is not representable within the current JSON transport limit';
        this._ipcReplies.push(command);
      }
    }
    _loadURL(target, options = {}) {
      if (this._destroyed) throw new Error('Object has been destroyed');
      if (Object.keys(options).some(key => options[key] !== undefined)) {
        return unsupported('loadURL options (referrer, headers, postData and userAgent)');
      }
      const serial = ++this._navigation;
      this._generation = null;
      this._deferredEvents = [];
      this._rejectEvaluations('Navigation replaced the evaluation document');
      this._loading = true;
      this.emit('did-start-loading');
      this.emit('did-start-navigation', event(this), target, false, true);
      const configure = this._command({ method: 'configureProtocols', schemes: this.session.protocol._rules() });
      const prepare = configure.then(() => this._preloadSource === undefined ? undefined :
        this._command({ method: 'configurePreload', source: this._preloadSource }));
      prepare.then(() => this._command({ method: 'loadURL', url: String(target) })).then(state => {
        if (this._destroyed || serial !== this._navigation) return;
        this._url = state?.url || String(target);
        this._title = state?.title || '';
        this._generation = state?.generation ?? null;
        this._loading = false;
        const deferred = this._deferredEvents;
        this._deferredEvents = [];
        for (const message of deferred) this._engineEvent(message);
        this._history.splice(this._historyIndex + 1);
        this._history.push({ url: this._url, title: this._title });
        this._historyIndex = this._history.length - 1;
        this.emit('dom-ready', event(this));
        // The current engine response has no HTTP status metadata. Electron
        // uses -1 for unavailable status; do not manufacture an HTTP 200.
        this.emit('did-navigate', event(this), this._url, -1, '');
        this.emit('did-frame-finish-load', event(this), true, this._rendererPid, this.id);
        this.emit('did-finish-load', event(this));
        this.emit('did-stop-loading', event(this));
      }, error => {
        if (this._destroyed || serial !== this._navigation) return;
        this._loading = false;
        this._deferredEvents = [];
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
      this._rejectEvaluations('WebContents was destroyed');
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
    if (preferences.nodeIntegration) return unsupported('Node integration inside the Obscura renderer');
    if (preferences.preload && preferences.contextIsolation === false) return unsupported('non-isolated preload execution');
    let preloadSource;
    if (preferences.preload) {
      if (!path.isAbsolute(preferences.preload)) throw new Error('Preload script must have an absolute path');
      preloadSource = fs.readFileSync(preferences.preload, 'utf8');
      if (Buffer.byteLength(preloadSource) > 512 * 1024) throw new Error('Preload source exceeds 512 KiB');
    }
    if (process.env.WEBER_UNSANDBOXED_DEVELOPMENT !== '1') {
      throw new Error('The development host has no OS sandbox. Explicitly set WEBER_UNSANDBOXED_DEVELOPMENT=1 for trusted local development.');
    }
    startWindow(this, options);
    this._preloadSource = preloadSource;
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
  const display = require('./display-binding.cjs').createDisplayBinding({ host, app });
  bindings.set('electron_browser_screen', display.screen);
  bindings.set('electron_browser_system_preferences', display.preferences);
  const clipboard = createClipboardBinding({ host, app });
  bindings.set('electron_browser_message_port', require('./message-port-binding.cjs'));
  bindings.set('electron_browser_clipboard', clipboard.clipboard);
  bindings.set('electron_browser_clipboard_item', clipboard.NativeClipboardItem);
  bindings.set('electron_browser_protocol', protocolRuntime.binding);
  bindings.set('electron_browser_menu', menuBinding);
  bindings.set('electron_browser_global_shortcut', createGlobalShortcutBinding({ host, app }));
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
    } else if (type === 'frame-ready') {
      win.webContents.emit('ready-to-show');
    } else if (type === 'frame-presented') {
      win.webContents.emit('weber-first-frame-presented', message);
    } else if (type === 'frame-error') {
      app.emit('weber-error', new Error(message.error || 'Native frame presentation failed'));
    } else if (type === 'engine-event') {
      win.webContents?._engineEvent(message.data);
    } else if (type === 'engine-event-overflow') {
      win.webContents?._rejectEvaluations('Renderer event queue overflow');
      app.emit('weber-error', new Error('Renderer event queue overflow'));
    }
  });
  host.on('closed', error => {
    for (const win of [...windows.values()]) finishWindow(win);
    if (!quitting) app.emit('weber-error', error);
  });

  return { app, bindings, unsupported, decorateClipboard: clipboard.decorate, session: protocolRuntime.session,
    finishStartup() {
      app.emit('will-finish-launching');
      ready = true;
      app.emit('ready', event(app), {});
      resolveReady();
    },
  };
}

module.exports = { createBindings };

// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// Only the browser process owns handlers. Renderer messages select fixed web
// operations, never an ipcMain channel, native method, partition or origin.
const policies = new WeakMap();
const clipboardPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write']);
const permissionNames = new Map([
  ['clipboard-read', 'clipboard-read'], ['clipboard-write', 'clipboard-sanitized-write'],
  ['geolocation', 'geolocation'], ['camera', 'media'], ['microphone', 'media'],
  ['notifications', 'notifications'], ['display-capture', 'display-capture'],
]);
const MAX_TEXT_BYTES = 512 * 1024;

function attachSessionPermissions(session) {
  const state = { check: null, request: null, display: null, epoch: 0, waiters: new Set() };
  policies.set(session, state);
  for (const [name, key] of [['setPermissionCheckHandler', 'check'],
    ['setPermissionRequestHandler', 'request'], ['_setDisplayMediaRequestHandler', 'display']]) {
    Object.defineProperty(session, name, { configurable: true, value(handler, options) {
      if (handler !== null && typeof handler !== 'function') throw new TypeError(`${name} requires a function or null`);
      if (key === 'display' && options !== undefined &&
          (!options || typeof options !== 'object' || Array.isArray(options) ||
           Object.keys(options).some(key => key !== 'useSystemPicker') ||
           (options.useSystemPicker !== undefined && typeof options.useSystemPicker !== 'boolean')))
        throw new TypeError('Invalid display media handler options');
      // A system picker is unavailable. Electron's source wrapper also falls
      // back to this handler when its native picker capability is false.
      state[key] = handler;
      state.epoch++;
      for (const cancel of [...state.waiters]) cancel();
    } });
  }
  // When Electron's session wrapper is loaded it supplies the public wrapper.
  if (!session.setDisplayMediaRequestHandler) {
    Object.defineProperty(session, 'setDisplayMediaRequestHandler', {
      configurable: true, value(handler, options) { this._setDisplayMediaRequestHandler(handler, options); },
    });
  }
  return session;
}

function failure(message, name = 'NotAllowedError') { return Object.assign(new Error(message), { name }); }

function createSessionPermissionRuntime({ app, clipboard, timeoutMs = 20000 }) {
  const requests = new WeakMap();
  const waitingContents = new WeakMap();
  const activeWaiters = new Set();
  let closed = false;
  app.once('quit', () => {
    closed = true;
    for (const cancel of [...activeWaiters]) cancel();
  });
  function secureContext(session, url) {
    if (url.protocol === 'https:' || url.protocol === 'file:') return true;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return session.protocol?._rules?.().some(rule => rule.scheme === url.protocol.slice(0, -1) && rule.secure === true) === true;
  }
  function callbackResult(invoke, isCurrent, webContents, policy) {
    return new Promise((resolve, reject) => {
      let finished = false, invoking = true, candidate;
      let owner = waitingContents.get(webContents);
      if (!owner) {
        const waiters = new Set();
        const cancel = () => { for (const waiter of [...waiters]) waiter(); };
        owner = { waiters, cancel };
        waitingContents.set(webContents, owner);
        webContents.on?.('destroyed', cancel);
        webContents.on?.('did-start-navigation', cancel);
      }
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        activeWaiters.delete(cancel);
        policy.waiters.delete(cancel);
        owner.waiters.delete(cancel);
        if (owner.waiters.size === 0) {
          webContents.removeListener?.('destroyed', owner.cancel);
          webContents.removeListener?.('did-start-navigation', owner.cancel);
          waitingContents.delete(webContents);
        }
        // An application may retain its callback forever. Once settled, that
        // callback must not retain a window, document or pending Promise.
        webContents = null; policy = null; owner = null; invoke = null; isCurrent = null;
      };
      const finish = (value, error) => {
        if (finished) return;
        finished = true;
        const valid = isCurrent();
        cleanup();
        if (error || !valid) reject(error || failure('Permission request document or policy changed'));
        else resolve(value);
        resolve = null; reject = null; candidate = null;
      };
      const cancel = () => finish(false, failure('Permission request was cancelled'));
      owner.waiters.add(cancel); activeWaiters.add(cancel); policy.waiters.add(cancel);
      timer = setTimeout(() => finish(false), timeoutMs);
      const callback = value => {
        if (finished || candidate) return;
        if (invoking) candidate = { value };
        else finish(value);
      };
      try {
        const result = invoke(callback);
        invoking = false;
        if (candidate) finish(candidate.value);
        // Handlers use a callback contract. Observe rejected async handlers so
        // they cannot leave a pending grant or an unhandled rejection behind.
        Promise.resolve(result).catch(() => finish(false));
      } catch (error) {
        invoking = false;
        finish(false, failure(String(error?.message || error)));
      }
    });
  }
  async function dispatch(webContents, event) {
    if (closed || webContents._destroyed || !event || event.generation !== webContents._generation ||
        typeof event.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(event.id) ||
        !Number.isSafeInteger(Number(event.id))) return;
    let pending = requests.get(webContents);
    if (!pending) { pending = new Set(); requests.set(webContents, pending); }
    const key = `${event.generation}:${event.id}`;
    if (pending.has(key)) return;
    const session = webContents.session;
    const state = policies.get(session);
    const epoch = state?.epoch;
    const urlText = webContents._url;
    const currentDocument = () => !closed && !webContents._destroyed && webContents._generation === event.generation &&
      webContents.session === session && webContents._url === urlText;
    const isCurrent = () => currentDocument() && policies.get(session) === state && state?.epoch === epoch;
    let response;
    try {
      if (pending.size >= 256) throw failure('Too many pending browser permission operations');
      pending.add(key);
      if (!state || typeof event.sourceURL !== 'string' || event.sourceURL !== urlText)
        throw failure('Permission source does not match the active document');
      if (!Array.isArray(event.args)) throw failure('Invalid browser operation arguments', 'TypeError');
      const url = new URL(urlText);
      const origin = url.origin === 'null' && url.host ? `${url.protocol}//${url.host}` : url.origin;
      const details = { requestingUrl: urlText, isMainFrame: true, securityOrigin: origin };
      const check = permission => {
        if (!isCurrent()) throw failure('Permission request document or policy changed');
        const result = state.check?.(webContents, permission, origin, { ...details });
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          throw failure('Permission check handler must return a boolean');
        }
        if (state.check && typeof result !== 'boolean') throw failure('Permission check handler must return a boolean');
        if (!isCurrent()) throw failure('Permission request document or policy changed');
        return result === true;
      };
      const grant = async permission => {
        if (check(permission)) return true;
        if (!state.request) return false;
        const value = await callbackResult(done => state.request(webContents, permission, done, { ...details }), isCurrent, webContents, state);
        return value === true;
      };
      let value;
      if (event.action === 'permission-query') {
        if (event.args.length !== 1 || !event.args[0] || typeof event.args[0].name !== 'string')
          throw failure('A permission descriptor is required', 'TypeError');
        const permission = permissionNames.get(event.args[0].name);
        if (!permission) throw failure('Unsupported permission descriptor', 'TypeError');
        const granted = check(permission);
        value = { state: !secureContext(session, url) || !clipboardPermissions.has(permission) ? 'denied' :
          granted ? 'granted' : state.check ? 'denied' : 'prompt' };
      } else {
        if (!secureContext(session, url)) throw failure('Browser permissions require a secure context');
        let permission;
        if (event.action === 'clipboard-read' && event.args.length === 0) permission = 'clipboard-read';
        else if (event.action === 'clipboard-write' && event.args.length === 1 && typeof event.args[0] === 'string') {
          if (Buffer.byteLength(event.args[0]) > MAX_TEXT_BYTES) throw failure('Clipboard text exceeds 512 KiB', 'QuotaExceededError');
          permission = 'clipboard-sanitized-write';
        } else if (event.action === 'geolocation' && event.args.length === 0) permission = 'geolocation';
        else if (event.action === 'notification-permission' && event.args.length === 0) permission = 'notifications';
        else if (['media', 'display-media'].includes(event.action) && event.args.length === 1 &&
            event.args[0] && typeof event.args[0] === 'object' && !Array.isArray(event.args[0]) &&
            Object.keys(event.args[0]).every(key => ['audio', 'video'].includes(key)) &&
            ['audio', 'video'].every(key => event.args[0][key] === undefined || typeof event.args[0][key] === 'boolean')) {
          permission = event.action === 'media' ? 'media' : 'display-capture';
          details.mediaTypes = ['audio', 'video'].filter(type => !!event.args[0][type]);
        } else throw failure('Invalid or unsupported browser operation', 'TypeError');
        if (!await grant(permission)) throw failure('Permission denied');
        if (!isCurrent()) throw failure('Permission request document or policy changed');
        if (event.action === 'clipboard-read') {
          value = clipboard.readText();
          if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_TEXT_BYTES)
            throw failure('Clipboard text exceeds the bounded transport limit', 'QuotaExceededError');
        } else if (event.action === 'clipboard-write') { clipboard.writeText(event.args[0]); value = null; }
        else if (event.action === 'display-media') {
          if (!state.display) throw failure('No display media request handler is registered');
          const streams = await callbackResult(done => state.display({ frame: webContents.mainFrame,
            securityOrigin: origin, videoRequested: !!event.args[0].video,
            audioRequested: !!event.args[0].audio, userGesture: false }, done), isCurrent, webContents, state);
          if (!streams || typeof streams !== 'object' || (!streams.video && !streams.audio)) throw failure('Display media request denied');
          throw failure('Weber has not implemented display MediaStream acquisition', 'NotSupportedError');
        } else if (event.action === 'notification-permission') value = 'denied';
        else throw failure(`Weber has not implemented ${event.action} acquisition`, 'NotSupportedError');
      }
      response = { ok: true, value };
    } catch (error) {
      response = { ok: false, error: String(error?.message || error),
        errorName: ['NotAllowedError', 'NotSupportedError', 'QuotaExceededError', 'TypeError'].includes(error?.name) ? error.name : 'NotAllowedError' };
    } finally { pending.delete(key); }
    if (!currentDocument()) return;
    try { await webContents._command({ method: 'resolveBrowserOperation', generation: event.generation, id: event.id, ...response }); }
    catch (error) { if (currentDocument()) app.emit('weber-error', error); }
  }
  return { dispatch };
}

module.exports = { attachSessionPermissions, createSessionPermissionRuntime };

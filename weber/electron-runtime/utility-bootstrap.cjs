// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const path = require('node:path');
const { Socket } = require('./utility-socket.cjs');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { UtilityWire } = require('./utility-wire.cjs');
const { UtilityInbox } = require('./utility-inbox.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
const archiveRuntime = require('./asar.cjs').installAsar();

async function main() {
  const parentPid = Number(process.env.WEBER_UTILITY_PARENT_PID);
  delete process.env.WEBER_UTILITY_PARENT_PID;
  const mainAuth = process.env.WEBER_UTILITY_MAIN_AUTH === '1';
  delete process.env.WEBER_UTILITY_MAIN_AUTH;
  let network;
  require('./dist/native/weber_platform.node').guardParent(parentPid);
  const entry = process.argv[2];
  if (!entry || !path.isAbsolute(entry)) throw new Error('Missing utility entry path');
  process.argv = [process.execPath, entry, ...process.argv.slice(3)];
  process.type = 'utility';
  Object.defineProperty(process.versions, 'weber', { value: '0.1.0', enumerable: true });
  Object.defineProperty(process.versions, 'electron', { value: '0.0.0-weber-development', enumerable: true });
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  const wire = new UtilityWire(socket);
  const ports = new Map();
  const authRequests = new Map();
  let highestAuth = 0;
  let highestPort = 0;
  const references = () => {
    if (root.started || authRequests.size || [...ports.values()].some(port => port.inbox.started)) socket.ref();
    else socket.unref();
  };
  const rootNative = { emit() {},
    start() { root.start(); references(); },
    pause() { root.pause(); references(); },
    postMessage(data) { wire.send({ kind: 'message', data }); },
  };
  const root = new UtilityInbox(event => rootNative.emit('message', event));
  function makePort(id) {
    const native = { emit() {},
      start() { inbox.start(); references(); },
      close() {
        if (inbox.closed) return;
        inbox.close(); ports.delete(id); references();
        if (!wire.closed) wire.send({ kind: 'port-close', id });
        setImmediate(() => native.emit('close'));
      },
      postMessage(data, transfer = []) {
        if (inbox.closed) return;
        if (!Array.isArray(transfer) || transfer.length) throw new DOMException('Nested utility port transfers are not implemented', 'DataCloneError');
        wire.send({ kind: 'port-message', id, data });
      },
    };
    const inbox = new UtilityInbox(event => native.emit('message', event));
    ports.set(id, { native, inbox });
    return native;
  }
  wire.on('failure', error => { console.error(error.stack || error); process.exit(1); });
  wire.on('closed', () => {
    network?.close(); authRequests.clear();
    root.close(); for (const port of ports.values()) port.inbox.close();
    // The private channel belongs to this parent; its loss ends the utility.
    process.exit(0);
  });
  wire.on('message', message => {
    if (!message || typeof message !== 'object') throw new Error('Invalid parent message');
    if (message.kind === 'auth-response') {
      if (!mainAuth || !Number.isSafeInteger(message.id) || message.id < 1 || message.id > highestAuth)
        throw new Error('Unknown utility authentication response');
      const callback = authRequests.get(message.id);
      authRequests.delete(message.id); references();
      callback?.(message.username, message.password);
    } else if (message.kind === 'deliver') {
      const ids = message.ports;
      if (!Array.isArray(ids) || ports.size + ids.length > 64 || ids.length > 64 ||
          ids.some((id, n) => !Number.isSafeInteger(id) || id <= highestPort || (n && id <= ids[n - 1])))
        throw new Error('Invalid utility port ownership transfer');
      const received = ids.map(makePort);
      if (ids.length) highestPort = ids.at(-1);
      root.receive(message.data, received);
    } else if (message.kind === 'port-message') {
      const port = ports.get(message.id);
      if (port) port.inbox.receive(message.data, []);
      else if (!Number.isSafeInteger(message.id) || message.id < 1 || message.id > highestPort) throw new Error('Unknown utility port');
    } else if (message.kind === 'port-close') ports.get(message.id)?.native.close();
    else throw new Error('Unknown parent message kind');
  });
  const originalLoad = Module._load;
  const originalBinding = process._linkedBinding?.bind(process);
  const unsupported = name => { throw new Error('Unsupported utility API: ' + name); };
  const api = {};
  process._linkedBinding = name => {
    if (name === 'electron_utility_parent_port') return { createParentPort: () => rootNative };
    if (name === 'electron_common_net') return network.binding;
    if (name.startsWith('electron_')) throw new Error('Unsupported utility native binding: ' + name);
    return originalBinding(name);
  };
  const allowed = new Set(['utility/parent-port', 'browser/message-port-main',
    'utility/api/net', 'common/api/net-client-request', 'browser/api/net-fetch']);
  const resolveInternal = request => {
    if (!request.startsWith('@electron/internal/')) return undefined;
    const id = request.slice('@electron/internal/'.length);
    if (!allowed.has(id)) throw new Error('Unsupported utility internal module: ' + id);
    return path.join(__dirname, 'dist', id + '.js');
  };
  let bunLoader;
  const isElectron = request => request === 'electron' || request === 'electron/utility';
  const rejectBrowser = request => {
    if (request.startsWith('electron/')) unsupported(request);
  };
  if (process.versions.bun) {
    bunLoader = createCommonJSLoader(request => {
      if (isElectron(request)) return { value: api };
      if (request === 'original-fs' || request === 'node:original-fs') return { value: archiveRuntime.originalFs };
      rejectBrowser(request);
      const file = resolveInternal(request);
      return file ? { value: bunLoader.load(file) } : undefined;
    }, archiveRuntime);
  } else Module._load = function(request, ...args) {
    if (isElectron(request)) return api;
    rejectBrowser(request);
    return originalLoad.call(this, resolveInternal(request) || request, ...args);
  };
  const loadInternal = id => {
    const filename = resolveInternal('@electron/internal/' + id);
    return bunLoader ? bunLoader.load(filename) : originalLoad.call(Module, filename, module, false);
  };
  function forwardAuth(details, authInfo, callback) {
    if (wire.closed) { callback(); return; }
    if (authRequests.size >= 128 || highestAuth >= Number.MAX_SAFE_INTEGER)
      throw new RangeError('Utility authentication request limit exceeded');
    const id = ++highestAuth;
    authRequests.set(id, callback); references();
    try { wire.send({ kind: 'auth-request', id, details, authInfo }); }
    catch (error) { authRequests.delete(id); references(); throw error; }
    return () => {
      if (!authRequests.delete(id)) return;
      references();
      if (!wire.closed) wire.send({ kind: 'auth-cancel', id });
    };
  }
  network = require('./net-binding.cjs').createNetBinding({ unsupported, loadInternal,
    onAuthRequired: mainAuth ? forwardAuth : undefined });
  process.once('exit', () => network.close());
  Object.defineProperty(api, 'net', { enumerable: true, get: () => loadInternal('utility/api/net') });
  globalThis[Symbol.for('weber.utility.api')] = api;
  const facade = path.join(__dirname, 'utility-api.cjs');
  // Bun 1.4.2's runtime plugin does not intercept these bare package imports.
  // Its CommonJS loader works; do not claim an ESM Electron surface on Bun.
  if (!bunLoader && typeof Module.registerHooks === 'function') {
    Module.registerHooks({ resolve(specifier, context, nextResolve) {
      if (isElectron(specifier)) return { url: pathToFileURL(facade).href, shortCircuit: true };
      rejectBrowser(specifier);
      const filename = resolveInternal(specifier);
      if (filename) return { url: pathToFileURL(filename).href, shortCircuit: true };
      return nextResolve(specifier, context);
    } });
  }
  const parentModule = path.join(__dirname, 'dist/utility/parent-port.js');
  const { ParentPort } = bunLoader ? bunLoader.load(parentModule) : require(parentModule);
  const parentPort = new ParentPort();
  Object.defineProperty(process, 'parentPort', { value: parentPort, enumerable: true, writable: false });
  parentPort.on('newListener', name => {
    if (name === 'message' && parentPort.listenerCount('message') === 0) parentPort.start();
  });
  parentPort.on('removeListener', name => {
    if (name === 'message' && parentPort.listenerCount('message') === 0) parentPort.pause();
  });
  references();
  wire.send({ kind: 'ready' });
  if (bunLoader && entry.endsWith('.cjs')) bunLoader.load(entry, true);
  else await import(pathToFileURL(entry).href);
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });

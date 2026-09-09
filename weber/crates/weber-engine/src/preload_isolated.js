// JSON-only asynchronous contextBridge subset; not Electron structured clone.
(() => {
  'use strict';
  // This function and all its state remain private to the embedding Rust code.
  // Only JSON strings cross contexts. Capture intrinsics before page/preload code.
  const apply = Reflect.apply;
  const ownKeys = Reflect.ownKeys;
  const has = Reflect.has;
  const hasOwn = Object.hasOwn;
  const create = Object.create;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const prototypeOf = Object.getPrototypeOf;
  const setPrototype = Object.setPrototypeOf;
  const freeze = Object.freeze;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  const isArray = Array.isArray;
  const isFiniteNumber = Number.isFinite;
  const isSafeInteger = Number.isSafeInteger;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const NativeError = Error;
  const NativePromise = Promise;
  const promiseThen = Promise.prototype.then;
  const stringSlice = String.prototype.slice;
  const charCodeAt = String.prototype.charCodeAt;
  const MAX_BYTES = 1024 * 1024;
  const MAX_PENDING = 256;
  const MAX_DEPTH = 32;
  const MAX_NODES = 32768;
  const COMPLETION_RESERVE = 2048;

  function fail(message) { throw new NativeError(message); }
  function record(fields) {
    const out = create(null);
    const names = ownKeys(fields);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      define(out, name, { __proto__: null, value: fields[name], enumerable: true, writable: true });
    }
    return out;
  }
  function array() { return setPrototype([], null); }
  function put(target, name, value) {
    define(target, name, { __proto__: null, value, enumerable: true, writable: true, configurable: true });
  }
  function bytes(text) {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      const code = apply(charCodeAt, text, [i]);
      if (code < 0x80) count++;
      else if (code < 0x800) count += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = apply(charCodeAt, text, [i + 1]);
        if (next >= 0xdc00 && next <= 0xdfff) { count += 4; i++; }
        else count += 3;
      } else count += 3;
      if (count > MAX_BYTES) return count;
    }
    return count;
  }
  function errorText(error) {
    if (typeof error === 'string') return apply(stringSlice, error, [0, 180]);
    // Never invoke an untrusted message getter or conversion method.
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      try {
        const desc = descriptor(error, 'message');
        if (desc && typeof desc.value === 'string')
          return apply(stringSlice, desc.value, [0, 180]);
      } catch (_) {}
    }
    return 'JavaScript operation failed';
  }
  function jsonBudget() {
    let used = 0;
    return (scalar, overhead = 0) => {
      if (typeof scalar === 'string' && scalar.length > MAX_BYTES - 4096)
        fail('JSON value exceeds the byte limit');
      used += overhead;
      if (scalar !== undefined) used += bytes(stringify(scalar));
      if (used > MAX_BYTES - 4096) fail('JSON value exceeds the byte limit');
    };
  }
  function clone(value) {
    let nodes = 0;
    const account = jsonBudget();
    const ancestors = array();
    function visit(item, depth) {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('JSON value is too complex');
      if (item === null || typeof item === 'boolean' || typeof item === 'string') { account(item); return item; }
      if (typeof item === 'number') {
        if (!isFiniteNumber(item)) fail('JSON numbers must be finite');
        account(item);
        return item;
      }
      if (typeof item !== 'object') fail('Only JSON values can cross the context bridge');
      for (let i = 0; i < ancestors.length; i++)
        if (ancestors[i] === item) fail('Cyclic values cannot cross the context bridge');
      const sequence = isArray(item);
      const proto = prototypeOf(item);
      if (proto !== null && proto !== (sequence ? arrayPrototype : objectPrototype))
        fail('Only plain objects and arrays can cross the context bridge');
      const names = ownKeys(item);
      const out = sequence ? array() : create(null);
      account(undefined, 2);
      put(ancestors, ancestors.length, item);
      let elements = 0;
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (typeof name !== 'string') fail('Symbol properties cannot cross the context bridge');
        const desc = descriptor(item, name);
        if (!desc || !hasOwn(desc, 'value')) fail('Accessors cannot cross the context bridge');
        if (sequence && name === 'length') continue;
        if (sequence) {
          const index = +name;
          if (!isSafeInteger(index) || index < 0 || index >= item.length || '' + index !== name)
            fail('Arrays cannot carry named properties across the context bridge');
          elements++;
        }
        if (!desc.enumerable) fail('Non-enumerable properties cannot cross the context bridge');
        account(sequence ? undefined : name, sequence ? 1 : 2);
        put(out, name, visit(desc.value, depth + 1));
      }
      if (sequence && elements !== item.length) fail('Sparse arrays cannot cross the context bridge');
      ancestors.length--;
      return out;
    }
    const result = visit(value, 0);
    if (bytes(stringify(result)) > MAX_BYTES - 4096) fail('JSON value exceeds the byte limit');
    return result;
  }
  function publicValue(value) {
    // Copies exposed to application code have ordinary local-realm prototypes.
    // Internal queue/serialization copies retain null prototypes.
    if (value !== null && typeof value === 'object') {
      const names = ownKeys(value);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!(isArray(value) && name === 'length')) publicValue(value[name]);
      }
      setPrototype(value, isArray(value) ? arrayPrototype : objectPrototype);
    }
    return value;
  }
  function validId(id) {
    if (!isSafeInteger(id) || id < 1) fail('Ticket IDs must be positive safe integers');
    return id;
  }
  function promise(executor) {
    const result = new NativePromise(executor);
    // Promise.then must not consult a page-modified constructor/species getter.
    define(result, 'constructor', { __proto__: null, value: undefined });
    define(result, 'then', { __proto__: null, value: promiseThen });
    return result;
  }
  function follow(value, success, failure) {
    const result = promise(resolve => resolve(value));
    apply(promiseThen, result, [success, failure]);
  }
  function encodeResponse(ok, value) {
    const result = stringify(ok ? record({ ok: true, value }) : record({ ok: false, error: value }));
    if (bytes(result) > MAX_BYTES) fail('Dispatcher response exceeds the byte limit');
    return result;
  }
  function command(input, handler) {
    try {
      if (typeof input !== 'string' || bytes(input) > MAX_BYTES) fail('Invalid dispatcher payload');
      const payload = clone(parse(input));
      if (!payload || isArray(payload) || typeof payload.method !== 'string') fail('Missing method');
      return encodeResponse(true, handler(payload));
    } catch (error) {
      return encodeResponse(false, errorText(error));
    }
  }
  const NativeFunction = Function;
  let configured = false;
  let configureAttempted = false;
  let configuring = false;
  let nextFunctionId = 1;
  let nextIpcId = 1;
  let pendingCount = 0;
  let activeCalls = 0;
  const functions = create(null);
  const exported = create(null);
  const calls = create(null);
  const ipcPending = create(null);
  let queue = array();
  let queueBytes = 0;

  function enqueue(event) {
    const size = bytes(stringify(event));
    if (queue.length + activeCalls >= MAX_PENDING ||
        queueBytes + size + activeCalls * COMPLETION_RESERVE > MAX_BYTES - 4096)
      fail('Isolated context event queue is full');
    put(queue, queue.length, event);
    queueBytes += size;
  }
  function metadata(value) {
    let nodes = 0;
    const account = jsonBudget();
    const ancestors = array();
    function visit(item, depth) {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('Exported API is too complex');
      account(undefined, 64);
      if (typeof item === 'function') {
        if (nextFunctionId > 1024) fail('Too many exported functions');
        const id = nextFunctionId++;
        put(functions, id, item);
        return record({ kind: 'function', id });
      }
      if (item === null || typeof item !== 'object') {
        const copied = clone(item);
        account(copied);
        return record({ kind: 'value', value: copied });
      }
      for (let i = 0; i < ancestors.length; i++)
        if (ancestors[i] === item) fail('Cyclic APIs cannot be exported');
      const sequence = isArray(item);
      const proto = prototypeOf(item);
      if (proto !== null && proto !== (sequence ? arrayPrototype : objectPrototype)) fail('Exported APIs must be plain objects');
      const values = sequence ? array() : create(null);
      const names = ownKeys(item);
      put(ancestors, ancestors.length, item);
      let elements = 0;
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (typeof name !== 'string') fail('Exported APIs cannot contain symbol properties');
        const desc = descriptor(item, name);
        if (!desc || !hasOwn(desc, 'value')) fail('Exported APIs cannot contain accessors');
        if (sequence && name === 'length') continue;
        if (!desc.enumerable) fail('Exported APIs cannot contain non-enumerable properties');
        if (sequence) {
          const index = +name;
          if (!isSafeInteger(index) || index < 0 || index >= item.length || '' + index !== name)
            fail('Exported arrays cannot contain named properties');
          elements++;
        }
        account(sequence ? undefined : name, 2);
        put(values, name, visit(desc.value, depth + 1));
      }
      if (sequence && elements !== item.length) fail('Sparse arrays cannot be exported');
      ancestors.length--;
      return record({ kind: sequence ? 'array' : 'object', value: values });
    }
    const result = visit(value, 0);
    if (bytes(stringify(result)) > MAX_BYTES - 4096) fail('Exported API exceeds the byte limit');
    return result;
  }
  const contextBridge = freeze(record({ exposeInMainWorld: freeze((name, api) => {
    if (!configuring) fail('APIs can only be exposed while the preload is configuring');
    if (typeof name !== 'string' || !name.length || name === '__proto__' || name === 'prototype' || name === 'constructor')
      fail('Invalid exported API name');
    if (has(exported, name)) fail('Duplicate exported API name');
    put(exported, name, metadata(api));
  }) }));
  const ipcRenderer = freeze(record({ invoke: freeze((channel, ...args) => promise((resolve, reject) => {
    try {
      if (typeof channel !== 'string' || !channel.length || bytes(channel) > 1024)
        fail('IPC channel must be a nonempty string of at most 1024 bytes');
      if (pendingCount >= MAX_PENDING) fail('Too many pending isolated context operations');
      const id = validId(nextIpcId++);
      enqueue(record({ type: 'ipc-invoke', id, channel, args: clone(args) }));
      put(ipcPending, id, record({ resolve, reject }));
      pendingCount++;
    } catch (error) { reject(new NativeError(errorText(error))); }
  })) }));
  const electron = freeze(record({ contextBridge, ipcRenderer }));
  const requireElectron = freeze(name => {
    if (name !== 'electron') fail('This isolated preload supports only require("electron")');
    return electron;
  });
  function completeCall(id, ok, value) {
    activeCalls--;
    try {
      enqueue(ok ? record({ type: 'bridge-result', id, ok: true, value: clone(value) }) :
        record({ type: 'bridge-result', id, ok: false, error: errorText(value) }));
    } catch (error) {
      enqueue(record({ type: 'bridge-result', id, ok: false, error: errorText(error) }));
    }
  }
  function dispatch(payload) {
    switch (payload.method) {
      case 'configure': {
        if (configureAttempted) fail('The isolated preload has already attempted configuration');
        if (typeof payload.source !== 'string') fail('Preload source must be a string');
        configureAttempted = true;
        configuring = true;
        try {
          const module = record({ exports: create(null) });
          const preload = new NativeFunction('require', 'module', 'exports', '"use strict";\n' + payload.source);
          apply(preload, undefined, [requireElectron, module, module.exports]);
          if (bytes(stringify(exported)) > MAX_BYTES - 4096) fail('Combined exported APIs exceed the byte limit');
          configured = true;
          return exported;
        } finally { configuring = false; }
      }
      case 'call': {
        if (!configured) fail('Preload has not been configured');
        const id = validId(payload.id);
        const functionId = validId(payload.functionId);
        if (has(calls, id)) fail('Duplicate bridge call ticket');
        if (!has(functions, functionId)) fail('Unknown exported function');
        if (!isArray(payload.args)) fail('Bridge arguments must be an array');
        if (pendingCount >= MAX_PENDING || queue.length + activeCalls >= MAX_PENDING ||
            queueBytes + (activeCalls + 1) * COMPLETION_RESERVE > MAX_BYTES - 4096)
          fail('Too many pending bridge calls');
        put(calls, id, true);
        pendingCount++;
        activeCalls++;
        try {
          const result = apply(functions[functionId], undefined, publicValue(clone(payload.args)));
          follow(result, value => completeCall(id, true, value), error => completeCall(id, false, error));
        } catch (error) { completeCall(id, false, error); }
        return null;
      }
      case 'resolveIpc': {
        const id = validId(payload.id);
        if (!has(ipcPending, id)) fail('Unknown IPC invocation ticket');
        if (typeof payload.ok !== 'boolean') fail('IPC settlement requires a boolean status');
        const entry = ipcPending[id];
        const value = payload.ok ? publicValue(clone(payload.value)) : new NativeError(errorText(payload.error));
        delete ipcPending[id];
        pendingCount--;
        if (payload.ok) entry.resolve(value); else entry.reject(value);
        return null;
      }
      case 'drain': {
        const events = queue;
        queue = array();
        queueBytes = 0;
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          if (event.type === 'bridge-result') {
            delete calls[event.id];
            pendingCount--;
          }
        }
        return events;
      }
      default: fail('Unknown isolated-world dispatcher method');
    }
  }
  return freeze(input => command(input, dispatch));
})()

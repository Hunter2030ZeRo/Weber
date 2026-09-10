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
  const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
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
      const code = charCodeAt(text, i);
      if (code < 0x80) count++;
      else if (code < 0x800) count += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = charCodeAt(text, i + 1);
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
    // account() counts every encoded scalar/key and conservatively counts
    // punctuation. The null-prototype output cannot run a toJSON hook, so
    // serializing this whole tree a second time adds no validation.
    return visit(value, 0);
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
  function parseOwned(input) {
    // The captured JSON parser creates a fresh local tree, with no accessors,
    // functions, aliases, or proxies. Validate bounds and remove prototypes in
    // place; no application object can enter this private path.
    let nodes = 0;
    function visit(value, depth) {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('JSON value is too complex');
      if (value !== null && typeof value === 'object') {
        const names = ownKeys(value);
        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          if (!(isArray(value) && name === 'length')) visit(value[name], depth + 1);
        }
        setPrototype(value, null);
      } else if (typeof value === 'number' && !isFiniteNumber(value)) fail('JSON numbers must be finite');
      return value;
    }
    return visit(parse(input), 0);
  }
  function command(input, handler) {
    try {
      if (typeof input !== 'string' || bytes(input) > MAX_BYTES - 4096) fail('Invalid dispatcher payload');
      const payload = parseOwned(input);
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
  const listeners = create(null);
  let listenerCount = 0;
  function ipcChannel(channel) {
    if (typeof channel !== 'string' || !channel.length || bytes(channel) > 1024)
      fail('IPC channel must be a nonempty string of at most 1024 bytes');
    return channel;
  }
  function addListener(channel, listener, once) {
    ipcChannel(channel);
    if (typeof listener !== 'function') fail('IPC listener must be a function');
    if (listenerCount >= 1024) fail('Too many IPC listeners');
    if (!hasOwn(listeners, channel)) put(listeners, channel, array());
    put(listeners[channel], listeners[channel].length, record({ listener, once }));
    listenerCount++;
    return ipcRenderer;
  }
  function removeListener(channel, listener) {
    ipcChannel(channel);
    const previous = listeners[channel];
    if (!previous) return ipcRenderer;
    const next = array();
    // EventEmitter removes the most recently added matching registration.
    let index = -1;
    for (let i = previous.length - 1; i >= 0; i--) if (previous[i].listener === listener) { index = i; break; }
    for (let i = 0; i < previous.length; i++) if (i !== index) put(next, next.length, previous[i]);
    if (index >= 0) listenerCount--;
    if (next.length) put(listeners, channel, next); else delete listeners[channel];
    return ipcRenderer;
  }
  const ipcRenderer = freeze(record({
    send: freeze((channel, ...args) => {
      ipcChannel(channel);
      enqueue(record({ type: 'ipc-send', channel, args: clone(args) }));
    }),
    on: freeze((channel, listener) => addListener(channel, listener, false)),
    addListener: freeze((channel, listener) => addListener(channel, listener, false)),
    once: freeze((channel, listener) => addListener(channel, listener, true)),
    removeListener: freeze(removeListener), off: freeze(removeListener),
    removeAllListeners: freeze(channel => {
      if (channel === undefined) {
        const channels = ownKeys(listeners);
        for (let i = 0; i < channels.length; i++) delete listeners[channels[i]];
        listenerCount = 0;
      } else {
        ipcChannel(channel);
        if (hasOwn(listeners, channel)) { listenerCount -= listeners[channel].length; delete listeners[channel]; }
      }
      return ipcRenderer;
    }),
    invoke: freeze((channel, ...args) => promise((resolve, reject) => {
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
      case 'callBatch': {
        if (!isArray(payload.calls) || !payload.calls.length || payload.calls.length > 32) fail('Invalid bridge call batch');
        const rejected = array();
        for (let i = 0; i < payload.calls.length; i++) {
          const item = payload.calls[i];
          if (!item || item.method !== 'call') fail('Invalid batched bridge operation');
          try { dispatch(item); }
          catch (error) { put(rejected, rejected.length, record({ id: item.id, ok: false, error: errorText(error) })); }
        }
        return rejected;
      }
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
          const result = apply(functions[functionId], undefined, publicValue(payload.args));
          follow(result, value => completeCall(id, true, value), error => completeCall(id, false, error));
        } catch (error) { completeCall(id, false, error); }
        return null;
      }
      case 'sendToRenderer': {
        const channel = ipcChannel(payload.channel);
        if (!isArray(payload.args)) fail('IPC arguments must be an array');
        const callbacks = listeners[channel];
        if (!callbacks) return null;
        // Snapshot registrations, preserving EventEmitter behavior if a callback
        // removes another listener or subscribes while this message is delivered.
        const snapshot = array();
        for (let i = 0; i < callbacks.length; i++) put(snapshot, i, callbacks[i]);
        const event = freeze(record({ sender: ipcRenderer, ports: freeze([]) }));
        const args = publicValue(payload.args);
        const invocation = array(); put(invocation, 0, event);
        for (let i = 0; i < args.length; i++) put(invocation, i + 1, args[i]);
        for (let i = 0; i < snapshot.length; i++) {
          if (snapshot[i].once) {
            const current = listeners[channel];
            if (current) {
              const remaining = array();
              for (let j = 0; j < current.length; j++) {
                if (current[j] === snapshot[i]) listenerCount--;
                else put(remaining, remaining.length, current[j]);
              }
              if (remaining.length) put(listeners, channel, remaining); else delete listeners[channel];
            }
          }
          apply(snapshot[i].listener, ipcRenderer, invocation);
        }
        return null;
      }
      case 'resolveIpc':
      case 'resolveIpcBatch': {
        const replies = payload.method === 'resolveIpc' ? [payload] : payload.replies;
        if (!isArray(replies) || !replies.length || replies.length > 32) fail('Invalid IPC reply batch');
        const seen = create(null);
        const prepared = array();
        for (let i = 0; i < replies.length; i++) {
          const reply = replies[i];
          const id = validId(reply.id);
          if (!has(ipcPending, id) || has(seen, id)) fail('Unknown or duplicate IPC invocation ticket');
          if (typeof reply.ok !== 'boolean') fail('IPC settlement requires a boolean status');
          put(seen, id, true);
          const value = reply.ok ? publicValue(reply.value) : new NativeError(errorText(reply.error));
          put(prepared, prepared.length, record({ id, entry: ipcPending[id], ok: reply.ok, value }));
        }
        // Finish all copying before resolving any Promise in this batch.
        for (let i = 0; i < prepared.length; i++) {
          const reply = prepared[i];
          delete ipcPending[reply.id];
          pendingCount--;
          if (reply.ok) reply.entry.resolve(reply.value); else reply.entry.reject(reply.value);
        }
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
  // Private zero-argument probe: a bounded read of our own queue length.
  // No JSON conversion, user callbacks, getters, or Promise jobs run here.
  return freeze(input => input === undefined ? queue.length !== 0 : command(input, dispatch));
})()

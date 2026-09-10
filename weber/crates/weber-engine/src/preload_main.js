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
  const mainGlobal = globalThis;
  const indirectEval = eval;
  let installed = false;
  let nextBridgeId = 1;
  let pendingCount = 0;
  let activeEvaluations = 0;
  const bridgePending = create(null);
  const evaluations = create(null);
  let queue = array();
  let queueBytes = 0;

  function enqueue(event) {
    const size = bytes(stringify(event));
    if (queue.length + activeEvaluations >= MAX_PENDING ||
        queueBytes + size + activeEvaluations * COMPLETION_RESERVE > MAX_BYTES - 4096)
      fail('Context bridge event queue is full');
    put(queue, queue.length, event);
    queueBytes += size;
  }
  function evaluationId(id) {
    if (typeof id === 'string') {
      if (!id.length || id.length > 128) fail('Evaluation ticket strings must contain 1 to 128 code units');
      return id;
    }
    return validId(id);
  }
  function evaluationKey(id) { return typeof id === 'string' ? 's:' + id : 'n:' + id; }
  function bridgeCall(functionId, args) {
    return promise((resolve, reject) => {
      try {
        if (pendingCount >= MAX_PENDING) fail('Too many pending context bridge operations');
        const id = validId(nextBridgeId++);
        const copied = clone(args);
        enqueue(record({ type: 'bridge-call', id, functionId, args: copied }));
        put(bridgePending, id, record({ resolve, reject }));
        pendingCount++;
      } catch (error) { reject(new NativeError(errorText(error))); }
    });
  }
  function materialize(metadata, depth) {
    if (depth > MAX_DEPTH || !metadata || typeof metadata !== 'object') fail('Invalid export metadata');
    if (metadata.kind === 'value') return freezeTree(publicValue(clone(metadata.value)));
    if (metadata.kind === 'function') {
      const id = validId(metadata.id);
      return freeze((...args) => bridgeCall(id, args));
    }
    if (metadata.kind !== 'object' && metadata.kind !== 'array') fail('Unknown export metadata kind');
    const sequence = metadata.kind === 'array';
    const values = metadata.value;
    if (!values || typeof values !== 'object' || isArray(values) !== sequence)
      fail('Invalid export metadata container');
    const out = sequence ? array() : create(null);
    const names = ownKeys(values);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (sequence && name === 'length') continue;
      put(out, name, materialize(values[name], depth + 1));
    }
    return freeze(setPrototype(out, sequence ? arrayPrototype : objectPrototype));
  }
  function freezeTree(value) {
    if (value !== null && typeof value === 'object') {
      const names = ownKeys(value);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!(isArray(value) && name === 'length')) freezeTree(value[name]);
      }
      freeze(value);
    }
    return value;
  }
  function completeEvaluation(id, ok, value) {
    activeEvaluations--;
    let event;
    try {
      event = ok ? record({ type: 'evaluation-result', id, ok: true, value: clone(value) }) :
        record({ type: 'evaluation-result', id, ok: false, error: errorText(value) });
      enqueue(event);
    } catch (error) {
      // Capacity for a bounded failure is reserved when an evaluation starts.
      enqueue(record({ type: 'evaluation-result', id, ok: false, error: errorText(error) }));
    }
  }
  function dispatch(payload) {
    switch (payload.method) {
      case 'install': {
        if (installed) fail('The context bridge is already installed');
        const exports = payload.exports;
        if (!exports || typeof exports !== 'object' || isArray(exports)) fail('Invalid exports');
        const names = ownKeys(exports);
        const prepared = create(null);
        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          if (!name.length || name === '__proto__' || name === 'prototype' || name === 'constructor' || has(mainGlobal, name))
            fail('An exported API conflicts with an existing global');
          put(prepared, name, materialize(exports[name], 0));
        }
        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          define(mainGlobal, name, { __proto__: null, value: prepared[name], enumerable: true });
        }
        installed = true;
        return null;
      }
      case 'startEvaluation': {
        const id = evaluationId(payload.id);
        const key = evaluationKey(id);
        if (has(evaluations, key)) fail('Duplicate evaluation ticket');
        if (typeof payload.source !== 'string') fail('Evaluation source must be a string');
        if (pendingCount >= MAX_PENDING || queue.length + activeEvaluations >= MAX_PENDING ||
            queueBytes + (activeEvaluations + 1) * COMPLETION_RESERVE > MAX_BYTES - 4096)
          fail('Too many pending evaluations');
        put(evaluations, key, true);
        pendingCount++;
        activeEvaluations++;
        try {
          const result = apply(indirectEval, undefined, [payload.source]);
          follow(result, value => completeEvaluation(id, true, value), error => completeEvaluation(id, false, error));
        } catch (error) { completeEvaluation(id, false, error); }
        return null;
      }
      case 'settle': {
        const id = validId(payload.id);
        if (!has(bridgePending, id)) fail('Unknown bridge call ticket');
        if (typeof payload.ok !== 'boolean') fail('Settlement requires a boolean status');
        const entry = bridgePending[id];
        const value = payload.ok ? publicValue(clone(payload.value)) : new NativeError(errorText(payload.error));
        delete bridgePending[id];
        pendingCount--;
        if (payload.ok) entry.resolve(value); else entry.reject(value);
        return null;
      }
      case 'settleBatch': {
        if (!isArray(payload.replies) || !payload.replies.length || payload.replies.length > 32) fail('Invalid bridge settlement batch');
        const seen = create(null);
        const prepared = array();
        for (let i = 0; i < payload.replies.length; i++) {
          const reply = payload.replies[i];
          const id = validId(reply.id);
          if (!has(bridgePending, id) || has(seen, id)) fail('Unknown or duplicate bridge call ticket');
          if (typeof reply.ok !== 'boolean') fail('Settlement requires a boolean status');
          put(seen, id, true);
          put(prepared, prepared.length, record({ id, entry: bridgePending[id], ok: reply.ok,
            value: reply.ok ? publicValue(clone(reply.value)) : new NativeError(errorText(reply.error)) }));
        }
        for (let i = 0; i < prepared.length; i++) {
          const reply = prepared[i];
          delete bridgePending[reply.id]; pendingCount--;
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
          if (event.type === 'evaluation-result') {
            delete evaluations[evaluationKey(event.id)];
            pendingCount--;
          }
        }
        return events;
      }
      default: fail('Unknown main-world dispatcher method');
    }
  }
  // Private zero-argument probe: a bounded read of our own queue length.
  // No JSON conversion, user callbacks, getters, or Promise jobs run here.
  return freeze(input => input === undefined ? queue.length !== 0 : command(input, dispatch));
})()

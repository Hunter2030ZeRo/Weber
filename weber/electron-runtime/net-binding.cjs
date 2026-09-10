// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createURLLoader } = require('./net-url-loader.cjs');

function createNetBinding({ app, unsupported = name => {
  throw Object.assign(new Error(`Weber has not implemented ${name}`), { code: 'ERR_WEBER_UNSUPPORTED' });
}, loadInternal, session, onAuthRequired } = {}) {
  let closed = false;
  const active = new Set();
  // Share transport connections, never cookies or authentication credentials.
  const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 32, maxTotalSockets: 64, maxFreeSockets: 4 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 32, maxTotalSockets: 64, maxFreeSockets: 4 }) };
  function check() { if (closed) throw new Error('Network runtime is closed'); }
  function track(loader) {
    check();
    if (active.size >= 128) throw new RangeError('Network request limit exceeded (128)');
    active.add(loader);
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const value of [...active]) value.cancel();
    active.clear();
    for (const agent of Object.values(agents)) agent.destroy();
  }
  app?.once('quit', close);
  function createWebSocket(options) {
    check();
    for (const key of ['headers', 'origin', 'session', 'partition']) {
      if (options[key] !== undefined) unsupported(`net.WebSocket ${key}`);
    }
    if (options.useSessionCookies) unsupported('net.WebSocket session cookies');
    const wrapper = new EventEmitter();
    let socket;
    wrapper.cancel = () => socket?.close();
    track(wrapper);
    try { socket = new globalThis.WebSocket(options.url, options.protocols); }
    catch (error) { active.delete(wrapper); throw error; }
    socket.binaryType = 'arraybuffer';
    wrapper.getBufferedAmount = () => socket.bufferedAmount;
    wrapper.send = (text, data) => {
      if (socket.bufferedAmount + data.byteLength > 4 * 1024 * 1024) throw new RangeError('WebSocket send queue exceeds 4 MiB');
      socket.send(text ? Buffer.from(data).toString('utf8') : data);
    };
    wrapper.close = (code, reason) => socket.close(code, reason);
    socket.addEventListener('open', () => wrapper.emit('open', {}, socket.protocol, socket.extensions));
    socket.addEventListener('message', event => {
      const isText = typeof event.data === 'string';
      const bytes = isText ? Buffer.from(event.data) : Buffer.from(event.data);
      // The original wrapper exposes .buffer for binaryType=arraybuffer.
      const data = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(data);
      wrapper.emit('message', {}, isText, data);
    });
    socket.addEventListener('error', () => wrapper.emit('error', {}));
    socket.addEventListener('close', event => {
      active.delete(wrapper);
      wrapper.emit('close', {}, event.wasClean, event.code, event.reason);
    });
    return wrapper;
  }
  async function resolveHost(host, options = {}) {
    check();
    if (typeof host !== 'string' || !host || host.length > 253 || /[\s\0/]/.test(host)) throw new TypeError('Invalid DNS hostname');
    const { queryType = 'unspec', source = 'system', cacheUsage = 'allowed', secureDnsPolicy = 'allow', ...extra } = options;
    if (Object.keys(extra).length || !['unspec', 'A', 'AAAA'].includes(queryType) ||
        !['system', 'any'].includes(source) || cacheUsage !== 'allowed' || secureDnsPolicy !== 'allow') {
      unsupported('net.resolveHost DNS policy');
    }
    const endpoints = await dns.lookup(host, { all: true, family: queryType === 'A' ? 4 : queryType === 'AAAA' ? 6 : 0 });
    return { endpoints: endpoints.map(item => ({ address: item.address, family: item.family === 4 ? 'ipv4' : 'ipv6' })) };
  }
  const binding = {
    isValidHeaderName: value => { try { http.validateHeaderName(value); return true; } catch { return false; } },
    isValidHeaderValue: value => { try { http.validateHeaderValue('value', value); return true; } catch { return false; } },
    // An OS interface hint, just as online status cannot prove Internet access.
    // No background polling or network probes are installed.
    isOnline: () => {
      try { return Object.values(os.networkInterfaces()).some(addresses => addresses?.some(item => !item.internal)); }
      catch { return false; }
    },
    createURLLoader: options => {
      try {
        if ((options.partition && options.partition !== '') ||
            (options.session && options.session !== session?.defaultSession)) unsupported('net session partition');
        if (options.referrerPolicy || options.priority !== undefined || options.priorityIncremental !== undefined ||
            options.mode === 'same-origin') unsupported('net request policy');
        return createURLLoader(options, { track, untrack: value => active.delete(value),
          agentFor: protocol => agents[protocol], unsupported, onAuthRequired });
      } catch (error) {
        // _startRequest also runs in the original SlurpStream finish listener.
        // Report admission errors asynchronously through its URLLoader contract.
        const loader = new EventEmitter();
        const pending = setImmediate(() => loader.emit('error', {}, error.message));
        loader.cancel = () => clearImmediate(pending);
        return loader;
      }
    },
    createWebSocket,
    resolveHost,
  };
  async function fetchWithSession(input, init, session, request) {
    check();
    return loadInternal('browser/api/net-fetch').fetchWithSession(input, init, session, request);
  }
  return { binding, close, resolveHost, fetchWithSession };
}
module.exports = { createNetBinding };

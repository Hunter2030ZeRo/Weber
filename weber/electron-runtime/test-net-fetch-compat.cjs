// Real traffic through Electron's fetch wrapper on Node and Bun.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { createNetBinding } = require('./net-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');

async function fixture(t) {
  const app = Object.assign(new EventEmitter(), { isReady: () => true });
  class Session {}
  const session = { defaultSession: new Session() };
  let loader;
  const loadInternal = name => loader.load(path.join(__dirname, 'dist', name + '.js'));
  const runtime = createNetBinding({ app, session, loadInternal });
  const linkedBinding = process._linkedBinding;
  process._linkedBinding = name => {
    if (name === 'electron_common_net') return runtime.binding;
    if (name === 'electron_browser_session') return { Session };
    return linkedBinding(name);
  };
  loader = createCommonJSLoader(name => {
    if (name === 'electron/main') return { value: { app, session } };
    if (name.startsWith('@electron/internal/')) return { value: loadInternal(name.slice('@electron/internal/'.length)) };
  });
  const api = loadInternal('browser/api/net');
  session.defaultSession.fetch = (input, init) => runtime.fetchWithSession(input, init, session.defaultSession, api.request);
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.end(Buffer.concat(chunks));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    runtime.close(); process._linkedBinding = linkedBinding;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { api, requests, url: `http://127.0.0.1:${server.address().port}/` };
}

test('fetch credentials omit works for URL and Request inputs without changing the global Request', { timeout: 10000 }, async t => {
  const { api, url, requests } = await fixture(t);
  const RequestConstructor = globalThis.Request;
  for (const input of [url, new Request(url, { credentials: 'include' })]) {
    const response = await api.fetch(input, { method: 'POST', body: 'owned fetch body', credentials: 'omit' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'owned fetch body');
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.method === 'POST' && request.body === 'owned fetch body'));
  assert.ok(requests.every(request => request.headers.cookie === undefined && request.headers.authorization === undefined));
  assert.equal(globalThis.Request, RequestConstructor);
});

test('fetch validates credentials and preserves unsupported referrer restrictions before network dispatch', { timeout: 10000 }, async t => {
  const { api, url, requests } = await fixture(t);
  for (const credentials of ['invalid', null, Symbol('credentials')]) {
    await assert.rejects(api.fetch(url, { credentials }), error => error instanceof TypeError);
  }
  for (const referrerPolicy of ['invalid', null, Symbol('referrerPolicy')]) {
    await assert.rejects(api.fetch(url, { credentials: 'omit', referrerPolicy }), error => error instanceof TypeError);
  }
  for (const referrerPolicy of ['no-referrer', 'origin', 'same-origin', 'strict-origin-when-cross-origin']) {
    await assert.rejects(api.fetch(url, { credentials: 'omit', referrerPolicy }), /request policy/);
  }
  for (const credentials of ['same-origin', 'include']) {
    await assert.rejects(api.fetch(url, { credentials }), /cookies|authentication/);
  }
  assert.equal(requests.length, 0);
});

test('a failed fetch upload rejects its own promise before dispatch without an unhandled rejection', { timeout: 10000 }, async t => {
  const { api, url, requests } = await fixture(t);
  for (const partial of [false, true]) {
    const failure = new Error(partial ? 'upload failed after bytes' : 'upload failed before bytes');
    const body = new ReadableStream({ start(controller) {
      if (partial) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        setImmediate(() => controller.error(failure));
      } else controller.error(failure);
    } });
    await assert.rejects(api.fetch(url, { method: 'POST', body, duplex: 'half', credentials: 'omit' }),
      error => error === failure);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 0);
});

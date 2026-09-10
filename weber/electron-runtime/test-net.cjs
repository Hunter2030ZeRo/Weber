// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createNetBinding } = require('./net-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');

const limit = { timeout: 15000 };
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function original(t, options = {}) {
  let ready = true;
  const app = Object.assign(new EventEmitter(), { isReady: () => ready });
  class Session {}
  const defaultSession = new Session();
  let loader;
  const loadInternal = name => loader.load(path.join(__dirname, 'dist', `${name}.js`));
  const session = { defaultSession };
  const runtime = createNetBinding({ app, loadInternal, session, ...options });
  const electron = { app, session, Session };
  const saved = process._linkedBinding;
  process._linkedBinding = name => {
    if (name === 'electron_common_net') return runtime.binding;
    if (name === 'electron_browser_session') return { Session };
    return saved(name);
  };
  t.after(() => { runtime.close(); process._linkedBinding = saved; });
  loader = createCommonJSLoader(name => {
    if (name === 'electron/main' || name === 'electron/common' || name === 'electron') return { value: electron };
    if (name.startsWith('@electron/internal/')) return { value: loadInternal(name.slice('@electron/internal/'.length)) };
  });
  const api = loadInternal('browser/api/net');
  defaultSession.fetch = (input, init) => runtime.fetchWithSession(input, init, defaultSession, api.request);
  defaultSession.resolveHost = runtime.resolveHost;
  return { api, runtime, app, setReady: value => { ready = value; } };
}
async function server(t, handler, tls) {
  const sockets = new Set();
  const value = tls ? https.createServer(tls, handler) : http.createServer(handler);
  value.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  value.listen(0, '127.0.0.1');
  await once(value, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => value.close(resolve));
  });
  return { value, url: `${tls ? 'https' : 'http'}://127.0.0.1:${value.address().port}` };
}
function collect(api, options, body, prepare) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = api.request(options, response => {
        const chunks = [];
        response.on('error', reject);
        response.on('data', data => chunks.push(data));
        response.on('end', () => resolve({ response, body: Buffer.concat(chunks), request: req }));
      });
      req.on('error', reject);
      prepare?.(req);
      req.end(body);
    } catch (error) { req?.abort(); reject(error); }
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test('original net API preserves status, duplicate headers, cookie arrays and binary bytes', limit, async t => {
  const { api } = original(t);
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const seen = deferred();
  const endpoint = await server(t, (req, res) => {
    seen.resolve(req.headers);
    res.writeHead(203, 'Owned result', ['Content-Type', 'application/octet-stream', 'X-Repeat', 'first',
      'X-Repeat', 'second', 'Set-Cookie', 'one=1; Path=/', 'Set-Cookie', 'two=2; Path=/']);
    res.end(bytes);
  });
  const result = await collect(api, endpoint.url, undefined, req => {
    req.setHeader('X-Owned', 'kept');
    req.setHeader('X-Remove', 'removed'); req.removeHeader('x-remove');
    assert.equal(req.getHeader('x-owned'), 'kept');
    assert.throws(() => req.setHeader('Bad Header', 'x'), /Invalid header/);
    assert.throws(() => req.setHeader('X-Bad', 'x\r\ny'), /Invalid value/);
  });
  assert.deepEqual(result.body, bytes);
  assert.equal(result.response.statusCode, 203);
  assert.equal(result.response.statusMessage, 'Owned result');
  assert.equal(result.response.httpVersion, '1.1');
  assert.equal(result.response.headers['x-repeat'], 'first, second');
  assert.deepEqual(result.response.headers['set-cookie'], ['one=1; Path=/', 'two=2; Path=/']);
  assert.equal(result.response.rawHeaders.filter(value => value.toLowerCase() === 'x-repeat').length, 2);
  const headers = await seen.promise;
  assert.equal(headers['x-owned'], 'kept'); assert.equal(headers['x-remove'], undefined);
  assert.throws(() => result.request.setHeader('X-Late', 'x'), /after they are sent/);
});

test('gzip, deflate and Brotli responses decode through original response streams', limit, async t => {
  const { api } = original(t);
  const bytes = Buffer.from('Weber 압축 응답\0'.repeat(2048));
  const encode = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };
  const endpoint = await server(t, (req, res) => {
    const encoding = req.url.slice(1);
    res.writeHead(200, { 'Content-Encoding': encoding }); res.end(encode[encoding](bytes));
  });
  for (const encoding of Object.keys(encode)) {
    const result = await collect(api, `${endpoint.url}/${encoding}`);
    assert.deepEqual(result.body, bytes, encoding);
  }
});

test('redirect policies cancel or explicitly follow, rewrite POST and preserve 307 bodies', limit, async t => {
  const { api } = original(t);
  let targetHits = 0;
  const endpoint = await server(t, async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/target') { targetHits++; res.end(JSON.stringify({ method: req.method, body: body.toString(), contentType: req.headers['content-type'] })); }
    else { res.writeHead(Number(req.url.slice(1)), { Location: '/target' }); res.end(); }
  });
  await assert.rejects(collect(api, { url: `${endpoint.url}/302`, redirect: 'error' }), /redirect policy/);
  await assert.rejects(collect(api, { url: `${endpoint.url}/302`, redirect: 'manual' }), /Redirect was cancelled/);
  assert.equal(targetHits, 0);
  const redirected = [];
  const followed = await collect(api, { url: `${endpoint.url}/302`, redirect: 'manual', method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'payload', req => {
    req.on('redirect', (status, method, url) => { redirected.push([status, method, url]); req.followRedirect(); });
  });
  assert.deepEqual(redirected, [[302, 'GET', `${endpoint.url}/target`]]);
  assert.deepEqual(JSON.parse(followed.body), { method: 'GET', body: '' });
  const preserved = await collect(api, { url: `${endpoint.url}/307`, method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'payload');
  assert.deepEqual(JSON.parse(preserved.body), { method: 'POST', body: 'payload', contentType: 'text/plain' });
  assert.throws(() => preserved.request.followRedirect(), /not waiting/);
});

test('cross-origin redirects strip caller authentication and cookies without creating a jar', limit, async t => {
  const { api } = original(t);
  const target = await server(t, (req, res) => res.end(JSON.stringify(req.headers)));
  const source = await server(t, (req, res) => {
    res.writeHead(302, { Location: target.url, 'Set-Cookie': 'server-secret=private' }); res.end();
  });
  const result = await collect(api, { url: source.url, headers: {
    Authorization: 'Basic owned', Cookie: 'caller-secret=private', 'Proxy-Authorization': 'Basic proxy-owned', 'X-Request': 'kept',
  } });
  const headers = JSON.parse(result.body);
  for (const key of ['authorization', 'cookie', 'proxy-authorization']) assert.equal(headers[key], undefined, key);
  assert.equal(headers['x-request'], 'kept');
  const later = JSON.parse((await collect(api, target.url)).body);
  assert.equal(later.cookie, undefined);
});

test('chunked upload reaches the server before end and preserves write order', limit, async t => {
  const { api } = original(t);
  const firstSeen = deferred();
  const endpoint = await server(t, (req, res) => {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); firstSeen.resolve(); });
    req.on('end', () => { res.setHeader('X-Transfer', req.headers['transfer-encoding'] || ''); res.end(Buffer.concat(chunks)); });
  });
  const finished = deferred();
  const req = api.request({ url: endpoint.url, method: 'POST' }, response => {
    const chunks = []; response.on('error', finished.reject);
    response.on('data', data => chunks.push(data));
    response.on('end', () => finished.resolve({ body: Buffer.concat(chunks), response }));
  });
  req.on('error', finished.reject);
  req.chunkedEncoding = true;
  const first = Buffer.alloc(96 * 1024, 0x31), second = Buffer.alloc(96 * 1024, 0x32);
  await new Promise((resolve, reject) => req.write(first, error => error ? reject(error) : resolve()));
  await firstSeen.promise;
  assert.equal(req.writableEnded, false);
  assert.throws(() => { req.chunkedEncoding = false; }, /before the request is started/);
  req.end(second);
  const result = await finished.promise;
  assert.deepEqual(result.body, Buffer.concat([first, second]));
  assert.equal(result.response.headers['x-transfer'], 'chunked');
  assert.equal(req.getUploadProgress().current, first.length + second.length);
});

test('an empty chunked upload opens and finishes its transport', limit, async t => {
  const { api } = original(t);
  const endpoint = await server(t, async (req, res) => {
    const body = await readBody(req);
    res.setHeader('X-Transfer', req.headers['transfer-encoding'] || '');
    res.end(String(body.length));
  });
  const result = await collect(api, { url: endpoint.url, method: 'POST' }, undefined,
    req => { req.chunkedEncoding = true; });
  assert.equal(result.body.toString(), '0');
  assert.equal(result.response.headers['x-transfer'], 'chunked');
});

test('rejecting an oversized streaming write closes the active upload socket', limit, async t => {
  const { api } = original(t);
  const firstSeen = deferred(), socketClosed = deferred();
  const endpoint = await server(t, (req, _res) => {
    req.socket.once('close', socketClosed.resolve);
    req.on('data', firstSeen.resolve);
  });
  const req = api.request({ url: endpoint.url, method: 'POST' });
  req.chunkedEncoding = true;
  const errorSeen = once(req, 'error');
  await new Promise((resolve, reject) => req.write('first', error => error ? reject(error) : resolve()));
  await firstSeen.promise;
  const writeError = await new Promise(resolve => req.write(Buffer.alloc(64 * 1024 * 1024 + 1), resolve));
  assert.match(writeError.message, /exceeds 64 MiB/);
  const [requestError] = await errorSeen;
  assert.match(requestError.message, /exceeds 64 MiB/);
  await socketClosed.promise;
  assert.equal(req.destroyed, true);
});

test('paused original response retains one delivery and resumes without losing bytes', limit, async t => {
  const { api } = original(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x7b);
  const endpoint = await server(t, (_req, res) => res.end(bytes));
  const responseSeen = deferred(), firstData = deferred(), errorSeen = deferred();
  const req = api.request(endpoint.url, response => responseSeen.resolve(response));
  req.on('error', errorSeen.reject); req.end();
  let deliveries = 0;
  req._urlLoader.on('data', () => { deliveries++; firstData.resolve(); });
  const response = await Promise.race([responseSeen.promise, errorSeen.promise]);
  response.on('error', errorSeen.reject);
  await Promise.race([firstData.promise, errorSeen.promise]);
  await turn(); await turn();
  assert.equal(deliveries, 1);
  assert.equal(response._data.length, 1);
  assert.ok(response._data[0].length <= 128 * 1024, 'one bounded transport chunk is retained');
  const chunks = [];
  const ended = once(response, 'end');
  response.on('data', data => chunks.push(data));
  response.resume(); await ended;
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.ok(deliveries > 1);
});

test('aborting an active response closes its socket and suppresses subsequent delivery', limit, async t => {
  const { api } = original(t);
  const socketClosed = deferred();
  const endpoint = await server(t, (req, res) => {
    req.socket.once('close', socketClosed.resolve);
    res.write('first');
  });
  const aborted = deferred();
  let dataEvents = 0, completeEvents = 0;
  const req = api.request(endpoint.url, response => {
    response.on('error', aborted.reject);
    response.on('data', () => { dataEvents++; req.abort(); });
    response.on('end', () => { completeEvents++; });
  });
  req.on('error', aborted.reject); req.on('abort', aborted.resolve); req.end();
  await aborted.promise; await socketClosed.promise; await turn();
  assert.equal(dataEvents, 1); assert.equal(completeEvents, 0);
  assert.equal(req.destroyed, true);
});

test('abort from download-progress suppresses the pending data event', limit, async t => {
  const { api } = original(t);
  const socketClosed = deferred();
  const endpoint = await server(t, (req, res) => {
    req.socket.once('close', socketClosed.resolve);
    res.write('first');
  });
  let dataEvents = 0;
  const req = api.request(endpoint.url, response => {
    response.once('download-progress', () => req.abort());
  });
  const aborted = once(req, 'abort');
  req.end();
  req._urlLoader.on('data', () => { dataEvents++; });
  await aborted;
  await socketClosed.promise;
  assert.equal(dataEvents, 0);
});

test('destroying the response or cancelling a fetch reader closes a paused transport', limit, async t => {
  const { api } = original(t);
  for (const consumer of ['request', 'fetch']) {
    const socketClosed = deferred();
    const endpoint = await server(t, (req, res) => {
      req.socket.once('close', socketClosed.resolve);
      res.write(Buffer.alloc(96 * 1024, 0x61));
    });
    if (consumer === 'fetch') {
      const response = await api.fetch(endpoint.url, { credentials: 'omit' });
      const reader = response.body.getReader();
      assert.ok((await reader.read()).value.length > 0);
      await reader.cancel();
    } else {
      const destroyed = deferred();
      const req = api.request(endpoint.url, response => {
        response.once('close', destroyed.resolve);
        response.destroy();
      });
      req.on('error', destroyed.reject);
      req.end();
      await destroyed.promise;
    }
    await socketClosed.promise;
  }
});

test('Basic authentication challenges retry owned credentials and do not share them', limit, async t => {
  const { api } = original(t);
  let prompts = 0;
  const expected = `Basic ${Buffer.from('owned:secret').toString('base64')}`;
  const endpoint = await server(t, (req, res) => {
    if (req.headers.authorization === expected) res.end('authenticated');
    else { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="owned-test"' }); res.end('denied'); }
  });
  const result = await collect(api, endpoint.url, undefined, req => req.on('login', (info, callback) => {
    prompts++;
    assert.equal(info.scheme, 'basic'); assert.equal(info.realm, 'owned-test'); assert.equal(info.isProxy, false);
    callback('owned', 'secret'); callback('ignored', 'ignored');
  }));
  assert.equal(result.body.toString(), 'authenticated'); assert.equal(prompts, 1);
  assert.equal((await collect(api, endpoint.url)).response.statusCode, 401);
  const omitted = await collect(api, { url: endpoint.url, credentials: 'omit' }, undefined, req => req.on('login', () => assert.fail('credentials omit must not prompt')));
  assert.equal(omitted.response.statusCode, 401);
});

test('forwarded authentication handles synchronous replies and disposes the challenge once', limit, async t => {
  let prompts = 0, disposals = 0;
  const expected = `Basic ${Buffer.from('owned:secret').toString('base64')}`;
  const endpoint = await server(t, (req, res) => {
    if (req.headers.authorization === expected) res.end('authenticated');
    else { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="forwarded"' }); res.end('denied'); }
  });
  const { api } = original(t, { onAuthRequired(details, authInfo, respond) {
    prompts++;
    assert.equal(details.url, `${endpoint.url}/`);
    assert.equal(details.isRequestForNavigation, false);
    assert.equal(details.isMainFrame, false);
    assert.equal(details.firstAuthAttempt, true);
    assert.deepEqual(details.responseHeaders['www-authenticate'], ['Basic realm="forwarded"']);
    assert.equal(authInfo.realm, 'forwarded');
    respond('owned', 'secret');
    return () => { disposals++; };
  } });
  const result = await collect(api, endpoint.url, undefined, req => {
    req.on('login', () => assert.fail('the forwarded challenge must not also emit request login'));
  });
  assert.equal(result.body.toString(), 'authenticated');
  assert.equal(prompts, 1);
  assert.equal(disposals, 1);
});

test('aborting a forwarded authentication prompt disposes it and ignores late credentials', limit, async t => {
  const prompted = deferred(), socketClosed = deferred();
  let respond, disposals = 0, requests = 0;
  const endpoint = await server(t, (req, res) => {
    requests++;
    req.socket.once('close', socketClosed.resolve);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pending"' });
    res.write('pending');
  });
  const { api } = original(t, { onAuthRequired(_details, _authInfo, callback) {
    respond = callback;
    prompted.resolve();
    return () => { disposals++; };
  } });
  const req = api.request(endpoint.url);
  const aborted = once(req, 'abort');
  req.end();
  await prompted.promise;
  req.abort();
  await aborted;
  await socketClosed.promise;
  respond('late', 'ignored');
  await turn();
  assert.equal(disposals, 1);
  assert.equal(requests, 1);
});

test('original fetch streams a body, handles HEAD and rejects abort before dispatch', limit, async t => {
  const { api } = original(t);
  let requests = 0;
  const endpoint = await server(t, async (req, res) => {
    requests++; const body = await readBody(req); res.setHeader('X-Owned', 'fetch'); res.end(body.length ? body : Buffer.from('fetched'));
  });
  const response = await api.fetch(endpoint.url, { method: 'POST', body: 'fetch payload', credentials: 'omit' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-owned'), 'fetch');
  assert.equal(await response.text(), 'fetch payload');
  const head = await api.fetch(endpoint.url, { method: 'HEAD', credentials: 'omit' });
  assert.equal(head.body, null); assert.equal(await head.text(), '');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.fetch(endpoint.url, { signal: controller.signal, credentials: 'omit' }), error => error.name === 'AbortError');
  assert.equal(requests, 2);
});

test('unsupported shared-cookie, cache and origin policies fail before a network request', limit, async t => {
  const { api } = original(t);
  let requests = 0;
  const endpoint = await server(t, (_req, res) => { requests++; res.end(); });
  for (const options of [
    { useSessionCookies: true }, { credentials: 'include' }, { cache: 'force-cache' },
    { cache: 'only-if-cached' }, { origin: endpoint.url, headers: { 'Sec-Fetch-Mode': 'cors' } },
    { partition: 'persist:unconnected' }, { referrerPolicy: 'no-referrer' },
  ]) {
    await assert.rejects(collect(api, { url: endpoint.url, method: 'POST', ...options }, 'owned body'), /cookies|authentication|cache|Origin-constrained|partition|policy/);
  }
  assert.equal(requests, 0);
  // Request defaults never grant access to Obscura's browser cookie jar.
  await assert.rejects(api.fetch(endpoint.url), /cookies|authentication/);
});

test('original readiness and DNS contracts remain active without network polling', limit, async t => {
  const { api, setReady, runtime } = original(t);
  setReady(false);
  assert.throws(() => api.request('http://127.0.0.1/'), /after app is ready/);
  assert.throws(() => new api.WebSocket('ws://127.0.0.1/'), /after app is ready/);
  setReady(true);
  const resolved = await api.resolveHost('localhost', { queryType: 'A' });
  assert.ok(resolved.endpoints.length > 0);
  for (const endpoint of resolved.endpoints) { assert.equal(endpoint.family, 'ipv4'); assert.match(endpoint.address, /^127\./); }
  assert.equal(typeof api.online, 'boolean'); assert.equal(typeof api.isOnline(), 'boolean');
  await assert.rejects(api.resolveHost('localhost', { cacheUsage: 'disallowed' }), /DNS policy/);
  await assert.rejects(api.resolveHost('bad/name'), /Invalid DNS hostname/);
  runtime.close();
  await assert.rejects(api.resolveHost('localhost'), /closed/);
});

test('sequential requests reuse an owned keep-alive connection', limit, async t => {
  const { api } = original(t);
  const connections = new Set();
  const endpoint = await server(t, (req, res) => { connections.add(req.socket); res.end('reused'); });
  for (let i = 0; i < 3; i++) assert.equal((await collect(api, endpoint.url)).body.toString(), 'reused');
  assert.equal(connections.size, 1);
});

test('invalid request framing and unsupported encodings produce errors instead of partial success', limit, async t => {
  const { api } = original(t);
  let requests = 0;
  const endpoint = await server(t, (req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Encoding': req.url === '/corrupt' ? 'gzip' : 'gzip, br' });
    res.end('owned invalid compressed bytes');
  });
  for (const headers of [
    { 'Content-Length': '2' }, { 'Content-Length': '-1' },
    { 'Content-Length': '3', 'Transfer-Encoding': 'chunked' },
  ]) await assert.rejects(collect(api, { url: endpoint.url, method: 'POST', headers }, 'abc'), /Content-Length/);
  assert.equal(requests, 0);
  await assert.rejects(collect(api, `${endpoint.url}/corrupt`), /header|compressed|incorrect|format|data/i);
  await assert.rejects(collect(api, `${endpoint.url}/stacked`), /Unsupported response content encoding/);
});

test('redirect loops terminate at the bounded hop limit', limit, async t => {
  const { api } = original(t);
  let requests = 0;
  const endpoint = await server(t, (_req, res) => { requests++; res.writeHead(302, { Location: '/' }); res.end(); });
  await assert.rejects(collect(api, endpoint.url), /ERR_TOO_MANY_REDIRECTS/);
  assert.equal(requests, 21);
});

test('untrusted local TLS certificates remain rejected', limit, async t => {
  const { api } = original(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weber-net-test-tls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore', timeout: 10000 });
  let requests = 0;
  const endpoint = await server(t, (_req, res) => { requests++; res.end('must not be read'); }, { key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  await assert.rejects(collect(api, endpoint.url), /certificate|self.signed|cert/i);
  assert.equal(requests, 0);
});

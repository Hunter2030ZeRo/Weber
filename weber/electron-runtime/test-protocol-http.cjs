'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { EventEmitter, once } = require('node:events');
const { createProtocolBinding } = require('./protocol-binding.cjs');
function setup(t) {
  const app = Object.assign(new EventEmitter(), { isReady: () => true });
  const host = new EventEmitter(), windows = new Map();
  const { session } = createProtocolBinding({ app, host, windows, unsupported: n => { throw new Error(n); } });
  const owner = session.fromPartition('owner');
  const wc = Object.assign(new EventEmitter(), { id: 1, session: owner, _navigation: 1, _command: async () => null });
  windows.set(1, { webContents: wc, isDestroyed: () => false });
  t.after(() => app.emit('quit'));
  const request = (extra = {}) => new Promise(resolve => {
    host.request = async (_method, value) => resolve(value.response);
    host.emit('event', { event: 'resource-request', windowId: 1, resourceId: 1, request: { url: 'owned://app/test', method: 'GET', ...extra } });
  });
  return { owner, session, wc, request };
}
async function endpoint(t, handler) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('HTTP protocol registration forwards compressed bytes, status and headers with owner policy', async t => {
  const { owner, request } = setup(t); let seen;
  const url = await endpoint(t, (req, res) => { seen = req.headers; res.writeHead(201, { 'Content-Encoding': 'gzip', 'X-Upstream': 'yes' }); res.end(zlib.gzipSync('forwarded')); });
  owner.webRequest.onBeforeSendHeaders({ urls: [`${url}/*`] }, (d, cb) => cb({ requestHeaders: { ...d.requestHeaders, 'X-Owner': 'yes' } }));
  assert.equal(owner.protocol.registerHttpProtocol('owned', (_req, cb) => cb({ url })), true);
  assert.equal(owner.protocol.registerHttpProtocol('owned', () => {}), false);
  const result = await request(); assert.equal(result.statusCode, 201); assert.equal(Buffer.from(result.data, 'base64').toString(), 'forwarded');
  assert.equal(result.headers['x-upstream'], 'yes'); assert.equal(result.headers['content-encoding'], undefined); assert.equal(seen['x-owner'], 'yes');
  assert.equal(owner.protocol.unregisterProtocol('owned'), true);
  assert.match((await request()).error, /registered/);
});
test('HTTP protocol applies selected session and replacement POST body', async t => {
  const { owner, session, request } = setup(t); const target = session.fromPartition('target'); let seen;
  const url = await endpoint(t, (req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { seen = { method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers }; res.end('ok'); }); });
  owner.webRequest.onBeforeRequest({ urls: [`${url}/*`] }, (_d, cb) => cb({ cancel: true }));
  target.webRequest.onBeforeSendHeaders((_d, cb) => cb({ requestHeaders: { 'X-Target': 'yes', 'Content-Type': 'text/plain' } }));
  owner.protocol.registerHttpProtocol('owned', (_req, cb) => cb({ url, session: target, uploadData: { contentType: 'text/plain', data: 'new' } }));
  const result = await request({ method: 'POST', headers: { 'content-length': '99' }, body: Buffer.from('old').toString('base64') });
  assert.equal(result.error, undefined); assert.equal(seen.method, 'POST'); assert.equal(seen.body, 'new'); assert.equal(seen.headers['x-target'], 'yes');
});
test('HTTP forwarding follows redirects and strips cross-origin credentials', async t => {
  const { owner, request } = setup(t); let headers;
  const target = await endpoint(t, (req, res) => { headers = req.headers; res.end('ok'); });
  const url = await endpoint(t, (_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  owner.protocol.registerHttpProtocol('owned', (_req, cb) => cb({ url }));
  assert.equal((await request({ headers: { authorization: 'private', cookie: 'private' } })).error, undefined);
  assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
});
test('HTTP forwarding rejects invalid destinations, sessions and oversized responses', async t => {
  const { owner, request } = setup(t); let result;
  owner.protocol.registerHttpProtocol('owned', (_req, cb) => cb(result));
  for (result of [{ url: 'file:///tmp/x' }, { url: 'http://user:pass@localhost/' }, { url: 'http://localhost/', session: {} }]) assert.ok((await request()).error);
  const url = await endpoint(t, (_req, res) => res.end(Buffer.alloc(512 * 1024 + 1)));
  result = { url }; assert.match((await request()).error, /512 KiB/);
});
test('navigation cancels an active HTTP response and releases lifecycle listeners', async t => {
  const { owner, request, wc } = setup(t); let begin;
  const started = new Promise(r => { begin = r; });
  const url = await endpoint(t, (_req, res) => { res.write('partial'); begin(); });
  owner.protocol.registerHttpProtocol('owned', (_req, cb) => cb({ url }));
  const pending = request(); await started; wc.emit('did-start-loading');
  assert.match((await pending).error, /cancelled/);
  await new Promise(r => setImmediate(r)); assert.equal(wc.listenerCount('destroyed'), 0);
});
test('HTTP policy cancellation prevents the server request and interception can be removed', async t => {
  const { owner, request } = setup(t); let hits = 0;
  const url = await endpoint(t, (_req, res) => { hits++; res.end('ok'); });
  owner.protocol.interceptHttpProtocol('owned', (_req, cb) => cb({ url, session: null }));
  assert.equal(owner.protocol.isProtocolIntercepted('owned'), true);
  owner.webRequest.onBeforeRequest({ urls: [`${url}/*`] }, (_d, cb) => cb({ cancel: true }));
  assert.match((await request()).error, /ERR_BLOCKED_BY_CLIENT/); assert.equal(hits, 0);
  assert.equal(owner.protocol.uninterceptProtocol('owned'), true);
  owner.protocol.registerHttpProtocol('owned', (_req, cb) => cb(-6));
  assert.equal((await request()).error, -6);
});

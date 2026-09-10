// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { WebRequest } = require('./web-request.cjs');
const { createProtocolBinding } = require('./protocol-binding.cjs');
const { createNetBinding } = require('./net-binding.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
const limit = { timeout: 10000 };
function runtime(t) {
  const app = Object.assign(new EventEmitter(), { isReady: () => true });
  const host = new EventEmitter(), windows = new Map();
  const protocols = createProtocolBinding({ app, host, windows, unsupported: name => { throw new Error(name); } });
  let modules;
  const loadInternal = name => modules.load(path.join(__dirname, 'dist', `${name}.js`));
  const net = createNetBinding({ app, loadInternal, session: protocols.session });
  const electron = { app, session: protocols.session };
  const originalBinding = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_common_net' ? net.binding :
    name === 'electron_browser_session' ? { Session: protocols.Session } : originalBinding(name);
  modules = createCommonJSLoader(name => {
    if (['electron', 'electron/main', 'electron/common'].includes(name)) return { value: electron };
    if (name.startsWith('@electron/internal/')) return { value: loadInternal(name.slice('@electron/internal/'.length)) };
  });
  t.after(() => { net.close(); process._linkedBinding = originalBinding; });
  return { api: loadInternal('browser/api/net'), ...protocols, app, host, windows };
}
async function endpoint(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
function collect(api, options, prepare) {
  return new Promise((resolve, reject) => {
    const req = api.request(options, response => {
      const chunks = []; response.on('error', reject);
      response.on('data', bytes => chunks.push(bytes));
      response.on('end', () => resolve({ response, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); prepare?.(req); req.end();
  });
}
test('partition policy blocks a real request before the server sees it, without affecting another partition', limit, async t => {
  const { api, session } = runtime(t); let hits = 0;
  const url = await endpoint(t, (_req, res) => { hits++; res.end('allowed'); });
  const restricted = session.fromPartition('restricted'), separate = session.fromPartition('separate');
  restricted.webRequest.onBeforeRequest({ urls: [`${url}/*`] }, (_details, callback) => callback({ cancel: true }));
  await assert.rejects(collect(api, { url, session: restricted }), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(hits, 0);
  assert.equal((await collect(api, { url, partition: 'separate' })).body, 'allowed');
  assert.equal(separate, session.fromPartition('separate')); assert.equal(hits, 1);
  restricted.webRequest.onBeforeRequest(null);
  assert.equal((await collect(api, { url, session: restricted })).body, 'allowed');
});
test('before-request redirect rechecks policy, preserves request ID, and strips cross-origin credentials', limit, async t => {
  const { api, session } = runtime(t); let sourceHits = 0, targetHeaders;
  const source = await endpoint(t, (_req, res) => { sourceHits++; res.end('wrong'); });
  const target = await endpoint(t, (req, res) => { targetHeaders = req.headers; res.end('redirected'); });
  const seen = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    seen.push({ id: details.id, url: details.url });
    callback(details.url.startsWith(source) ? { redirectURL: `${target}/next` } : {});
  });
  const result = await collect(api, { url: source, headers: { Authorization: 'Basic owned', Cookie: 'owned=yes' } });
  assert.equal(result.body, 'redirected'); assert.equal(sourceHits, 0);
  assert.equal(targetHeaders.authorization, undefined); assert.equal(targetHeaders.cookie, undefined);
  assert.equal(seen.length, 2); assert.equal(seen[0].id, seen[1].id);
});
test('response policy changes duplicate headers and status before the original response wrapper sees them', limit, async t => {
  const { api, session } = runtime(t);
  const url = await endpoint(t, (_req, res) => { res.writeHead(200, { 'X-Remove': 'secret' }); res.end('body'); });
  session.defaultSession.webRequest.onHeadersReceived((_details, callback) => callback({
    statusLine: 'HTTP/1.1 202 Policy accepted', responseHeaders: { 'X-Added': ['one', 'two'], 'Set-Cookie': ['a=1', 'b=2'] },
  }));
  const { response, body } = await collect(api, url);
  assert.equal(body, 'body'); assert.equal(response.statusCode, 202); assert.equal(response.statusMessage, 'Policy accepted');
  assert.equal(response.headers['x-remove'], undefined); assert.equal(response.headers['x-added'], 'one, two');
  assert.deepEqual(response.headers['set-cookie'], ['a=1', 'b=2']);
});
test('server redirect targets and received headers can be cancelled without delivering response bytes', limit, async t => {
  const { api, session } = runtime(t); let targetHits = 0;
  const url = await endpoint(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/blocked' }); res.end(); }
    else { targetHits++; res.end('must not arrive'); }
  });
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${url}/blocked`] }, (_details, callback) => callback({ cancel: true }));
  await assert.rejects(collect(api, `${url}/start`), /ERR_BLOCKED_BY_CLIENT/); assert.equal(targetHits, 0);
  session.defaultSession.webRequest.onHeadersReceived((_details, callback) => callback({ cancel: true }));
  await assert.rejects(collect(api, `${url}/response`), /ERR_BLOCKED_BY_CLIENT/); assert.equal(targetHits, 1);
});
test('malformed, throwing, timed-out and late policy replies fail closed and remain bounded', limit, async t => {
  const { api, session } = runtime(t); let hits = 0;
  const url = await endpoint(t, (_req, res) => { hits++; res.end('no'); });
  const policy = session.defaultSession.webRequest; policy.timeoutMs = 20;
  for (const handler of [() => { throw new Error('policy error'); }, () => {}, (_d, cb) => cb({ cancel: 'false' })]) {
    policy.onBeforeRequest(handler); await assert.rejects(collect(api, url), /policy error|timed out|boolean/);
  }
  assert.equal(hits, 0);
  let late; policy.onBeforeRequest((_details, callback) => { late = callback; });
  await assert.rejects(collect(api, url), /timed out/); late({});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(hits, 0);
  policy.onBeforeRequest(null);
  policy.onHeadersReceived((_details, cb) => cb({ responseHeaders: { 'X-Bad': ['one\r\ntwo'] } }));
  await assert.rejects(collect(api, url), /Invalid character/);
});
test('aborting while policy is pending ignores its later grant and closes the request', limit, async t => {
  const { api, session } = runtime(t); let hits = 0, callback, started;
  const pending = new Promise(resolve => { started = resolve; });
  const url = await endpoint(t, (_req, res) => { hits++; res.end('no'); });
  session.defaultSession.webRequest.onBeforeRequest((_details, cb) => { callback = cb; started(); });
  const req = api.request(url); const aborted = once(req, 'abort'); req.end();
  await pending; req.abort(); await aborted; callback({});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(hits, 0);
});
test('URL filters validate atomically and match subdomains, paths and request types', limit, async () => {
  const policy = new WebRequest(); let calls = 0;
  policy.onBeforeRequest({ urls: ['https://*.example.test/api*'], types: ['xhr'] }, (_d, cb) => { calls++; cb({ cancel: true }); });
  assert.throws(() => policy.onBeforeRequest({ urls: ['https://bad*host/*'] }, () => {}), /pattern/);
  for (const [url, resourceType, cancelled] of [
    ['https://example.test/api?q=1','xhr',true], ['https://sub.example.test/api','xhr',true],
    ['https://evil-example.test/api','xhr',false], ['http://example.test/api','xhr',false],
    ['https://example.test/api','script',false], ['https://example.test/other','xhr',false],
  ]) assert.equal((await policy._dispatch('onBeforeRequest', { url, resourceType })).cancel === true, cancelled);
  assert.equal(calls, 2);
  policy.onBeforeRequest((_d,cb)=>cb({cancel:true}));
  assert.equal((await policy._dispatch('onBeforeRequest',{url:'owned://app/file',resourceType:'mainFrame'})).cancel,true);
  policy.onBeforeRequest({urls:[],types:[]},(_d,cb)=>cb({cancel:true}));
  assert.equal((await policy._dispatch('onBeforeRequest',{url:'http://example.test:1234/a',resourceType:'image'})).cancel,true);
  for(const [pattern, url] of [['http://example.test/*','http://example.test:1234/a'],['http://*.example.test:1234/*','http://sub.example.test:1234/a'],['http://example.test:80/*','http://example.test/a']]) {
    policy.onBeforeRequest({urls:[pattern]},(_d,cb)=>cb({cancel:true}));
    assert.equal((await policy._dispatch('onBeforeRequest',{url,resourceType:'xhr'})).cancel,true);
  }
});

test('closing or replacing a document cancels an unfinished protocol response stream and releases listeners', limit, async t => {
  const { app, host, windows, session } = runtime(t);
  for (const event of ['destroyed','did-start-loading']) {
    const owner=session.fromPartition(event), wc=Object.assign(new EventEmitter(),{id:1,session:owner,_navigation:1,_command:async()=>null});
    windows.set(1,{webContents:wc,isDestroyed:()=>false});
    const body=new PassThrough(); let begin;
    const started=new Promise(resolve=>{begin=resolve;});
    owner.protocol.registerStreamProtocol('owned',(_request,callback)=>{callback({data:body});setImmediate(begin);});
    const result=new Promise(resolve=>{host.request=async(_method,value)=>resolve(value.response);});
    host.emit('event',{event:'resource-request',windowId:1,resourceId:1,request:{url:'owned://app/stream'}});
    await started;wc.emit(event);
    assert.match((await result).error,/cancelled|active/);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(body.destroyed,true);assert.equal(wc.listenerCount('destroyed'),0);assert.equal(wc.listenerCount('did-start-loading'),0);
  }
  assert.equal(app.listenerCount('quit'),1);
});
test('custom protocol cancellation precedes handler execution and headers are applied to the native resource reply', limit, async t => {
  const { app, host, windows, session } = runtime(t);
  const owner = session.fromPartition('protocol'), wc = Object.assign(new EventEmitter(), { id: 1, session: owner, _navigation: 1, _command: async () => null });
  windows.set(1, { webContents: wc, isDestroyed: () => false });
  let calls = 0;
  owner.protocol.registerStringProtocol('owned', (_request, callback) => { calls++; callback('bytes'); });
  owner.webRequest.onBeforeRequest({ urls: ['owned://*/*'] }, (_d, cb) => cb({ cancel: true }));
  const reply = () => new Promise(resolve => { host.request = async (_method, value) => resolve(value.response); });
  const request = () => host.emit('event', { event: 'resource-request', windowId: 1, resourceId: 9, request: { url: 'owned://app/file', method: 'GET', resourceType: 'Document' } });
  let result = reply(); request(); assert.match((await result).error, /ERR_BLOCKED_BY_CLIENT/); assert.equal(calls, 0);
  owner.webRequest.onBeforeRequest(null);
  owner.webRequest.onHeadersReceived({ urls: ['owned://*/*'] }, (details, cb) => {
    assert.equal(details.webContents, wc); assert.equal(details.resourceType, 'mainFrame');
    cb({ responseHeaders: { 'Content-Type': ['text/plain'], 'X-Policy': ['active'] } });
  });
  result = reply(); request(); const received = await result;
  assert.equal(Buffer.from(received.data, 'base64').toString(), 'bytes'); assert.equal(received.headers['x-policy'], 'active'); assert.equal(calls, 1);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(app.listenerCount('quit'), 1); assert.equal(wc.listenerCount('destroyed'), 0);
});

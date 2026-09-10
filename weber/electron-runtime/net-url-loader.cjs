// SPDX-License-Identifier: MIT
'use strict';

// Electron's unchanged ClientRequest owns its public stream and redirect policy.
// This adapter supplies its private URLLoader events using the selected JS
// backend's HTTP transport. It does not own or impersonate Obscura's cookie jar.
const { EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32, maxTotalSockets: 64, maxFreeSockets: 4 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32, maxTotalSockets: 64, maxFreeSockets: 4 }),
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_BODY = 64 * 1024 * 1024;

function unsupported(message) {
  return Object.assign(new Error(message), { code: 'ERR_WEBER_UNSUPPORTED' });
}
function responseHead(response) {
  const rawHeaders = [];
  const headers = Object.create(null);
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const key = response.rawHeaders[i];
    const value = response.rawHeaders[i + 1];
    rawHeaders.push({ key, value });
    (headers[key.toLowerCase()] ||= []).push(value);
  }
  return {
    statusCode: response.statusCode,
    statusMessage: response.statusMessage || '',
    httpVersion: { major: response.httpVersionMajor, minor: response.httpVersionMinor },
    headers, rawHeaders,
    mimeType: String(response.headers['content-type'] || '').split(';')[0],
  };
}

function createURLLoader(options, context = {}) {
  let currentURL = new URL(options.url);
  if (!['http:', 'https:'].includes(currentURL.protocol)) throw unsupported('Network URLLoader supports HTTP and HTTPS only');
  if (currentURL.username || currentURL.password) throw unsupported('URL-embedded network credentials are unsupported; use the login event');
  if (options.useSessionCookies || (options.credentials && options.credentials !== 'omit')) {
    throw unsupported('Obscura session cookies and shared authentication are not connected to this network transport');
  }
  if (options.cache && !['default', 'no-store', 'reload', 'no-cache'].includes(options.cache)) {
    throw unsupported('This network transport does not have a shared HTTP cache');
  }
  if (options.origin && ['cors', 'same-origin'].includes(options.mode)) {
    throw unsupported('Origin-constrained network requests require the shared Obscura network context');
  }
  let method = options.method || 'GET';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) throw new TypeError('Invalid HTTP method');
  if (['CONNECT', 'TRACE', 'TRACK'].includes(method.toUpperCase())) throw new TypeError('Forbidden HTTP method');
  let headers = Object.create(null);
  for (const [name, value] of Object.entries(options.extraHeaders || {})) {
    http.validateHeaderName(name);
    http.validateHeaderValue(name, value);
    headers[name.toLowerCase()] = String(value);
  }
  if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br';
  let body = options.body;
  if (body != null && typeof body !== 'function' && !ArrayBuffer.isView(body)) throw new TypeError('Invalid network request body');
  if (body && typeof body !== 'function' && body.byteLength > MAX_BODY) throw new RangeError('Network request body exceeds 64 MiB');
  if (headers['content-length'] && headers['transfer-encoding']) throw new TypeError('Content-Length and Transfer-Encoding cannot be combined');
  if (headers['transfer-encoding'] && headers['transfer-encoding'].toLowerCase() !== 'chunked') throw unsupported('Unsupported request transfer encoding');
  let expectedBytes;
  if (Object.hasOwn(headers, 'content-length')) {
    if (!/^(0|[1-9][0-9]*)$/.test(headers['content-length'])) throw new TypeError('Invalid Content-Length');
    expectedBytes = Number(headers['content-length']);
    if (!Number.isSafeInteger(expectedBytes)) throw new RangeError('Content-Length is too large');
    if (typeof body !== 'function' && expectedBytes !== (body?.byteLength || 0)) throw new TypeError('Content-Length does not match the request body');
  }
  if (typeof body === 'function' && expectedBytes === undefined) headers['transfer-encoding'] = 'chunked';

  const loader = new EventEmitter();
  let done = false;
  let request;
  let response;
  let decoded;
  let sequence = 0;
  let redirects = 0;
  let authAttempts = 0;
  let uploaded = 0;
  let downloaded = 0;
  let pendingAuthDispose;
  const pendingWrites = new Set();

  function clearAuth() {
    const dispose = pendingAuthDispose;
    pendingAuthDispose = undefined;
    dispose?.();
  }
  function settleWrites(error) {
    for (const settle of [...pendingWrites]) settle(error);
  }
  function cleanup(error, completed = false) {
    if (done) return false;
    done = true;
    sequence++;
    clearAuth();
    settleWrites(error || new Error('Network request has ended'));
    // A completed response may already have returned its socket to the agent.
    // Destroy only cancellation/failure or an early response to an open upload.
    if (!completed || !request?.writableFinished) {
      decoded?.destroy();
      response?.destroy();
      request?.destroy();
    }
    request = response = decoded = undefined;
    context.untrack?.(loader);
    return true;
  }
  function fail(error) {
    if (cleanup(error)) loader.emit('error', {}, error.message || String(error));
  }
  loader.cancel = () => { cleanup(Object.assign(new Error('Network request was aborted'), { code: 'ABORT_ERR' })); };
  context.track?.(loader);

  function deliver(incoming, serial) {
    if (done || serial !== sequence) { incoming.destroy(); return; }
    response = incoming;
    incoming.on('aborted', () => { if (serial === sequence) fail(new Error('Response was aborted before completion')); });
    incoming.on('error', (error) => { if (serial === sequence) fail(error); });
    const status = incoming.statusCode;
    const location = incoming.headers.location;
    if (REDIRECTS.has(status) && location) {
      if (redirects++ >= 20) return fail(new Error('net::ERR_TOO_MANY_REDIRECTS'));
      let target;
      try { target = new URL(location, currentURL); } catch { return fail(new Error('Invalid redirect URL')); }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return fail(new Error('net::ERR_UNSAFE_REDIRECT'));
      const newMethod = (status === 303 && method !== 'GET' && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST') ? 'GET' : method;
      loader.emit('redirect', {}, { statusCode: status, newMethod, newUrl: target.href }, responseHead(incoming).headers);
      if (done) return;
      if (typeof body === 'function' && newMethod === method) return fail(unsupported('Streaming uploads cannot be replayed across redirects'));
      if (newMethod !== method) {
        body = null;
        expectedBytes = undefined;
        delete headers['content-length']; delete headers['content-type']; delete headers['transfer-encoding'];
      }
      if (target.origin !== currentURL.origin) {
        delete headers.authorization; delete headers.cookie; delete headers['proxy-authorization']; delete headers.host;
      }
      if (currentURL.protocol === 'https:' && target.protocol === 'http:') delete headers.referer;
      method = newMethod;
      currentURL = target;
      restart();
      return;
    }

    const challenge = String(incoming.headers['www-authenticate'] || '');
    if (status === 401 && /^Basic(?:\s|$)/i.test(challenge) && authAttempts < 2 && options.credentials !== 'omit') {
      authAttempts++;
      let answered = false;
      const authInfo = {
        isProxy: false, scheme: 'basic', host: currentURL.hostname,
        port: Number(currentURL.port || (currentURL.protocol === 'https:' ? 443 : 80)),
        realm: /realm="([^"\\]*(?:\\.[^"\\]*)*)"/i.exec(challenge)?.[1] || '',
      };
      const respond = (username, password) => {
        if (answered || done || serial !== sequence) return;
        answered = true;
        clearAuth();
        if (username == null || password == null) { streamResponse(incoming, serial); return; }
        if (typeof username !== 'string' || typeof password !== 'string' || username.includes(':') || username.length + password.length > 8192) return fail(new TypeError('Invalid Basic authentication credentials'));
        if (typeof body === 'function') return fail(unsupported('Streaming uploads cannot be replayed for authentication'));
        headers.authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
        restart();
      };
      if (context.onAuthRequired) {
        try {
          const dispose = context.onAuthRequired({
            url: currentURL.href, isRequestForNavigation: false, isMainFrame: false,
            firstAuthAttempt: authAttempts === 1, responseHeaders: responseHead(incoming).headers,
          }, authInfo, respond);
          if (typeof dispose === 'function') {
            // The main-process handler may answer or cancel synchronously.
            if (answered || done || serial !== sequence) dispose();
            else pendingAuthDispose = dispose;
          }
        } catch (error) { fail(error); }
      } else {
        loader.emit('login', {}, authInfo, respond);
      }
      return;
    }
    streamResponse(incoming, serial);
  }

  function restart() {
    sequence++;
    request?.destroy(); response?.destroy(); decoded?.destroy();
    request = response = decoded = undefined;
    start();
  }

  function streamResponse(incoming, serial) {
    if (done || serial !== sequence) return;
    const encoding = String(incoming.headers['content-encoding'] || '').trim().toLowerCase();
    const hasBody = method !== 'HEAD' && ![204, 205, 304].includes(incoming.statusCode);
    if (hasBody && ['gzip', 'deflate', 'br'].includes(encoding)) {
      decoded = encoding === 'br' ? zlib.createBrotliDecompress() : zlib.createUnzip();
      decoded.on('error', (error) => { if (serial === sequence) fail(error); });
      incoming.pipe(decoded);
    } else if (hasBody && encoding && encoding !== 'identity') {
      return fail(unsupported(`Unsupported response content encoding: ${encoding}`));
    } else {
      decoded = incoming;
    }
    const stream = decoded;
    stream.pause();
    loader.emit('response-started', {}, currentURL.href, responseHead(incoming));
    if (done) return;
    stream.on('data', (chunk) => {
      if (done || serial !== sequence) return;
      stream.pause();
      downloaded += chunk.byteLength;
      let resumed = false;
      loader.emit('download-progress', {}, downloaded);
      if (done || serial !== sequence) return;
      loader.emit('data', {}, chunk, () => {
        if (resumed || done || serial !== sequence) return;
        resumed = true;
        stream.resume();
      });
    });
    stream.once('end', () => {
      if (serial === sequence && cleanup(undefined, true)) loader.emit('complete', {});
    });
    stream.resume();
  }

  function start() {
    if (done) return;
    const serial = ++sequence;
    try {
      const transport = currentURL.protocol === 'https:' ? https : http;
      request = transport.request(currentURL, {
        method, headers, agent: context.agentFor?.(currentURL.protocol) || agents[currentURL.protocol],
        rejectUnauthorized: true, maxHeaderSize: 64 * 1024,
      }, (incoming) => deliver(incoming, serial));
      const outgoing = request;
      outgoing.on('error', (error) => { if (serial === sequence) fail(error); });
      outgoing.on('upgrade', (_incoming, socket) => {
        socket.destroy();
        if (serial === sequence) fail(unsupported('HTTP upgrade requires net.WebSocket'));
      });
      if (typeof body === 'function') {
        let bodyEnded = false;
        let acceptedBytes = 0;
        body({
          write(chunk) {
            return new Promise((resolve, reject) => {
              if (done || serial !== sequence || bodyEnded) return reject(new Error('Network upload is no longer writable'));
              const rejectUpload = (error) => { reject(error); fail(error); };
              if (!ArrayBuffer.isView(chunk)) return rejectUpload(new TypeError('Network upload chunks must be byte buffers'));
              if (chunk.byteLength > MAX_BODY) return rejectUpload(new RangeError('Network upload chunk exceeds 64 MiB'));
              if (expectedBytes !== undefined && acceptedBytes + chunk.byteLength > expectedBytes) {
                const error = new TypeError('Content-Length does not match the streaming request body');
                reject(error);
                fail(error);
                return;
              }
              acceptedBytes += chunk.byteLength;
              let settled = false;
              const settle = (error) => {
                if (settled) return;
                settled = true;
                pendingWrites.delete(settle);
                if (error) {
                  reject(error);
                  if (serial === sequence) fail(error);
                }
                else {
                  uploaded += chunk.byteLength;
                  loader.emit('upload-progress', {}, uploaded, 0);
                  resolve();
                }
              };
              pendingWrites.add(settle);
              try { outgoing.write(chunk, settle); } catch (error) { settle(error); }
            });
          },
          done() {
            if (done || serial !== sequence || bodyEnded) return;
            bodyEnded = true;
            if (expectedBytes !== undefined && acceptedBytes !== expectedBytes) {
              fail(new TypeError('Content-Length does not match the streaming request body'));
              return;
            }
            outgoing.end();
          },
        });
      } else {
        outgoing.end(body || undefined, () => {
          if (!done && serial === sequence && body) {
            uploaded = body.byteLength;
            loader.emit('upload-progress', {}, uploaded, uploaded);
          }
        });
      }
    } catch (error) { fail(error); }
  }
  setImmediate(start);
  return loader;
}

module.exports = { createURLLoader };

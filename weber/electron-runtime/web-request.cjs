// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const http = require('node:http');

let nextId = 0;
const resourceTypes = new Set(['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other']);
const glob = value => new RegExp(`^${value.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
function pattern(value) {
  // Electron uses SCHEME_ALL, including application-registered schemes.
  if (value === '<all_urls>') return () => true;
  if (typeof value !== 'string' || value.length > 4096) throw new TypeError('Invalid webRequest URL pattern');
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/.exec(value);
  if (!match) throw new TypeError('Invalid webRequest URL pattern');
  const [, scheme, host, pathname] = match;
  const hostParts = /^(\[[0-9a-fA-F:]+\]|[^:]*)(?::(\*|\d+))?$/.exec(host);
  if (!hostParts) throw new TypeError('Invalid webRequest host pattern');
  const hostname = hostParts[1].toLowerCase(), port = hostParts[2];
  if (hostname.includes('@') || /[\s?#]/.test(hostname) || (hostname.includes('*') && hostname !== '*' && !/^\*\.[^*]+$/.test(hostname)) || (port && port !== '*' && Number(port) > 65535)) throw new TypeError('Invalid webRequest host pattern');
  const pathMatch = glob(pathname);
  return url => (scheme === '*' ? ['http:', 'https:'].includes(url.protocol) : url.protocol === `${scheme}:`) &&
    (hostname === '*' || (hostname.startsWith('*.') ? url.hostname === hostname.slice(2) || url.hostname.endsWith(hostname.slice(1)) : url.hostname === hostname)) &&
    (!port || port === '*' || (url.port || ({ 'http:':'80', 'https:':'443', 'ws:':'80', 'wss:':'443', 'ftp:':'21' })[url.protocol]) === port) &&
    pathMatch.test(url.pathname + url.search);
}
function filterMatch(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('Invalid webRequest filter');
  for (const key of Object.keys(filter)) if (!['urls', 'types'].includes(key)) throw new TypeError(`Unsupported webRequest filter: ${key}`);
  const { urls = ['<all_urls>'], types } = filter;
  if (!Array.isArray(urls) || urls.length > 256) throw new TypeError('Invalid webRequest URL filters');
  if (types !== undefined && (!Array.isArray(types) || types.some(type => !resourceTypes.has(type)))) throw new TypeError('Invalid webRequest resource types');
  const patterns = (urls.length ? urls : ['<all_urls>']).map(pattern);
  return details => (!types?.length || types.includes(details.resourceType)) && patterns.some(matches => matches(new URL(details.url)));
}
function responseHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid responseHeaders');
  const result = Object.create(null);
  let bytes = 0;
  for (const [name, values] of Object.entries(value)) {
    http.validateHeaderName(name);
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new TypeError('responseHeaders values must be string arrays');
    for (const value of values) { http.validateHeaderValue(name, value); bytes += Buffer.byteLength(name) + Buffer.byteLength(value); }
    if (bytes > 64 * 1024) throw new RangeError('Response headers exceed 64 KiB');
    (result[name.toLowerCase()] ||= []).push(...values);
  }
  return result;
}
class WebRequest {
  constructor({ timeoutMs = 10000 } = {}) { this.listeners = new Map(); this.timeoutMs = timeoutMs; }
  _register(name, filter, listener) {
    if (arguments.length === 2) { listener = filter; filter = {}; }
    if (listener !== null && typeof listener !== 'function') throw new TypeError('webRequest listener must be a function or null');
    const matches = filterMatch(filter);
    if (listener === null) this.listeners.delete(name);
    else this.listeners.set(name, { matches, listener });
  }
  onBeforeRequest(...args) { this._register('onBeforeRequest', ...args); }
  onHeadersReceived(...args) { this._register('onHeadersReceived', ...args); }
  async _dispatch(name, details, signal) {
    const entry = this.listeners.get(name);
    if (signal?.aborted) throw new Error('webRequest cancelled');
    if (!entry || !entry.matches(details)) return {};
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => done(new Error('webRequest cancelled'));
      const timer = setTimeout(() => done(new Error(`${name} listener timed out`)), this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      const callback = value => {
        if (settled) return;
        try {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid webRequest callback response');
          const allowed = name === 'onBeforeRequest' ? ['cancel', 'redirectURL'] : ['cancel', 'responseHeaders', 'statusLine'];
          if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unsupported webRequest response field');
          const result = {};
          if (value.cancel !== undefined) {
            if (typeof value.cancel !== 'boolean') throw new TypeError('cancel must be boolean');
            result.cancel = value.cancel;
          }
          if (value.redirectURL !== undefined) {
            if (typeof value.redirectURL !== 'string') throw new TypeError('redirectURL must be a URL string');
            result.redirectURL = new URL(value.redirectURL).href;
          }
          if (value.responseHeaders !== undefined) result.responseHeaders = responseHeaders(value.responseHeaders);
          if (value.statusLine !== undefined) {
            if (typeof value.statusLine !== 'string' || !/^HTTP\/\d\.\d [1-5]\d\d(?: [^\r\n]*)?$/.test(value.statusLine)) throw new TypeError('Invalid statusLine');
            result.statusLine = value.statusLine;
          }
          done(null, result);
        } catch (error) { done(error); }
      };
      try { Promise.resolve(entry.listener({ ...details, timestamp: Date.now() }, callback)).catch(error => done(error)); }
      catch (error) { done(error); }
    });
  }
}
for (const method of ['onBeforeSendHeaders', 'onSendHeaders', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) {
  WebRequest.prototype[method] = () => { throw Object.assign(new Error(`Weber has not implemented webRequest.${method}`), { code: 'ERR_WEBER_UNSUPPORTED' }); };
}
function requestDetails(values) {
  if (nextId >= Number.MAX_SAFE_INTEGER) throw new RangeError('Network request IDs exhausted');
  return { id: ++nextId, method: 'GET', webContentsId: 0, resourceType: 'other', ...values };
}
module.exports = { WebRequest, requestDetails, responseHeaders };

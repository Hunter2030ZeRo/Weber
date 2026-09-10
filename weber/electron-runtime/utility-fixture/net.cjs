// Actual Electron net wrapper inside a separate Weber utility process.
'use strict';
const assert = require('node:assert/strict');
const { net } = require('electron');

async function exercise(expectedNet = net, moduleKind = 'cjs') {
  assert.equal(process.type, 'utility');
  assert.equal(net, expectedNet);
  assert.equal(require('electron/utility').net, net);
  assert.deepEqual(Object.keys(require('electron')), ['net']);
  assert.throws(() => require('electron/main'), /Unsupported utility API/);
  assert.throws(() => require('electron/renderer'), /Unsupported utility API/);
  assert.throws(() => require('@electron/internal/browser/api/browser-window'), /Unsupported utility internal module/);
  assert.throws(() => process._linkedBinding('electron_browser_session'), /Unsupported utility native binding/);
  // Bun has no native ESM Electron facade; its bare package import is rejected
  // by the backend resolver. Node routes it through our explicit API allowlist.
  await assert.rejects(import('electron/main'), process.versions.bun ? /Cannot find package 'electron'/ : /Unsupported utility API/);
  const base = new URL(process.argv[2]);
  const request = net.request; // VS Code passes this function without its receiver.
  const read = (pathname, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = request({ protocol: base.protocol, hostname: base.hostname, port: Number(base.port),
      path: pathname, method, cache: 'no-store', headers: { 'X-Weber-Utility': moduleKind } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, data: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.removeHeader('Content-Length');
    if (body) req.write(body);
    req.end();
  });
  const gzip = await read('/gzip');
  assert.deepEqual(gzip, { status: 200, data: 'decoded utility response\n' });
  const upload = await read('/echo', 'POST', 'utility upload \u2603');
  assert.deepEqual(upload, { status: 200, data: 'utility upload \u2603' });
  const fetch = net.fetch;
  const response = await fetch(new URL('/gzip', base).href, { credentials: 'omit' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'decoded utility response\n');
  await new Promise((resolve, reject) => {
    const req = request(new URL('/abort', base).href, response => {
      response.on('error', reject);
      req.abort();
    });
    req.on('error', reject);
    req.once('abort', resolve);
    req.end();
  });
  process.parentPort.postMessage({ moduleKind, gzip: true, upload: true, fetch: true, abort: true,
    browserDenied: true, pid: process.pid });
}

module.exports = { exercise };
if (process.argv[1] === __filename) exercise().catch(error => { console.error(error.stack || error); process.exit(1); });

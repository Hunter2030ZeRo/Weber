// Real utility subprocesses and owned loopback HTTP traffic through Electron TS.
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { once, EventEmitter } = require('node:events');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
const app = new EventEmitter();
app.isReady = () => true;
const failures = [];
app.on('weber-error', error => failures.push(error));
const binding = require('./utility-binding.cjs').createUtilityBinding({ app,
  unsupported: name => { throw new Error('Unsupported ' + name); } });
const originalBinding = process._linkedBinding;
process._linkedBinding = name => name === 'electron_browser_utility_process' ? binding : originalBinding(name);
const loader = createCommonJSLoader(request => request.startsWith('@electron/internal/') ?
  { value: loader.load(path.join(__dirname, 'dist', request.slice('@electron/internal/'.length) + '.js')) } : undefined);
const utilityProcess = loader.load(path.join(__dirname, 'dist/browser/api/utility-process.js'));
process._linkedBinding = originalBinding;

for (const moduleKind of (process.versions.bun ? ['cjs'] : ['cjs', 'esm'])) test(`utility ${moduleKind} imports net, decompresses responses and aborts real traffic`,
  { timeout: 15000 }, async t => {
    const seen = [];
    let closeAborted;
    const abortedClosed = new Promise(resolve => { closeAborted = resolve; });
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, path: req.url, fixture: req.headers['x-weber-utility'] });
      if (req.url === '/gzip') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
        res.end(gzipSync('decoded utility response\n'));
      } else if (req.url === '/echo') {
        const chunks = []; req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => res.end(Buffer.concat(chunks)));
      } else if (req.url === '/abort') {
        res.on('close', closeAborted);
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('pending');
      } else { res.writeHead(404); res.end(); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const child = utilityProcess.fork(path.join(__dirname, `utility-fixture/net.${moduleKind === 'esm' ? 'mjs' : 'cjs'}`), [url], { stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(async () => {
      if (!child._unwrapHandle()) return;
      const exit = once(child, 'exit'); child._unwrapHandle().stop('SIGKILL'); await exit;
    });
    const exit = once(child, 'exit');
    let report;
    child.once('message', value => { report = value; });
    const [code] = await exit;
    assert.equal(code, 0, `utility exited ${code}\n${stderr}\n${stdout}`);
    assert.deepEqual(report && { ...report, pid: 0 }, { moduleKind, gzip: true, upload: true, fetch: true,
      abort: true, browserDenied: true, pid: 0 });
    assert.ok(report.pid > 0 && report.pid !== process.pid);
    await abortedClosed;
    assert.deepEqual(seen.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/gzip' }, { method: 'POST', path: '/echo' },
      { method: 'GET', path: '/gzip' }, { method: 'GET', path: '/abort' },
    ]);
    assert.equal(seen[0].fixture, moduleKind);
    assert.equal(seen[1].fixture, moduleKind);
    assert.deepEqual(failures, []);
  });

if (process.versions.bun) test('Bun utility Electron ESM import reports an unavailable package without claiming successful network traffic',
  { timeout: 15000 }, async t => {
    let requests = 0;
    const server = http.createServer((_req, res) => { requests++; res.end(); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const child = utilityProcess.fork(path.join(__dirname, 'utility-fixture/net.mjs'),
      [`http://127.0.0.1:${server.address().port}/`], { stdio: 'pipe' });
    let stderr = '', report;
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', value => { report = value; });
    const exit = once(child, 'exit');
    t.after(async () => { if (child._unwrapHandle()) child._unwrapHandle().stop('SIGKILL'); await exit; });
    const [code] = await exit;
    assert.equal(code, 1);
    assert.match(stderr, /Cannot find package 'electron'/);
    assert.equal(report, undefined);
    assert.equal(requests, 0);
    assert.deepEqual(failures, []);
});

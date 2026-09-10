// HTTP challenge/response with separate owned utility processes, not fake IPC.
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const http = require('node:http');
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

async function serverFor(t) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    const expected = req.url.startsWith('/local') ? ['utility-user', 'utility-password'] : ['main-user', 'main-password'];
    if (req.url === '/open' || (req.url !== '/always' && req.headers.authorization ===
        'Basic ' + Buffer.from(expected.join(':')).toString('base64'))) {
      res.end('authenticated ' + req.url);
    } else {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="utility-test"', 'X-Auth-Test': 'challenge' });
      res.end('credentials required');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/`, port: server.address().port, seen };
}

async function childFor(t, url, options = {}) {
  const child = utilityProcess.fork(path.join(__dirname, 'utility-fixture/auth.cjs'), [url],
    { stdio: 'pipe', respondToAuthRequestsFromMainProcess: true, ...options });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'exit');
  const messages = new EventEmitter();
  child.on('message', message => messages.emit(message.id || message.kind, message));
  t.after(async () => {
    if (child._unwrapHandle()) child._unwrapHandle().stop('SIGKILL');
    await exit;
    assert.equal(stderr, '');
    assert.deepEqual(failures, []);
  });
  const [ready] = await once(messages, 'ready');
  assert.equal(ready.pid, child.pid);
  function wait(id) { return once(messages, id).then(([message]) => message); }
  function request(id, pathname, extra = {}) {
    const result = wait(id); child.postMessage({ kind: 'request', id, path: pathname, ...extra }); return result;
  }
  return { child, request, wait, exit };
}

function loginFor(t, handler) {
  app.on('login', handler); t.after(() => app.off('login', handler));
}

test('utility forwards real Basic auth with Electron event details and async credentials', { timeout: 15000 }, async t => {
  const server = await serverFor(t);
  const worker = await childFor(t, server.url);
  const challenges = [];
  loginFor(t, (event, webContents, details, authInfo, callback) => {
    assert.equal(webContents, null);
    assert.equal(details.pid, worker.child.pid);
    assert.equal(details.url, server.url + 'secured');
    assert.equal(details.isRequestForNavigation, false);
    assert.equal(details.isMainFrame, false);
    assert.equal(details.firstAuthAttempt, true);
    assert.deepEqual(details.responseHeaders['x-auth-test'], ['challenge']);
    assert.deepEqual(authInfo, { isProxy: false, scheme: 'basic', host: '127.0.0.1', port: server.port, realm: 'utility-test' });
    challenges.push(details);
    event.preventDefault();
    setImmediate(() => { callback('main-user', 'main-password'); callback('wrong', 'duplicate'); });
  });
  for (const id of ['first', 'second']) {
    assert.deepEqual(await worker.request(id, '/secured'), { kind: 'result', id, status: 200, body: 'authenticated /secured', logins: 0 });
  }
  // Each new request challenges independently: no fabricated shared auth cache.
  assert.equal(challenges.length, 2);
  assert.equal(server.seen.length, 4);
  assert.equal(server.seen[0].authorization, undefined);
  assert.equal(server.seen[2].authorization, undefined);
});

test('utility auth inline credentials work without preventDefault and retries report firstAuthAttempt', { timeout: 15000 }, async t => {
  const server = await serverFor(t);
  const worker = await childFor(t, server.url);
  const attempts = [];
  loginFor(t, (_event, _contents, details, _authInfo, callback) => {
    attempts.push(details.firstAuthAttempt);
    callback(...(details.firstAuthAttempt ? ['incorrect', 'password'] : ['main-user', 'main-password']));
  });
  assert.equal((await worker.request('retry', '/secured')).status, 200);
  assert.deepEqual(attempts, [true, false]);
  assert.equal(server.seen.length, 3);
});

test('utility auth defaults to cancellation and ignores callbacks retained without preventDefault', { timeout: 15000 }, async t => {
  const server = await serverFor(t);
  const worker = await childFor(t, server.url);
  assert.equal((await worker.request('absent', '/secured')).status, 401);
  let late;
  loginFor(t, (_event, _contents, _details, _authInfo, callback) => { late = callback; });
  assert.equal((await worker.request('unhandled', '/secured')).status, 401);
  late('main-user', 'main-password');
  assert.equal((await worker.request('barrier', '/open')).status, 200);
  assert.equal(server.seen.filter(value => value.path === '/secured').length, 2);
});

test('utility auth callback cancellation returns actual 401 and bounded bad credentials terminate', { timeout: 15000 }, async t => {
  const server = await serverFor(t);
  const worker = await childFor(t, server.url);
  let challenges = 0;
  loginFor(t, (event, _contents, details, _authInfo, callback) => {
    challenges++; event.preventDefault();
    setImmediate(() => details.url.endsWith('/always') ? callback('bad', 'credentials') : callback());
  });
  assert.equal((await worker.request('cancel', '/secured')).status, 401);
  assert.equal((await worker.request('exhausted', '/always')).status, 401);
  assert.equal(challenges, 3);
  assert.equal(server.seen.length, 4);
});

test('utility auth forwarding is opt-in; omitted credentials suppress every login path', { timeout: 15000 }, async t => {
  const server = await serverFor(t);
  const worker = await childFor(t, server.url, { respondToAuthRequestsFromMainProcess: false,
    env: { ...process.env, WEBER_UTILITY_MAIN_AUTH: '1' } });
  let mainLogins = 0;
  loginFor(t, () => { mainLogins++; });
  const local = await worker.request('local', '/local', { localAuth: true });
  assert.equal(local.status, 200); assert.equal(local.logins, 1);
  const omitted = await worker.request('omit', '/local', { credentials: 'omit', localAuth: true });
  assert.equal(omitted.status, 401); assert.equal(omitted.logins, 0);
  assert.equal(mainLogins, 0);
});

test('utility auth cancellation and child exit invalidate retained callbacks', { timeout: 15000 }, async t => {
  const server = await serverFor(t);
  const worker = await childFor(t, server.url);
  let retained;
  const challenge = new EventEmitter();
  loginFor(t, (event, _contents, _details, _authInfo, callback) => {
    event.preventDefault(); retained = callback; challenge.emit('pending');
  });
  const pending = once(challenge, 'pending');
  const aborted = worker.request('abort', '/secured');
  await pending;
  worker.child.postMessage({ kind: 'abort', id: 'abort' });
  assert.deepEqual(await aborted, { kind: 'aborted', id: 'abort' });
  retained('main-user', 'main-password');
  assert.equal((await worker.request('barrier', '/open')).status, 200);
  const second = once(challenge, 'pending');
  worker.child.postMessage({ kind: 'request', id: 'kill', path: '/secured' });
  await second;
  worker.child.kill(); await worker.exit;
  assert.doesNotThrow(() => retained('main-user', 'main-password'));
  assert.equal(server.seen.filter(value => value.path === '/secured').length, 2);
});

test('utility auth callbacks are isolated across real children and invalidated by app quit', { timeout: 15000 }, async t => {
  const server = await serverFor(t);
  const first = await childFor(t, server.url);
  const second = await childFor(t, server.url);
  const retained = new Map();
  const pending = new EventEmitter();
  loginFor(t, (event, _contents, details, _authInfo, callback) => {
    event.preventDefault(); retained.set(details.pid, callback); pending.emit('pending');
  });
  const waitFirst = once(pending, 'pending');
  const firstResult = first.request('first', '/secured'); await waitFirst;
  const waitSecond = once(pending, 'pending');
  const secondResult = second.request('second', '/secured'); await waitSecond;
  retained.get(first.child.pid)('main-user', 'main-password');
  retained.get(second.child.pid)();
  assert.equal((await firstResult).status, 200);
  assert.equal((await secondResult).status, 401);
  const waitQuit = once(pending, 'pending');
  first.child.postMessage({ kind: 'request', id: 'quit', path: '/secured' }); await waitQuit;
  const late = retained.get(first.child.pid);
  app.emit('quit');
  assert.doesNotThrow(() => late('main-user', 'main-password'));
  await Promise.all([first.exit, second.exit]);
  assert.equal(server.seen.length, 4);
});

test('utility rejects session and partition instead of silently changing network context', () => {
  const entry = path.join(__dirname, 'utility-fixture/auth.cjs');
  assert.throws(() => utilityProcess.fork(entry, [], { session: {} }), /utilityProcess option session/);
  assert.throws(() => utilityProcess.fork(entry, [], { partition: '' }), /utilityProcess option partition/);
  assert.throws(() => utilityProcess.fork(entry, [], { respondToAuthRequestsFromMainProcess: 'true' }), TypeError);
});

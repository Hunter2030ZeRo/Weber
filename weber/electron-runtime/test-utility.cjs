// Actual child processes and original Electron TS wrappers; no browser needed.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { once, EventEmitter } = require('node:events');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
const app = new EventEmitter();
let ready = true;
app.isReady = () => ready;
const failures = [];
app.on('weber-error', error => { failures.push(error); console.error(error); });
const binding = require('./utility-binding.cjs').createUtilityBinding({ app, unsupported: name => { throw new Error('Unsupported ' + name); } });
const originalBinding = process._linkedBinding;
process._linkedBinding = name => name === 'electron_browser_utility_process' ? binding :
  name === 'electron_browser_message_port' ? require('./message-port-binding.cjs') : originalBinding(name);
const loader = createCommonJSLoader(request => request.startsWith('@electron/internal/') ?
  { value: loader.load(path.join(__dirname, 'dist', request.slice('@electron/internal/'.length) + '.js')) } : undefined);
const utilityProcess = loader.load(path.join(__dirname, 'dist/browser/api/utility-process.js'));
const MessageChannelMain = loader.load(path.join(__dirname, 'dist/browser/api/message-channel.js')).default;
process._linkedBinding = originalBinding;
const entry = path.join(__dirname, 'utility-fixture/child.cjs');
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Utility delivery deadline expired');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
function fork(t, filename = entry, args = [], options = {}) {
  const child = utilityProcess.fork(filename, args, { stdio: 'pipe', ...options });
  t.after(async () => {
    const handle = child._unwrapHandle();
    if (!handle) return;
    const exited = once(child, 'exit');
    handle.stop('SIGKILL');
    await exited;
  });
  return child;
}
test('original utility wrapper starts a real process with stdio, argv, cwd, environment and copied data', { timeout: 10000 }, async t => {
  const child = fork(t, entry, ['argument with spaces'], { cwd: __dirname, env: { UTILITY_FIXTURE_VALUE: 'kept' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const identity = once(child, 'message');
  child.postMessage({ kind: 'identity' }); // Queues before child listener installation.
  await once(child, 'spawn');
  t.diagnostic('utility spawned');
  assert.ok(child.pid > 0 && child.pid !== process.pid);
  assert.deepEqual((await identity)[0], { pid: child.pid, ppid: process.pid, type: 'utility',
    argv: ['argument with spaces'], cwd: __dirname, env: 'kept' });
  t.diagnostic('utility identity received');
  const data = { value: 42n, bytes: new Uint8Array([0, 128, 255]), map: new Map([['key', 'value']]) }; data.self = data;
  const echo = once(child, 'message'); child.postMessage({ kind: 'echo', data }); data.bytes[0] = 9;
  const [received] = await echo;
  t.diagnostic('structured echo received');
  assert.equal(received.self, received); assert.equal(received.value, 42n);
  assert.deepEqual(received.bytes, new Uint8Array([0, 128, 255])); assert.deepEqual(received.map, data.map);
  assert.match(stdout, /utility-stdout-ready/); assert.match(stderr, /utility-stderr-ready/);
  const exit = once(child, 'exit'); child.postMessage({ kind: 'exit', code: 23 });
  assert.equal((await exit)[0], 23); assert.equal(child.pid, undefined); assert.equal(child.kill(), false);
  t.diagnostic('utility exit received');
});
test('main port ownership moves to utility and queued structured messages cross both processes', { timeout: 10000 }, async t => {
  const child = fork(t), channel = new MessageChannelMain();
  t.after(() => channel.port1.close());
  const values = []; channel.port1.on('message', event => values.push(event.data)); channel.port1.start();
  channel.port1.postMessage('queued before transfer');
  const received = once(child, 'message'); child.postMessage({ kind: 'port' }, [channel.port2]);
  assert.throws(() => channel.port2.postMessage('detached'), /transferred/);
  assert.equal((await received)[0], 'port-received');
  await waitFor(() => values.length > 0);
  assert.equal(values[0], 'queued before transfer');
  const response = once(channel.port1, 'message'); channel.port1.postMessage(new Map([['binary', new Uint8Array([1,2,3])]]));
  assert.deepEqual((await response)[0].data, new Map([['binary', new Uint8Array([1,2,3])]]));
  const local = new MessageChannelMain(); t.after(() => local.port1.close());
  assert.throws(() => channel.port1.postMessage('nested', [local.port2]), /Nested transfers/);
  const stillOwned = once(local.port1, 'message'); local.port1.start(); local.port2.postMessage('retained');
  assert.equal((await stillOwned)[0].data, 'retained');
  const closed = once(child, 'message'); channel.port1.close(); assert.equal((await closed)[0], 'port-closed');
});
test('failed clone and oversized admission do not detach ports; ESM entry executes', { timeout: 10000 }, async t => {
  const child = fork(t, path.join(__dirname, 'utility-fixture/child.mjs'));
  const channel = new MessageChannelMain(); t.after(() => channel.port1.close());
  assert.throws(() => child.postMessage(() => {}, [channel.port2]), /clone/i);
  assert.throws(() => child.postMessage(new Uint8Array(4 * 1024 * 1024), [channel.port2]), /4 MiB/);
  const local = once(channel.port1, 'message'); channel.port1.start(); channel.port2.postMessage('still owned');
  assert.equal((await local)[0].data, 'still owned');
  const response = once(child, 'message'); child.postMessage('ES module');
  assert.deepEqual((await response)[0], { esm: true, data: 'ES module', type: 'utility' });
});
test('parent port listener removal permits natural exit without losing its final reply', { timeout: 10000 }, async t => {
  const child = fork(t); const response = once(child, 'message'), exit = once(child, 'exit');
  child.postMessage({ kind: 'natural-exit' });
  assert.equal((await response)[0], 'final-message'); assert.equal((await exit)[0], 0);
});
test('startup validation and child termination keep port lifetime and failures explicit', { timeout: 10000 }, async t => {
  ready = false; assert.throws(() => utilityProcess.fork(entry), /after app is ready/); ready = true;
  assert.throws(() => utilityProcess.fork(entry, [], { execArgv: [42] }), /execArgv/);
  const child = fork(t), channel = new MessageChannelMain(); t.after(() => channel.port1.close());
  const response = once(child, 'message'); child.postMessage({ kind: 'port' }, [channel.port2]); await response;
  const close = once(channel.port1, 'close'), exit = once(child, 'exit');
  assert.equal(child.kill(), true); await exit; await close;
  assert.deepEqual(failures, []);
});
test('serialization re-entrancy cannot transfer a closed port or reuse remote IDs', { timeout: 10000 }, async t => {
  const child = fork(t), first = new MessageChannelMain(), second = new MessageChannelMain();
  t.after(() => { first.port1.close(); second.port1.close(); });
  assert.throws(() => child.postMessage({ get close() { first.port2.close(); return true; } }, [first.port2]), /closed/i);
  const replies = []; child.on('message', value => replies.push(value));
  child.postMessage({ kind: 'echo', get data() {
    child.postMessage({ kind: 'port' }, [second.port2]);
    return 'outer';
  } });
  await waitFor(() => replies.length >= 2);
  assert.deepEqual(replies, ['port-received', 'outer']);
  const echo = once(second.port1, 'message'); second.port1.start(); second.port1.postMessage('after re-entrancy');
  assert.equal((await echo)[0].data, 'after re-entrancy');
});
test('kernel parent-death guard stops a utility even while its JS loop is blocked', { timeout: 10000 }, async t => {
  const { spawn } = require('node:child_process');
  const { createInterface } = require('node:readline');
  const parent = spawn(process.execPath, [path.join(__dirname, 'utility-fixture/abrupt-parent.cjs')], { stdio: ['ignore','pipe','inherit'] });
  const lines = createInterface({ input: parent.stdout });
  t.after(() => { parent.kill('SIGKILL'); lines.close(); });
  const [{ pid, procPid }] = (await once(lines, 'line')).map(JSON.parse);
  assert.match(procPid, /^[0-9]+$/);
  const stat = () => {
    // The mounted /proc may use an outer PID namespace. The owned child's
    // /proc/self identifies its observation path; kill still uses its local PID.
    try { const text = fs.readFileSync('/proc/' + procPid + '/stat', 'utf8'); return text.slice(text.lastIndexOf(')') + 2).split(' '); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const identity = stat(); assert.ok(identity && identity[0] !== 'Z');
  t.after(() => {
    const current = stat();
    if (current && current[19] === identity[19] && current[0] !== 'Z') process.kill(pid, 'SIGKILL');
  });
  const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
  const deadline = Date.now() + 2000;
  let current;
  while ((current = stat()) && current[0] !== 'Z' && current[19] === identity[19] && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!current || current[0] === 'Z' || current[19] !== identity[19], 'Owned utility survived parent death');
});

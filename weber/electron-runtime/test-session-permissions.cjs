// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { attachSessionPermissions, createSessionPermissionRuntime } = require('./session-permissions.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
const sourceURL = 'https://a.test/editor';

function setup(t, options = {}) {
  const calls = [];
  const replies = [];
  const app = Object.assign(new EventEmitter(), { isReady: () => true });
  const clipboard = {
    readText() { calls.push(['readText']); return 'native clipboard'; },
    writeText(value) { calls.push(['writeText', value]); },
  };
  const session = { partition: options.partition || 'persist:permission-test' };
  attachSessionPermissions(session);
  const wc = Object.assign(new EventEmitter(), {
    session, _generation: 1, _destroyed: false, _url: sourceURL,
    mainFrame: { url: sourceURL },
    getURL() { return this._url; },
    isDestroyed() { return this._destroyed; },
    async _command(command) { replies.push(command); },
  });
  const runtime = createSessionPermissionRuntime({ app, clipboard, timeoutMs: options.timeoutMs || 100 });
  t.after(() => app.emit('quit'));
  let nextId = 0;
  const event = (action, args = [], fields = {}) => ({
    type: 'browser-operation', id: String(++nextId), generation: 1,
    sourceURL, action, args, ...fields,
  });
  const dispatch = (action, args, fields) => runtime.dispatch(wc, event(action, args, fields));
  return { app, clipboard, calls, replies, session, wc, runtime, event, dispatch };
}

function reply(setup, index = -1) {
  const command = setup.replies.at(index);
  assert.ok(command, 'the original document receives a reply');
  assert.equal(command.method, 'resolveBrowserOperation');
  const value = command;
  assert.equal(value.generation, 1);
  assert.equal(typeof value.id, 'string');
  return value;
}

function denied(setup, index = -1) {
  const value = reply(setup, index);
  assert.equal(value.ok, false);
  assert.equal(value.errorName, 'NotAllowedError');
  assert.equal(typeof value.error, 'string');
}

test('unconfigured sessions deny native browser operations without touching the clipboard', async t => {
  const s = setup(t);
  for (const [action, args] of [
    ['clipboard-read', []], ['clipboard-write', ['blocked']], ['geolocation', []],
    ['media', [{ audio: true, video: false }]], ['display-media', [{ audio: false, video: true }]],
  ]) {
    await s.dispatch(action, args);
    denied(s);
  }
  assert.deepEqual(s.calls, []);
});

test('permission checks grant clipboard operations and receive the requesting origin', async t => {
  const s = setup(t);
  const checks = [];
  s.session.setPermissionCheckHandler((wc, permission, origin, details) => {
    checks.push({ wc, permission, origin, details });
    return true;
  });
  await s.dispatch('clipboard-read');
  assert.equal(reply(s).ok, true);
  assert.equal(reply(s).value, 'native clipboard');
  await s.dispatch('clipboard-write', ['Weber\n한글']);
  assert.equal(reply(s).ok, true);
  assert.deepEqual(s.calls, [['readText'], ['writeText', 'Weber\n한글']]);
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map(check => check.permission), ['clipboard-read', 'clipboard-sanitized-write']);
  for (const check of checks) {
    assert.equal(check.wc, s.wc);
    assert.equal(check.origin, 'https://a.test');
    assert.equal(check.details.requestingUrl, sourceURL);
  }
});

test('a rejected check can be granted by the request handler once', async t => {
  const s = setup(t);
  let requestCount = 0;
  s.session.setPermissionCheckHandler(() => false);
  s.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    requestCount++;
    assert.equal(wc, s.wc);
    assert.equal(permission, 'clipboard-read');
    assert.equal(details.requestingUrl, sourceURL);
    callback(true);
    callback(false);
    callback(true);
  });
  await s.dispatch('clipboard-read');
  assert.equal(requestCount, 1);
  assert.equal(s.replies.length, 1);
  assert.equal(reply(s).ok, true);
  assert.deepEqual(s.calls, [['readText']]);
});

test('a successful check does not invoke the request handler', async t => {
  const s = setup(t);
  let requested = false;
  s.session.setPermissionCheckHandler(() => true);
  s.session.setPermissionRequestHandler(() => { requested = true; });
  await s.dispatch('clipboard-read');
  assert.equal(requested, false);
  assert.equal(reply(s).ok, true);
});

test('session partitions do not inherit permission handlers', async t => {
  const permitted = setup(t, { partition: 'persist:permitted' });
  const isolated = setup(t, { partition: 'persist:isolated' });
  permitted.session.setPermissionCheckHandler(() => true);
  await permitted.dispatch('clipboard-read');
  await isolated.dispatch('clipboard-read');
  assert.equal(reply(permitted).ok, true);
  denied(isolated);
  assert.deepEqual(isolated.calls, []);
});

test('removing permission handlers restores default denial', async t => {
  const s = setup(t);
  s.session.setPermissionCheckHandler(() => true);
  s.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  s.session.setPermissionCheckHandler(null);
  s.session.setPermissionRequestHandler(null);
  await s.dispatch('clipboard-read');
  denied(s);
  assert.deepEqual(s.calls, []);
});

test('handlers reject nonfunctions without changing an existing grant', async t => {
  const s = setup(t);
  s.session.setPermissionCheckHandler(() => true);
  for (const method of ['setPermissionCheckHandler', 'setPermissionRequestHandler', '_setDisplayMediaRequestHandler']) {
    for (const invalid of [true, 1, {}, 'allow']) assert.throws(() => s.session[method](invalid), TypeError);
  }
  await s.dispatch('clipboard-read');
  assert.equal(reply(s).ok, true);
});

test('a permission callback first denying cannot be overwritten by a later grant', async t => {
  const s = setup(t);
  s.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
    callback(true);
  });
  await s.dispatch('clipboard-write', ['blocked']);
  denied(s);
  assert.equal(s.replies.length, 1);
  assert.deepEqual(s.calls, []);
});

test('throwing and nonboolean permission handlers fail closed', async t => {
  for (const [name, handler] of [
    ['check throws', () => { throw new Error('policy failed'); }],
    ['check is truthy', () => 'yes'],
    ['check is async', async () => true],
    ['request throws', () => { throw new Error('policy failed'); }],
    ['request is truthy', (_wc, _permission, callback) => callback('yes')],
    ['request is numeric', (_wc, _permission, callback) => callback(1)],
  ]) await t.test(name, async t => {
    const s = setup(t);
    s.session[name.startsWith('check') ? 'setPermissionCheckHandler' : 'setPermissionRequestHandler'](handler);
    await s.dispatch('clipboard-write', ['blocked']);
    denied(s);
    assert.deepEqual(s.calls, []);
  });
});

test('an unanswered request times out and a late callback cannot access the clipboard', async t => {
  const s = setup(t, { timeoutMs: 10 });
  let callback;
  s.session.setPermissionRequestHandler((_wc, _permission, done) => { callback = done; });
  // Keep the event loop alive even when the permission deadline uses an unref timer.
  await Promise.all([s.dispatch('clipboard-read'), delay(25)]);
  denied(s);
  callback(true);
  await turn();
  assert.equal(s.replies.length, 1);
  assert.deepEqual(s.calls, []);
});

test('stale generations are discarded before any permission callback or native access', async t => {
  const s = setup(t);
  let checks = 0;
  s.session.setPermissionCheckHandler(() => { checks++; return true; });
  s.wc._generation = 2;
  await s.dispatch('clipboard-write', ['stale']);
  assert.equal(checks, 0);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.replies, []);
});

test('pending grants cannot cross navigation, destruction, or session replacement', async t => {
  for (const [name, invalidate] of [
    ['new generation', s => { s.wc._generation++; }],
    ['new URL', s => { s.wc._url = 'https://a.test/next'; }],
    ['destroyed', s => { s.wc._destroyed = true; }],
    ['new session', s => { s.wc.session = {}; attachSessionPermissions(s.wc.session); }],
  ]) await t.test(name, async t => {
    const s = setup(t);
    let callback;
    s.session.setPermissionRequestHandler((_wc, _permission, done) => { callback = done; });
    const pending = s.dispatch('clipboard-write', ['stale']);
    await turn();
    assert.equal(typeof callback, 'function');
    invalidate(s);
    callback(true);
    await pending;
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.replies, []);
  });
});

test('permission checks cannot synchronously replace the document and still grant access', async t => {
  const s = setup(t);
  s.session.setPermissionCheckHandler(() => {
    s.wc._generation++;
    return true;
  });
  await s.dispatch('clipboard-read');
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.replies, []);
});

test('invalid browser operations never reach native clipboard or permission handlers', async t => {
  const s = setup(t);
  let checks = 0;
  s.session.setPermissionCheckHandler(() => { checks++; return true; });
  const invalid = [
    ['clipboard-read', [], { sourceURL: 'not a URL' }],
    ['clipboard-read', [], { sourceURL: 'https://other.test/editor' }],
    ['clipboard-write', [], {}],
    ['clipboard-write', [1], {}],
    ['clipboard-write', ['text', 'unexpected'], {}],
    ['clipboard-read', ['unexpected'], {}],
    ['clipboard-write', null, {}],
    ['unknown-operation', [], {}],
    ['permission-query', [{}], {}],
    ['permission-query', [{ name: 'unrecognized' }], {}],
    ['media', [true], {}],
    ['display-media', ['screen'], {}],
  ];
  for (const [action, args, fields] of invalid) {
    const oldReplies = s.replies.length;
    await s.dispatch(action, args, fields);
    assert.equal(s.calls.length, 0, action);
    // Invalid provenance may be discarded; valid-document errors must never grant.
    for (const command of s.replies.slice(oldReplies)) assert.equal(command.ok, false);
  }
  assert.equal(checks, 0);
});

test('permission queries consult checks without prompting or exercising native capabilities', async t => {
  const s = setup(t);
  let requests = 0;
  s.session.setPermissionRequestHandler(() => { requests++; });
  await s.dispatch('permission-query', [{ name: 'clipboard-read' }]);
  assert.equal(reply(s).ok, true);
  assert.deepEqual(reply(s).value, { state: 'prompt' });
  s.session.setPermissionCheckHandler(() => true);
  for (const name of ['clipboard-read', 'clipboard-write']) {
    await s.dispatch('permission-query', [{ name }]);
    assert.equal(reply(s).ok, true);
    assert.deepEqual(reply(s).value, { state: 'granted' });
  }
  await s.dispatch('permission-query', [{ name: 'geolocation' }]);
  assert.deepEqual(reply(s).value, { state: 'denied' });
  assert.equal(requests, 0);
  assert.deepEqual(s.calls, []);
});

test('notification permission cannot claim native notification support after a policy grant', async t => {
  const s = setup(t);
  await s.dispatch('notification-permission');
  denied(s);
  s.session.setPermissionRequestHandler((_wc, permission, callback) => {
    assert.equal(permission, 'notifications');
    callback(true);
  });
  await s.dispatch('notification-permission');
  assert.equal(reply(s).ok, true);
  assert.equal(reply(s).value, 'denied');
  assert.deepEqual(s.calls, []);
});

test('granted geolocation and media requests report unsupported capabilities honestly', async t => {
  const s = setup(t);
  s.session.setPermissionCheckHandler(() => true);
  for (const [action, args] of [
    ['geolocation', []], ['media', [{ audio: true, video: false }]],
  ]) {
    await s.dispatch(action, args);
    const value = reply(s);
    assert.equal(value.ok, false);
    assert.equal(value.errorName, 'NotSupportedError');
    assert.equal(typeof value.error, 'string');
  }
  assert.deepEqual(s.calls, []);
});

test('a selected display source cannot pretend to be a functioning media stream', async t => {
  const s = setup(t);
  let requests = 0;
  s.session.setPermissionCheckHandler(() => true);
  s.session._setDisplayMediaRequestHandler((request, callback) => {
    requests++;
    assert.equal(request.frame, s.wc.mainFrame);
    callback({ video: { id: 'screen:0:0', name: 'Screen' } });
  });
  await s.dispatch('display-media', [{ audio: false, video: true }]);
  assert.equal(requests, 1);
  assert.equal(reply(s).ok, false);
  assert.equal(reply(s).errorName, 'NotSupportedError');
  assert.deepEqual(s.calls, []);
});

test('native clipboard failures are returned once without fabricating empty success', async t => {
  const s = setup(t);
  s.session.setPermissionCheckHandler(() => true);
  s.clipboard.readText = () => { s.calls.push(['readText']); throw new Error('clipboard unavailable'); };
  await s.dispatch('clipboard-read');
  assert.equal(s.replies.length, 1);
  assert.equal(reply(s).ok, false);
  assert.match(reply(s).error, /clipboard unavailable/);
  assert.deepEqual(s.calls, [['readText']]);
});

test('navigation, destruction, policy reset, and app quit promptly cancel pending callbacks', async t => {
  for (const action of ['navigation', 'destroyed', 'policy', 'quit']) await t.test(action, async t => {
    const s = setup(t, { timeoutMs: 60000 });
    let callback;
    s.session.setPermissionRequestHandler((_, __, done) => { callback = done; });
    const pending = s.dispatch('clipboard-write', ['must not escape']);
    await turn();
    assert.equal(s.wc.listenerCount('destroyed'), 1);
    assert.equal(s.wc.listenerCount('did-start-navigation'), 1);
    if (action === 'navigation') { s.wc._generation++; s.wc.emit('did-start-navigation'); }
    else if (action === 'destroyed') { s.wc._destroyed = true; s.wc.emit('destroyed'); }
    else if (action === 'policy') s.session.setPermissionRequestHandler(null);
    else s.app.emit('quit');
    await Promise.race([pending, delay(250).then(() => { throw new Error('Permission cancellation waited for its 60 second deadline'); })]);
    callback(true);
    await turn();
    assert.deepEqual(s.calls, []);
    assert.equal(s.wc.listenerCount('destroyed'), 0);
    assert.equal(s.wc.listenerCount('did-start-navigation'), 0);
    if (action === 'policy') denied(s);
    else assert.deepEqual(s.replies, []);
  });
});

test('concurrent permission prompts share and remove their lifecycle listeners', async t => {
  const s = setup(t);
  const callbacks = [];
  s.session.setPermissionRequestHandler((_, __, callback) => callbacks.push(callback));
  const pending = Array.from({ length: 20 }, () => s.dispatch('clipboard-read'));
  await turn();
  assert.equal(s.wc.listenerCount('destroyed'), 1);
  for (const callback of callbacks) callback(false);
  await Promise.all(pending);
  assert.equal(s.wc.listenerCount('destroyed'), 0);
  assert.equal(s.wc.listenerCount('did-start-navigation'), 0);
});

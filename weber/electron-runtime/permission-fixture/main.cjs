// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard } = require('electron');

const checked = [];
let completed = false;
const deadline = setTimeout(() => finish(new Error('Native browser permission verification timed out')), 60000);
function finish(error) {
  if (completed) return;
  completed = true;
  clearTimeout(deadline);
  const report = { kind: 'browser-permission-acceptance', ok: !error,
    backend: process.versions.bun ? 'bun' : 'node', checked, error: error?.stack };
  if (process.env.WEBER_PERMISSION_RESULT) fs.writeFileSync(process.env.WEBER_PERMISSION_RESULT, JSON.stringify(report, null, 2));
  console[error ? 'error' : 'log'](JSON.stringify(report));
  app.exit(error ? 1 : 0);
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
app.on('weber-error', finish);
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const createWindow = partition => new BrowserWindow({ width: 480, height: 320,
    title: `Weber permission ${partition}`,
    webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const first = createWindow('persist:permission-allowed');
  const isolated = createWindow('persist:permission-isolated');
  const page = path.join(__dirname, 'index.html');
  await Promise.all([first.loadFile(page), isolated.loadFile(page)]);
  const evaluate = source => first.webContents.executeJavaScript(source);
  const rejectName = source => evaluate(`(${source}).then(() => 'unexpected success', error => error.name)`);
  const session = first.webContents.session;
  assert.notEqual(session, isolated.webContents.session);

  assert.deepEqual(await evaluate(`[
    typeof require, typeof ipcRenderer, typeof dispatch,
    typeof browserOperation, typeof resolveBrowserOperation
  ]`), Array(5).fill('undefined'));
  checked.push('ordinary renderer has no IPC or private dispatcher');

  clipboard.writeText('main native clipboard 한글🙂');
  assert.equal(clipboard.readText(), 'main native clipboard 한글🙂');
  assert.equal(await rejectName('navigator.clipboard.readText()'), 'NotAllowedError');
  assert.equal(await rejectName("navigator.clipboard.writeText('blocked write')"), 'NotAllowedError');
  assert.equal(clipboard.readText(), 'main native clipboard 한글🙂');
  checked.push('default browser denial preserves real native clipboard');

  const checks = [];
  session.setPermissionCheckHandler((wc, permission, origin, details) => {
    assert.equal(wc, first.webContents);
    assert.equal(origin, 'null'); // file:// document origin.
    assert.equal(details.requestingUrl, first.webContents.getURL());
    assert.equal(details.isMainFrame, true);
    checks.push(permission);
    return permission === 'clipboard-read' || permission === 'clipboard-sanitized-write';
  });
  assert.equal(await evaluate('navigator.clipboard.readText()'), 'main native clipboard 한글🙂');
  await evaluate("navigator.clipboard.writeText('renderer native clipboard 한글🙂').then(() => true)");
  assert.equal(clipboard.readText(), 'renderer native clipboard 한글🙂');
  assert.deepEqual(await evaluate(`Promise.all([
    navigator.permissions.query({ name: 'clipboard-read' }).then(value => value.state),
    navigator.permissions.query({ name: 'clipboard-write' }).then(value => value.state),
    navigator.permissions.query({ name: 'geolocation' }).then(value => value.state)
  ])`), ['granted', 'granted', 'denied']);
  assert.ok(checks.includes('clipboard-read'));
  assert.ok(checks.includes('clipboard-sanitized-write'));
  assert.equal(await isolated.webContents.executeJavaScript(
    "navigator.clipboard.readText().then(() => 'unexpected success', error => error.name)"), 'NotAllowedError');
  checked.push('permission checks grant real native read/write and remain session scoped');

  let requests = 0;
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((wc, permission, callback) => {
    assert.equal(wc, first.webContents);
    assert.equal(permission, 'clipboard-read');
    requests++;
    setImmediate(() => { callback(true); callback(false); callback(true); });
  });
  assert.equal(await evaluate('navigator.clipboard.readText()'), 'renderer native clipboard 한글🙂');
  assert.equal(requests, 1);
  checked.push('asynchronous request grants settle once');

  let permissionCallback;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    assert.equal(permission, 'clipboard-sanitized-write');
    permissionCallback = callback;
    requestStarted();
  });
  clipboard.writeText('navigation must preserve this');
  // Do not retain an executeJavaScript promise owned by the departing document.
  assert.equal(await evaluate("navigator.clipboard.writeText('stale write').catch(() => {}); true"), true);
  await started;
  await first.loadFile(page);
  permissionCallback(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await evaluate("document.getElementById('status').textContent"), 'Native browser permission acceptance fixture');
  assert.equal(clipboard.readText(), 'navigation must preserve this');
  checked.push('navigation discards pending grants without stale native writes');

  session.setPermissionCheckHandler(null);
  session.setPermissionRequestHandler(null);
  assert.equal(await rejectName('navigator.clipboard.readText()'), 'NotAllowedError');
  assert.deepEqual(await evaluate(`new Promise(resolve => navigator.geolocation.getCurrentPosition(
    () => resolve(['unexpected success']), error => resolve([error.code, error.PERMISSION_DENIED])
  ))`), [1, 1]);
  checked.push('handler removal restores denial and geolocation cannot return spoofed coordinates');

  session.setPermissionCheckHandler(() => true);
  assert.equal(await rejectName('navigator.mediaDevices.getUserMedia({ audio: true })'), 'NotSupportedError');
  assert.deepEqual(await evaluate(`new Promise(resolve => navigator.geolocation.getCurrentPosition(
    () => resolve(['unexpected success']), error => resolve([error.code, error.POSITION_UNAVAILABLE])
  ))`), [2, 2]);
  let displayRequests = 0;
  session.setDisplayMediaRequestHandler((request, callback) => {
    assert.equal(request.frame, first.webContents.mainFrame);
    assert.equal(request.videoRequested, true);
    assert.equal(request.audioRequested, false);
    displayRequests++;
    callback({ video: { id: 'screen:0:0', name: 'selected screen' } });
  });
  assert.equal(await rejectName('navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })'), 'NotSupportedError');
  assert.equal(displayRequests, 1);
  assert.equal(await evaluate('Notification.requestPermission()'), 'denied');
  checked.push('grants do not fabricate unsupported media, display, geolocation, or notification delivery');

  finish();
}).catch(finish);

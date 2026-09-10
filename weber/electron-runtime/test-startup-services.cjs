// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
const { createDiagnosticsBinding } = require('./diagnostics-binding.cjs');
const { attachStartupOptions } = require('./startup-options.cjs');
const unsupported = value => { throw new Error('Unsupported: ' + value); };

function original() {
  const bindings = createDiagnosticsBinding({ unsupported });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_crash_reporter' ? bindings.crashReporter :
    name === 'electron_browser_content_tracing' ? bindings.tracing : saved(name);
  const api = { app: { name: 'Service test', getVersion: () => '1.2.3' } };
  const loader = createCommonJSLoader(request => request === 'electron/main' ? { value: api } :
    request.startsWith('@electron/internal/') ? { value: loader.load(path.join(__dirname, 'dist', request.slice(19) + '.js')) } : undefined);
  try { return { crash: loader.load(path.join(__dirname, 'dist/browser/api/crash-reporter.js')).default,
    trace: loader.load(path.join(__dirname, 'dist/browser/api/content-tracing.js')).default }; }
  finally { process._linkedBinding = saved; }
}

test('original crash reporter preserves inactive metadata without claiming crash capture or uploads', () => {
  const { crash } = original();
  assert.deepEqual(crash.getUploadedReports(), []); assert.equal(crash.getLastCrashReport(), null);
  crash.addExtraParameter('workspace', 'example');
  const first = crash.getParameters(); first.workspace = 'changed';
  assert.equal(crash.getParameters().workspace, 'example');
  crash.addExtraParameter('__proto__', 'ordinary parameter');
  assert.equal(Object.getPrototypeOf(crash.getParameters()), Object.prototype);
  assert.throws(() => crash.addExtraParameter('oversize', 'x'.repeat(21 * 1024)), /limit/);
  assert.throws(() => crash.start(), /submitURL/);
  assert.throws(() => crash.start({ uploadToServer: false }), /native crash collection/);
  assert.equal(crash.getParameters().workspace, 'example');
  crash.removeExtraParameter('workspace'); assert.equal(crash.getParameters().workspace, undefined);
});

test('original contentTracing writes real main-process marks and measures, and reports its scope', async t => {
  const { trace } = original();
  if (process.versions.bun) {
    assert.deepEqual(await trace.getCategories(), []);
    await assert.rejects(trace.startRecording({}), /on Bun/); return;
  }
  assert.deepEqual(await trace.getCategories(), ['weber.main.user_timing']);
  await assert.rejects(trace.startRecording({ included_categories: ['gpu'] }), /categories/);
  await trace.startRecording({ included_categories: ['weber.main.user_timing'] });
  await assert.rejects(trace.startRecording({}), /already active/);
  performance.mark('weber-test-start'); performance.mark('weber-test-end');
  performance.measure('weber-test-duration', 'weber-test-start', 'weber-test-end');
  const output = await trace.stopRecording();
  t.after(() => fs.rm(path.dirname(output), { recursive: true, force: true }));
  const data = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(data.metadata.includesRenderers, false);
  assert.ok(data.traceEvents.some(event => event.name === 'weber-test-start' && event.ph === 'i'));
  assert.ok(data.traceEvents.some(event => event.name === 'weber-test-duration' && event.ph === 'X' && event.dur >= 0));
  await assert.rejects(trace.stopRecording(), /not active/);
  performance.clearMarks('weber-test-start'); performance.clearMarks('weber-test-end'); performance.clearMeasures('weber-test-duration');
});

test('main trace is bounded, drains pending entries and can restart after an output failure', { skip: !!process.versions.bun }, async t => {
  const { trace } = original();
  await trace.startRecording({});
  for (let n = 0; n < 4200; n++) performance.mark('weber-bounded');
  const output = await trace.stopRecording();
  t.after(() => fs.rm(path.dirname(output), { recursive: true, force: true }));
  const data = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(data.traceEvents.length, 4097); assert.equal(data.metadata.droppedEvents, 104);
  performance.clearMarks('weber-bounded');
  await trace.startRecording({});
  await assert.rejects(trace.stopRecording(path.join(output, 'missing')), /ENOTDIR/);
  await trace.startRecording({});
  const restarted = await trace.stopRecording();
  await fs.rm(path.dirname(restarted), { recursive: true, force: true });
  let nested;
  await assert.rejects(trace.startRecording({ get included_categories() {
    nested ??= trace.startRecording({}); return [];
  } }), /already active/);
  await nested;
  const reentrant = await trace.stopRecording();
  await fs.rm(path.dirname(reentrant), { recursive: true, force: true });
});

test('startup switches retain values while engine hints and security boundaries stay explicit', () => {
  let ready = false;
  const warnings = [];
  const app = { isReady: () => ready, getPreferredSystemLanguages: () => ['ko-KR'] };
  attachStartupOptions(app, { unsupported, argv: () => ['/runtime', '/app', '--lang=en-US', '--', '--not-a-switch'],
    env: { WEBER_UNSANDBOXED_DEVELOPMENT: '1' }, ignored: name => warnings.push(name) });
  assert.equal(app.commandLine.hasSwitch('not-a-switch'), false);
  app.commandLine.appendSwitch('enable-features', 'EarlyEstablishGpuChannel');
  app.commandLine.appendSwitch('enable-features', 'DifferentHint');
  assert.deepEqual(warnings, ['enable-features']);
  assert.equal(app.commandLine.getSwitchValue('enable-features'), 'DifferentHint');
  app.commandLine.appendSwitch('lang', 'fr-CA'); assert.equal(app.getLocaleCountryCode(), 'CA');
  app.commandLine.removeSwitch('lang'); assert.equal(app.getLocale(), 'ko-KR');
  app.commandLine.appendSwitch('no-sandbox');
  assert.throws(() => app.commandLine.removeSwitch('no-sandbox'), /sandbox policy/);
  assert.throws(() => app.commandLine.appendSwitch('disable-web-security'), /Unsupported/);
  assert.throws(() => app.enableSandbox(), /not implemented/);
  ready = true; assert.throws(() => app.commandLine.appendSwitch('lang', 'en'), /after app ready/);
  const denied = { isReady: () => false, getPreferredSystemLanguages: () => [] };
  attachStartupOptions(denied, { unsupported, env: {} });
  assert.throws(() => denied.commandLine.appendSwitch('no-sandbox'), /development opt-in/);
});

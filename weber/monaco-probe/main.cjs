'use strict';
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve(process.env.WEBER_MONACO_RESULT || 'out/monaco.json');
const report = { kind: 'standalone-monaco-diagnostic', version: '0.52.2', ready: false,
  vscodeReady: false, osSandbox: false, checks: [], error: null };
const assets = path.join(__dirname, 'dist');
let finished = false;
protocol.registerSchemesAsPrivileged([{ scheme: 'monaco', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  report.error = error ? String(error.stack || error) : null;
  report.ready = !error;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  // This is diagnostic collection. ready/checks report actual acceptance.
  app.exit(0);
}
const deadline = setTimeout(() => finish(new Error('Monaco diagnostic exceeded 90 seconds')), 90000);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  report.assets = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json')));
  protocol.registerFileProtocol('monaco', (request, callback) => {
    const url = new URL(request.url);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.hostname !== 'app' || !/^[a-zA-Z0-9_.-]+$/.test(name)) { callback({ error: -6 }); return; }
    const filename = path.join(assets, name);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { callback({ error: -6 }); return; }
    callback({ path: filename });
  });
  const window = new BrowserWindow({ width: 800, height: 600, title: 'Weber Monaco Probe' });
  await window.loadURL('monaco://app/');
  report.checks.push('document-load');
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await window.webContents.executeJavaScript('globalThis.monacoProbe || null');
    report.page = state;
    if (state?.errors?.length) throw new Error(state.errors.join('\n'));
    if (state?.stage === 'editor') break;
    await delay(100);
  }
  assert.equal(report.page?.stage, 'editor', 'Monaco did not construct its editor');
  report.checks.push('editor-construction');
  assert.equal(await window.webContents.executeJavaScript('probeEditor.getValue()'), 'const answer = 42;\n');
  const edited = await window.webContents.executeJavaScript(`
    probeEditor.pushUndoStop();
    probeEditor.executeEdits('probe', [{ range: {startLineNumber:1,startColumn:16,endLineNumber:1,endColumn:18}, text:'73' }]);
    probeEditor.pushUndoStop(); probeEditor.getValue();
  `);
  assert.equal(edited, 'const answer = 73;\n');
  report.checks.push('model-edit');
  await window.webContents.executeJavaScript(`probeEditor.trigger('probe', 'undo', null); Promise.resolve(true)`);
  assert.equal(await window.webContents.executeJavaScript('probeEditor.getValue()'), 'const answer = 42;\n');
  report.checks.push('undo');
  await window.webContents.executeJavaScript(`probeEditor.setPosition({lineNumber:1,column:7}); probeEditor.focus(); true`);
  const xwindow = (await execute('xdotool', ['search', '--name', '^Weber Monaco Probe$'])).stdout.trim().split('\n').at(-1);
  await execute('xdotool', ['windowfocus', '--sync', xwindow]);
  await execute('xdotool', ['type', '--clearmodifiers', '--delay', '20', 'Native']);
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await window.webContents.executeJavaScript('probeEditor.getValue()')).includes('Native')) break;
    await delay(100);
  }
  assert.ok((await window.webContents.executeJavaScript('probeEditor.getValue()')).includes('Native'));
  report.checks.push('native-keyboard-input');
  assert.ok(await window.webContents.executeJavaScript('document.querySelectorAll(".view-lines .view-line").length > 0'));
  const png = (await window.capturePage()).toPNG();
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  fs.writeFileSync(output.replace(/\.json$/, '') + '.png', png);
  report.checks.push('visible-line-dom-and-capture');
  report.coreEditingReady = true;
  await window.webContents.executeJavaScript(`
    probeEditor.setValue(Array.from({length: 1000}, (_, n) => 'Line ' + (n + 1)).join('\\n'));
    probeEditor.revealLineInCenter(700);
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
  `);
  assert.ok(await window.webContents.executeJavaScript(`probeEditor.getScrollTop() > 0 &&
    probeEditor.getVisibleRanges().some(range => range.startLineNumber <= 700 && range.endLineNumber >= 700)`));
  report.checks.push('thousand-line-scroll-and-visible-range');
  await window.webContents.executeJavaScript('probeStartDiff()');
  let changes;
  for (let attempt = 0; attempt < 100; attempt++) {
    report.page = await window.webContents.executeJavaScript('monacoProbe');
    if (report.page.errors.length) throw new Error(report.page.errors.join('\n'));
    changes = await window.webContents.executeJavaScript('probeDiff.getLineChanges() || null');
    if (changes?.length) break;
    await delay(100);
  }
  assert.equal(changes?.length, 1, 'Original Monaco diff did not complete');
  assert.equal(changes[0].originalStartLineNumber, 2);
  assert.equal(changes[0].modifiedStartLineNumber, 2);
  assert.ok(report.page.workers > 0 && report.page.workerMessages > 0,
    'Diff must exchange messages with the original editor worker');
  report.checks.push('original-editor-worker-and-diff');
  finish();
}).catch(finish);

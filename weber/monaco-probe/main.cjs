'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve(process.env.WEBER_MONACO_RESULT || 'out/monaco.json');
const report = { kind: 'standalone-monaco-diagnostic', version: '0.52.2', ready: false,
  vscodeReady: false, osSandbox: false, checks: [], error: null };
const assets = path.join(__dirname, 'dist');
let finished = false;
let server;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  report.error = error ? String(error.stack || error) : null;
  report.ready = !error;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  server?.close();
  // This is diagnostic collection. ready/checks report actual acceptance.
  app.exit(0);
}
const deadline = setTimeout(() => finish(new Error('Monaco diagnostic exceeded 90 seconds')), 90000);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  report.assets = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json')));
  server = http.createServer((request, response) => {
    const name = request.url === '/' ? 'index.html' : request.url.slice(1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { response.writeHead(404).end(); return; }
    const filename = path.join(assets, name);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { response.writeHead(404).end(); return; }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf' };
    response.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ width: 800, height: 600, title: 'Weber Monaco Probe' });
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
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
  finish();
}).catch(finish);

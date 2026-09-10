// Actual GIO launcher, private desktop registrations and reversible trash.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weber-shell-'));
  const app = new EventEmitter();
  try {
    const data = path.join(root, 'data'), config = path.join(root, 'config'), records = path.join(root, 'opened.jsonl');
    await fs.mkdir(path.join(data, 'applications'), { recursive: true }); await fs.mkdir(config);
    const handler = path.join(root, 'handler.py');
    await fs.writeFile(handler, 'import json, os, sys\nwith open(sys.argv[1], "a") as out:\n out.write(json.dumps({"pid": os.getpid(), "target": sys.argv[2]}) + "\\n")\n');
    await fs.writeFile(path.join(data, 'applications', 'weber-shell.desktop'), [
      '[Desktop Entry]', 'Type=Application', 'Name=Weber Shell Test', 'NoDisplay=true',
      `Exec=/usr/bin/python3 ${handler} ${records} %u`,
      'MimeType=x-scheme-handler/weber-shell-test;text/plain;inode/directory;', 'Terminal=false', ''
    ].join('\n'));
    await fs.writeFile(path.join(config, 'mimeapps.list'), '[Default Applications]\nx-scheme-handler/weber-shell-test=weber-shell.desktop\ntext/plain=weber-shell.desktop\ninode/directory=weber-shell.desktop\n');
    // Force the documented file-manager fallback, without contacting a user's
    // session bus or launching a real browser/file-manager during this test.
    const env = { ...process.env, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(root, 'no-session') };
    const binding = require('./shell-binding.cjs').createShellBinding({ app, env,
      unsupported: message => { throw Error('Unsupported ' + message); } });
    const saved = process._linkedBinding;
    process._linkedBinding = name => name === 'electron_common_shell' ? binding : saved(name);
    let shell;
    try { shell = createCommonJSLoader(() => undefined).load(path.join(__dirname, 'dist/common/api/shell.js')).default; }
    finally { process._linkedBinding = saved; }
    async function waitForOpen(count) {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        try {
          const lines = (await fs.readFile(records, 'utf8')).trim().split('\n').map(JSON.parse);
          if (lines.length >= count) return lines[count - 1];
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw Error('Desktop handler did not receive request ' + count);
    }
    const uri = 'weber-shell-test://open/?literal=%24%28not-a-command%29%3B';
    await shell.openExternal(uri);
    const external = await waitForOpen(1); assert.equal(external.target, uri); assert.notEqual(external.pid, process.pid);
    const filename = path.join(root, 'literal ; $(not-a-command) file.txt');
    await fs.writeFile(filename, 'keep these bytes');
    assert.equal(await shell.openPath(filename), '');
    const opened = await waitForOpen(2);
    assert.ok([filename, pathToFileURL(filename).href].includes(opened.target));
    assert.equal(shell.showItemInFolder(filename), undefined);
    const folder = await waitForOpen(3);
    assert.ok([root, pathToFileURL(root).href].includes(folder.target));
    assert.match(await shell.openPath(path.join(root, 'missing')), /ENOENT/);
    await assert.rejects(shell.openExternal(uri, { activate: false }), /Unsupported/);
    await shell.trashItem(filename);
    await assert.rejects(fs.stat(filename), /ENOENT/);
    const trash = path.join(data, 'Trash', 'files');
    const trashed = await fs.readdir(trash);
    assert.equal(trashed.length, 1); assert.equal(await fs.readFile(path.join(trash, trashed[0]), 'utf8'), 'keep these bytes');
    console.log(JSON.stringify({ kind: 'native-shell-acceptance', backend: process.versions.bun ? 'bun' : 'node', passed: true,
      originalShellModule: true, externalURI: true, openPath: true, revealFallback: true, trashPreservesData: true,
      fileManagerSelectionTested: false }));
  } finally { app.emit('quit'); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

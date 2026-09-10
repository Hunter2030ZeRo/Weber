// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function createShellBinding({ app, unsupported, env = process.env }) {
  const active = new Set();
  const stop = () => { for (const child of active) child.kill('SIGTERM'); };
  app.once('quit', stop); process.once('exit', stop);
  function text(value, label) {
    if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 64 * 1024)
      throw new TypeError('Invalid ' + label);
    return value;
  }
  function command(binary, args) {
    if (active.size >= 32) return Promise.reject(new RangeError('Too many desktop shell operations'));
    return new Promise((resolve, reject) => {
      const child = execFile(binary, args, { env, timeout: 5000, maxBuffer: 8192, shell: false }, (error, stdout, stderr) => {
        active.delete(child);
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      });
      active.add(child);
    });
  }
  const open = uri => command('/usr/bin/gio', ['open', '--', uri]);
  return {
    async openExternal(url, options = {}) {
      const uri = new URL(text(url, 'external URL'));
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid openExternal options');
      if (Object.keys(options).some(key => key !== 'activate') || (options.activate !== undefined && options.activate !== true))
        return unsupported('shell.openExternal options on Linux');
      await open(uri.href);
    },
    async openPath(value) {
      const filename = path.resolve(text(value, 'path'));
      try { await fs.stat(filename); await open(pathToFileURL(filename).href); return ''; }
      catch (error) { return error.message; }
    },
    showItemInFolder(value) {
      const filename = path.resolve(text(value, 'path'));
      const uri = pathToFileURL(filename).href;
      // Each argument goes straight to GDBus, never through a command shell.
      // JSON string-array syntax is valid GVariant text for these URI strings.
      void command('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.FileManager1',
        '--object-path', '/org/freedesktop/FileManager1', '--method', 'org.freedesktop.FileManager1.ShowItems',
        JSON.stringify([uri]), "''"]).catch(() => open(pathToFileURL(path.dirname(filename)).href))
        .catch(error => process.emitWarning(error.message, { code: 'WEBER_SHELL_REVEAL' }));
    },
    async trashItem(value) {
      const filename = path.resolve(text(value, 'path'));
      await command('/usr/bin/gio', ['trash', '--', filename]);
    },
    beep: () => unsupported('shell.beep'),
    readShortcutLink: () => unsupported('shell.readShortcutLink on Linux'),
    writeShortcutLink: () => unsupported('shell.writeShortcutLink on Linux'),
  };
}
module.exports = { createShellBinding };

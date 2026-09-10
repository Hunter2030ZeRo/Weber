#!/usr/bin/env node
// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { HostClient } = require('./host-client.cjs');
const { createBindings } = require('./bindings.cjs');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
let activeHost;

async function main() {
  const project = path.resolve(process.argv[2] || '.');
  const packageFile = path.join(project, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const entry = process.env.WEBER_ENTRY ? path.resolve(process.env.WEBER_ENTRY) :
    path.resolve(project, metadata.main || 'index.js');
  const dist = path.join(__dirname, 'dist');
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'source-manifest.json'), 'utf8'));
  const allowedModules = new Set(manifest.sources.map(item => item.path.slice(4, -3)));
  const root = path.resolve(__dirname, '../..');
  const hostPath = process.env.WEBER_DESKTOP_HOST || path.join(root, 'out/runtime/weber-desktop-host');
  const rendererPath = process.env.WEBER_OBSCURA_RENDERER || path.join(root, 'out/runtime/obscura/weber-obscura-renderer');
  for (const filename of [hostPath, rendererPath]) {
    if (!path.isAbsolute(filename)) throw new Error('Runtime executable paths must be absolute');
    fs.accessSync(filename, fs.constants.X_OK);
  }
  const host = new HostClient(hostPath, [rendererPath, '--weber-batch-events']);
  activeHost = host;
  const originalLoad = Module._load;
  const originalBinding = process._linkedBinding?.bind(process);
  const api = {};
  const loaded = new Map();
  // Electron exposes both names (including the node: form in asar-spec.ts).
  // This runtime has no ASAR fs wrapper, so its original fs is exactly node:fs.
  // Introducing ASAR later must preserve this native path before any wrapping.
  const isOriginalFs = request => request === 'original-fs' || request === 'node:original-fs';
  const bunLoader = process.versions.bun ? createCommonJSLoader(request => {
    if (request === 'electron' || request === 'electron/main') return { value: api };
    if (isOriginalFs(request)) return { value: fs };
    if (request.startsWith('@electron/internal/')) return { value: loadInternal(request.slice('@electron/internal/'.length)) };
    return undefined;
  }) : null;
  function loadInternal(id) {
    if (!allowedModules.has(id)) throw new Error(`Electron source module was not compiled: ${id}`);
    const filename = path.join(dist, `${id}.js`);
    return bunLoader ? bunLoader.load(filename) : originalLoad.call(Module, filename, module, false);
  }
  const runtime = createBindings(host, project, loadInternal);
  process._linkedBinding = name => {
    if (runtime.bindings.has(name)) return runtime.bindings.get(name);
    if (name.startsWith('electron_')) return runtime.unsupported(`native binding ${name}`);
    if (originalBinding) return originalBinding(name);
    throw new Error(`Unknown linked binding: ${name}`);
  };
  const apiModules = {
    BaseWindow: 'browser/api/base-window', BrowserWindow: 'browser/api/browser-window',
    webContents: 'browser/api/web-contents', View: 'browser/api/view',
    WebContentsView: 'browser/api/web-contents-view', ipcMain: 'browser/api/ipc-main',
    Menu: 'browser/api/menu', MenuItem: 'browser/api/menu-item',
    screen: 'browser/api/screen', systemPreferences: 'browser/api/system-preferences',
    Notification: 'browser/api/notification',
    MessageChannelMain: 'browser/api/message-channel', clipboard: 'browser/api/clipboard', ClipboardItem: 'browser/api/clipboard-item',
    globalShortcut: 'browser/api/global-shortcut', protocol: 'browser/api/protocol',
  };
  api.app = runtime.app;
  for (const [name, id] of Object.entries(apiModules)) {
    Object.defineProperty(api, name, { enumerable: true, get() {
      if (!loaded.has(name)) {
        const value = loadInternal(id);
        if (value === undefined) throw new Error(`Electron source module returned no exports: ${id}`);
        const exported = value.default ?? value;
        loaded.set(name, name === 'clipboard' ? runtime.decorateClipboard(exported) : exported);
      }
      return loaded.get(name);
    } });
  }
  api.TouchBar = { _setOnWindow: () => runtime.unsupported('TouchBar') };
  api.session = runtime.session;
  api.webFrameMain = { fromId: (processId, routingId) => {
    const wc = api.webContents.getAllWebContents().find(value => value.id === routingId && value.getOSProcessId() === processId);
    return wc?.mainFrame;
  } };
  api.dialog = { showMessageBox: () => runtime.unsupported('dialog.showMessageBox'),
    showErrorBox: (title, message) => { console.error(`${title}: ${message}`); } };
  if (!bunLoader) Module._load = function (request, parent, isMain) {
    if (request === 'electron' || request === 'electron/main') return api;
    if (isOriginalFs(request)) return fs;
    if (request === 'electron/renderer') return runtime.unsupported('renderer API in the main process');
    if (request.startsWith('@electron/internal/')) return loadInternal(request.slice('@electron/internal/'.length));
    return originalLoad.call(this, request, parent, isMain);
  };
  globalThis[Symbol.for('weber.electron.api')] = api;
  // Node's synchronous hooks preserve ordinary ESM import { app } from
  // 'electron'. The generated facade names exports statically for CJS/ESM.
  if (!bunLoader && typeof Module.registerHooks === 'function') {
    Module.registerHooks({ resolve(specifier, context, nextResolve) {
      if (isOriginalFs(specifier)) return { url: 'node:fs', shortCircuit: true };
      if (specifier === 'electron' || specifier === 'electron/main') {
        return { url: pathToFileURL(path.join(__dirname, 'electron-api.cjs')).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    } });
  }
  process.type = 'browser';
  Object.defineProperty(process.versions, 'weber', { value: '0.1.0', enumerable: true });
  Object.defineProperty(process.versions, 'electron', { value: '0.0.0-weber-development', enumerable: true });
  process.resourcesPath = project;
  process.argv = [process.argv[0], project, ...process.argv.slice(3)];
  api.app.setName(metadata.productName || metadata.name || path.basename(project));
  api.app.setVersion(metadata.version || '0.0.0');
  api.app.on('weber-error', error => {
    console.error(error.stack || error);
    api.app.exit(1);
  });
  api.app.on('window-all-closed', () => {
    if (api.app.listenerCount('window-all-closed') === 1) api.app.quit();
  });
  process.once('exit', () => host.close());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => api.app.exit(signal === 'SIGINT' ? 130 : 143));
  // Set original prototypes and WebContents methods before any application code.
  for (const name of ['BaseWindow', 'View', 'WebContentsView', 'webContents', 'BrowserWindow', 'ipcMain', 'protocol']) void api[name];
  try {
    if (entry.endsWith('.mjs') || (metadata.type === 'module' && !entry.endsWith('.cjs'))) {
      if (bunLoader || typeof Module.registerHooks !== 'function') runtime.unsupported('ESM application loading on this backend');
      await import(pathToFileURL(entry).href);
    } else {
      if (bunLoader) bunLoader.load(entry, true);
      else Module._load(entry, null, true);
    }
    runtime.finishStartup();
  } catch (error) {
    console.error(error.stack || error);
    api.app.exit(1);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  activeHost?.close();
  process.exitCode = 1;
});

// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Bun does not consistently route CommonJS dependencies through Module._load.
// Use the ordinary CommonJS wrapper for application JS and the compiled Electron
// modules; keep package resolution, builtins and native addons on Bun's loader.
// This loader does not implement ESM and must not be advertised as doing so.
function createCommonJSLoader(resolveSpecial) {
  const cache = Object.create(null);
  let main;
  function load(filename, parent, isMain = false) {
    if (cache[filename]) return cache[filename].exports;
    const nativeRequire = Module.createRequire(filename);
    if (!['.js', '.cjs', '.json'].includes(path.extname(filename))) return nativeRequire(filename);
    const current = new Module(filename, parent);
    current.filename = filename;
    current.path = path.dirname(filename);
    current.paths = Module._nodeModulePaths(current.path);
    cache[filename] = current;
    if (isMain) { main = current; current.id = '.'; process.mainModule = current; }
    const localRequire = request => {
      // Keep Electron's upstream utility wrapper unchanged while adapting its
      // stdout/stderr FD constructors. Application net imports stay native.
      if (process.versions.bun && (request === 'net' || request === 'node:net') &&
          filename === path.join(__dirname, 'dist/browser/api/utility-process.js'))
        return require('./utility-socket.cjs').net;
      const special = resolveSpecial(request);
      if (special) return special.value;
      if (Module.isBuiltin(request)) return nativeRequire(request);
      return load(nativeRequire.resolve(request), current);
    };
    localRequire.resolve = request => nativeRequire.resolve(request);
    localRequire.cache = cache;
    localRequire.main = main;
    current.require = localRequire;
    try {
      const source = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').replace(/^#![^\n]*(?:\n|$)/, '');
      if (filename.endsWith('.json')) current.exports = JSON.parse(source);
      else {
        const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname',
          `${source}\n//# sourceURL=${filename}`);
        wrapper.call(current.exports, current.exports, localRequire, current, filename, current.path);
      }
      current.loaded = true;
      return current.exports;
    } catch (error) {
      delete cache[filename];
      throw error;
    }
  }
  return { load: (filename, isMain = false) => load(filename, undefined, isMain) };
}

module.exports = { createCommonJSLoader };

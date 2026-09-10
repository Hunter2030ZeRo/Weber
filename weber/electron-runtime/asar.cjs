// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const installed = Symbol.for('weber.asar.runtime');
const originalSymbol = Symbol.for('weber.asar.original-fs');
const MAX_HEADER = 32 * 1024 * 1024;
const MAX_FILE = 512 * 1024 * 1024;

function failure(code, filename, message = code) {
  return Object.assign(new Error(`${code}: ${message}, '${filename}'`), { code, path: filename });
}

// This is a read-only archive view, not extraction. File descriptors, writes,
// watchers, packed native addons and archive symlinks are deliberately absent.
// Node synchronous module hooks are required for application module loading.
function installAsar() {
  if (globalThis[installed]) return globalThis[installed];
  const descriptors = Object.getOwnPropertyDescriptors(fs);
  const originalPromises = { ...fs.promises };
  descriptors.promises = { value: originalPromises, enumerable: true };
  const originalFs = Object.defineProperties({}, descriptors);
  const archives = new Map();
  const filenameOf = value => value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() :
    typeof value === 'string' ? value : undefined;
  function split(value) {
    if (process.noAsar) return undefined;
    const filename = filenameOf(value);
    if (!filename || !filename.includes('.asar')) return undefined;
    const absolute = path.resolve(filename);
    const components = absolute.split(path.sep);
    for (let i = 0; i < components.length; i++) {
      if (!components[i].endsWith('.asar')) continue;
      const archive = components.slice(0, i + 1).join(path.sep);
      let info;
      try { info = originalFs.statSync(archive); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw error;
      }
      if (info.isFile()) return { archive, inner: components.slice(i + 1).join('/'), filename: absolute, info };
    }
    return undefined;
  }
  function readAt(fd, size, position, filename) {
    const data = Buffer.alloc(size);
    let count = 0;
    while (count < size) {
      const bytes = originalFs.readSync(fd, data, count, size - count, position + count);
      if (!bytes) throw failure('ERR_ASAR_INVALID', filename, 'truncated archive data');
      count += bytes;
    }
    return data;
  }
  function archiveFor(location) {
    const { archive, info } = location;
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = archives.get(archive);
    if (cached?.fingerprint === fingerprint) return cached;
    const invalid = message => { throw failure('ERR_ASAR_INVALID', archive, message); };
    if (info.size < 16) invalid('truncated pickle header');
    const fd = originalFs.openSync(archive, 'r');
    try {
      const prefix = readAt(fd, 16, 0, archive);
      const sizePayload = prefix.readUInt32LE(0), headerSize = prefix.readUInt32LE(4);
      const payloadSize = prefix.readUInt32LE(8), jsonSize = prefix.readUInt32LE(12);
      if (sizePayload !== 4 || headerSize < 8 || headerSize > MAX_HEADER || headerSize % 4 ||
          payloadSize !== headerSize - 4 || payloadSize !== Math.ceil((4 + jsonSize) / 4) * 4 ||
          !jsonSize || 8 + headerSize > info.size) invalid('invalid pickle lengths');
      let header;
      try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readAt(fd, jsonSize, 16, archive))); }
      catch { invalid('invalid UTF-8/JSON header'); }
      if (!header || typeof header.files !== 'object' || !header.files || Array.isArray(header.files)) invalid('missing file tree');
      const entries = new Map([['', { directory: true, children: Object.keys(header.files) }]]);
      const pending = [['', header.files, false, 0]];
      let count = 0;
      while (pending.length) {
        const [parent, children, inheritedUnpacked, depth] = pending.pop();
        if (depth > 64) invalid('file tree too deep');
        for (const [name, entry] of Object.entries(children)) {
          if (++count > 250000) invalid('too many archive entries');
          if (!name || name === '.' || name === '..' || /[\\/:\x00-\x1f]/.test(name) || Buffer.byteLength(name) > 255)
            invalid('unsafe path component');
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('invalid entry');
          if (Object.hasOwn(entry, 'link')) invalid('archive symlinks are unsupported');
          const unpacked = entry.unpacked ?? inheritedUnpacked;
          if (typeof unpacked !== 'boolean' || (entry.executable !== undefined && typeof entry.executable !== 'boolean')) invalid('invalid file flags');
          const inner = parent ? `${parent}/${name}` : name;
          if (Buffer.byteLength(inner) > 4096) invalid('archive path too long');
          if (Object.hasOwn(entry, 'files')) {
            if (!entry.files || typeof entry.files !== 'object' || Array.isArray(entry.files) ||
                Object.hasOwn(entry, 'size') || Object.hasOwn(entry, 'offset')) invalid('invalid directory');
            entries.set(inner, { directory: true, unpacked, children: Object.keys(entry.files) });
            pending.push([inner, entry.files, unpacked, depth + 1]);
          } else {
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE) invalid('invalid file size');
            let offset = 0;
            if (!unpacked) {
              if (typeof entry.offset !== 'string' || !/^\d{1,20}$/.test(entry.offset)) invalid('invalid offset');
              offset = Number(entry.offset);
              if (!Number.isSafeInteger(offset) || offset > info.size - 8 - headerSize || entry.size > info.size - 8 - headerSize - offset)
                invalid('file range exceeds archive');
            }
            entries.set(inner, { size: entry.size, offset, unpacked, executable: !!entry.executable, directory: false });
          }
        }
      }
      const archiveData = { entries, body: 8 + headerSize, fingerprint };
      // Bound metadata cache; open descriptors are never retained.
      if (archives.size >= 32) archives.delete(archives.keys().next().value);
      archives.set(archive, archiveData);
      return archiveData;
    } finally { originalFs.closeSync(fd); }
  }
  function lookup(value, required = true) {
    const location = split(value);
    if (!location) return undefined;
    const archive = archiveFor(location);
    const entry = archive.entries.get(location.inner);
    if (!entry && required) throw failure('ENOENT', location.filename, 'no such archive entry');
    return { ...location, ...archive, entry };
  }
  function unpackedPath(location) {
    const root = `${location.archive}.unpacked`;
    if (!originalFs.lstatSync(root).isDirectory()) throw failure('ERR_ASAR_INVALID', root, 'unpacked root must be a real directory');
    const actualRoot = originalFs.realpathSync(root);
    const actual = originalFs.realpathSync(path.join(root, location.inner));
    if (!actual.startsWith(actualRoot + path.sep)) throw failure('ERR_ASAR_INVALID', actual, 'unpacked file escapes archive');
    const info = originalFs.statSync(actual);
    if (!info.isFile() || info.size !== location.entry.size) throw failure('ERR_ASAR_INVALID', actual, 'unpacked file size/type mismatch');
    return actual;
  }
  function readFileSync(value, options) {
    const location = lookup(value);
    if (!location) return originalFs.readFileSync(value, options);
    if (location.entry.directory) throw failure('EISDIR', location.filename, 'illegal read on directory');
    const flag = typeof options === 'object' && options ? options.flag : undefined;
    if (flag !== undefined && flag !== 'r' && flag !== fs.constants.O_RDONLY) throw failure('EROFS', location.filename, 'archive is read-only');
    if (options?.signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (location.entry.unpacked) return originalFs.readFileSync(unpackedPath(location), options);
    const fd = originalFs.openSync(location.archive, 'r');
    let data;
    try { data = readAt(fd, location.entry.size, location.body + location.entry.offset, location.filename); }
    finally { originalFs.closeSync(fd); }
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? data.toString(encoding) : data;
  }
  function statSync(value, options) {
    const location = lookup(value, false);
    if (!location) return originalFs.statSync(value, options);
    if (!location.entry) {
      if (options?.throwIfNoEntry === false) return undefined;
      throw failure('ENOENT', location.filename, 'no such archive entry');
    }
    const info = originalFs.statSync(location.archive, options);
    const result = Object.assign(Object.create(Object.getPrototypeOf(info)), info);
    const big = typeof info.size === 'bigint';
    const number = n => big ? BigInt(n) : n;
    result.size = number(location.entry.directory ? 0 : location.entry.size);
    result.mode = number(location.entry.directory ? 0o40555 : location.entry.executable ? 0o100555 : 0o100444);
    result.nlink = number(1);
    return result;
  }
  function accessSync(value, mode = fs.constants.F_OK) {
    const location = lookup(value);
    if (!location) return originalFs.accessSync(value, mode);
    if (!Number.isInteger(mode) || mode < 0 || mode > 7) throw new TypeError('Invalid access mode');
    if (mode & fs.constants.W_OK) throw failure('EACCES', location.filename, 'archive is read-only');
    if (mode & fs.constants.X_OK && !location.entry.directory && !location.entry.executable && !location.entry.unpacked)
      throw failure('EACCES', location.filename, 'archive entry is not executable');
    if (location.entry.unpacked && !location.entry.directory) originalFs.accessSync(unpackedPath(location), mode);
  }
  function readdirSync(value, options) {
    const location = lookup(value);
    if (!location) return originalFs.readdirSync(value, options);
    if (!location.entry.directory) throw failure('ENOTDIR', location.filename);
    if (options?.recursive) throw failure('ENOTSUP', location.filename, 'recursive archive readdir is unsupported');
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return location.entry.children.map(name => {
      const encoded = encoding === 'buffer' ? Buffer.from(name) : name;
      if (!options?.withFileTypes) return encoded;
      const entry = location.entries.get(location.inner ? `${location.inner}/${name}` : name);
      return Object.assign(Object.create(fs.Dirent.prototype), {
        name: encoded, parentPath: location.filename, path: location.filename,
        isDirectory: () => entry.directory, isFile: () => !entry.directory,
        isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
        isFIFO: () => false, isSocket: () => false,
      });
    });
  }
  function realpathSync(value, options) {
    const location = lookup(value);
    if (!location) return originalFs.realpathSync(value, options);
    const result = path.join(originalFs.realpathSync(location.archive), location.inner);
    return (typeof options === 'string' ? options : options?.encoding) === 'buffer' ? Buffer.from(result) : result;
  }
  const syncMethods = { readFile: readFileSync, stat: statSync, lstat: (value, options) => split(value) ? statSync(value, options) : originalFs.lstatSync(value, options),
    access: accessSync, readdir: readdirSync, realpath: realpathSync };
  for (const [name, method] of Object.entries(syncMethods)) {
    fs[`${name}Sync`] = method;
    fs[name] = (value, ...args) => {
      if (!split(value)) return originalFs[name](value, ...args);
      const callback = args.pop();
      if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
      queueMicrotask(() => {
        let result;
        try { result = method(value, ...args); } catch (error) { callback(error); return; }
        callback(null, result);
      });
    };
    if (originalPromises[name]) fs.promises[name] = async (value, ...args) =>
      split(value) ? method(value, ...args) : originalPromises[name](value, ...args);
  }
  fs.realpathSync.native = realpathSync;
  fs.realpath.native = fs.realpath;
  fs.existsSync = value => { try { const location = lookup(value, false); return location ? !!location.entry : originalFs.existsSync(value); } catch { return false; } };
  fs.exists = (value, callback) => {
    if (!split(value)) return originalFs.exists(value, callback);
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    queueMicrotask(() => callback(fs.existsSync(value)));
  };
  fs.exists[require('node:util').promisify.custom] = value => new Promise(resolve => fs.exists(value, resolve));
  fs.createReadStream = (value, options = {}) => {
    if (!split(value)) return originalFs.createReadStream(value, options);
    // Yield a genuine Readable with errors delivered asynchronously; no fake fd.
    const settings = typeof options === 'string' ? { encoding: options } : options;
    const stream = new Readable({ ...settings, read() {
      try {
        if (settings.fd !== undefined || settings.fs !== undefined) throw failure('ENOTSUP', filenameOf(value), 'custom archive stream descriptors are unsupported');
        const data = readFileSync(value, { flag: settings.flags, signal: settings.signal });
        const start = settings.start ?? 0, end = settings.end ?? data.length - 1;
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < -1 || end < start && data.length)
          throw new RangeError('Invalid archive stream range');
        this.push(data.subarray(start, end + 1)); this.push(null);
      } catch (error) { this.destroy(error); }
    } });
    stream.path = value;
    return stream;
  };
  Module.syncBuiltinESMExports();

  function candidate(filename, legacy, seen = new Set()) {
    if (seen.has(filename)) return undefined;
    seen.add(filename);
    const value = lookup(filename, false);
    if (!value) return undefined;
    if (value.entry && !value.entry.directory) return value.filename;
    if (!legacy) return undefined;
    for (const extension of ['.js', '.json', '.node']) {
      const result = lookup(filename + extension, false);
      if (result?.entry && !result.entry.directory) return result.filename;
    }
    if (value.entry?.directory) {
      const metadata = lookup(path.join(filename, 'package.json'), false);
      if (metadata?.entry) {
        const pkg = JSON.parse(readFileSync(metadata.filename, 'utf8'));
        if (typeof pkg.main === 'string') {
          const main = candidate(path.resolve(filename, pkg.main), true, seen);
          if (main) return main;
        }
      }
      for (const extension of ['.js', '.json', '.node']) {
        const result = lookup(path.join(filename, 'index' + extension), false);
        if (result?.entry && !result.entry.directory) return result.filename;
      }
    }
    return undefined;
  }
  function packageTarget(root, subpath, conditions) {
    const metadata = lookup(path.join(root, 'package.json'), false);
    const legacy = subpath === '.' || conditions.includes('require');
    if (!metadata?.entry) return candidate(subpath === '.' ? root : path.join(root, subpath), legacy);
    const pkg = JSON.parse(readFileSync(metadata.filename, 'utf8'));
    if (pkg.exports === undefined) return candidate(subpath === '.' ? root : path.join(root, subpath), legacy);
    const exports = pkg.exports;
    function choose(value) {
      if (typeof value === 'string' || value === null) return value;
      if (Array.isArray(value)) {
        for (const item of value) { const target = choose(item); if (target !== undefined) return target; }
        return undefined;
      }
      if (value && typeof value === 'object') {
        for (const [condition, target] of Object.entries(value)) if (condition === 'default' || conditions.includes(condition)) {
          const selected = choose(target); if (selected !== undefined) return selected;
        }
        return undefined;
      }
      throw failure('ERR_INVALID_PACKAGE_TARGET', root, 'invalid archive package export');
    }
    let target;
    if (exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith('.'))) {
      // Exact subpaths/condition objects are supported. Pattern exports are
      // rejected explicitly rather than bypassing package encapsulation.
      if (Object.hasOwn(exports, subpath)) target = choose(exports[subpath]);
      else if (Object.keys(exports).some(key => key.includes('*'))) throw failure('ENOTSUP', root, 'archive package export patterns are unsupported');
    } else if (subpath === '.') target = choose(exports);
    if (target === undefined || target === null) throw failure('ERR_PACKAGE_PATH_NOT_EXPORTED', root, `package subpath ${subpath} is not exported`);
    if (!target.startsWith('./') || target.split('/').some(part => part === '..' || part === 'node_modules') || /[\\%]/.test(target))
      throw failure('ERR_INVALID_PACKAGE_TARGET', root, 'archive export must stay within its package');
    const result = candidate(path.resolve(root, target), false);
    if (!result) throw failure('ERR_MODULE_NOT_FOUND', root, 'archive package export target not found');
    return result;
  }
  function resolveArchive(specifier, parentURL, conditions = ['node', 'require']) {
    if (Module.isBuiltin(specifier)) return undefined;
    const parent = parentURL?.startsWith('file:') ? fileURLToPath(parentURL) : undefined;
    const commonjs = conditions.includes('require');
    if (!commonjs && (specifier.startsWith('file:') || parentURL &&
        (specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier)))) {
      const url = new URL(specifier, parentURL);
      if (url.protocol === 'file:' && (url.search || url.hash) && split(fileURLToPath(url)))
        throw failure('ENOTSUP', fileURLToPath(url), 'archive module URL query/fragment identities are unsupported');
    }
    let absolute;
    if (specifier.startsWith('file:')) absolute = fileURLToPath(specifier);
    else if (path.isAbsolute(specifier)) absolute = specifier;
    else if (specifier.startsWith('./') || specifier.startsWith('../')) absolute = parent && path.resolve(path.dirname(parent), specifier);
    if (absolute) {
      if (!split(absolute)) return undefined;
      const result = candidate(absolute, commonjs);
      if (!result) throw failure(commonjs ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND', absolute, 'archive module not found');
      return result;
    }
    if (!parent || !split(parent)) return undefined;
    if (specifier.startsWith('#')) throw failure('ENOTSUP', parent, 'archive package import maps are unsupported');
    if (specifier.includes(':')) return undefined;
    const bits = specifier.split('/');
    const name = bits[0].startsWith('@') ? bits.splice(0, 2).join('/') : bits.shift();
    const subpath = bits.length ? './' + bits.join('/') : '.';
    const location = split(parent);
    // The archive itself behaves as the enclosing node_modules directory.
    const roots = Module._nodeModulePaths(path.dirname(parent)).filter(value => value.startsWith(location.archive + path.sep));
    if (path.basename(location.archive) === 'node_modules.asar') roots.push(location.archive);
    for (const directory of [...new Set(roots)]) {
      const root = path.join(directory, name);
      const found = lookup(root, false);
      if (!found?.entry?.directory) continue;
      const result = packageTarget(root, subpath, conditions);
      if (result) return result;
      throw failure(commonjs ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND', root, 'archive package entry not found');
    }
    return undefined;
  }
  function physicalModule(filename) {
    const location = lookup(filename);
    if (path.extname(filename) !== '.node') return filename;
    if (!location.entry.unpacked) throw failure('ENOTSUP', filename, 'native addons must be declared unpacked in ASAR');
    return unpackedPath(location);
  }
  function format(filename) {
    const extension = path.extname(filename);
    if (extension === '.json') return 'json';
    if (extension === '.mjs') return 'module';
    if (extension === '.cjs') return 'commonjs';
    if (extension !== '.js') throw failure('ERR_UNKNOWN_FILE_EXTENSION', filename);
    let current = path.dirname(filename);
    while (split(current)) {
      // A dependency never inherits its consumer's package type.
      if (['node_modules', 'node_modules.asar'].includes(path.basename(current))) break;
      const metadata = lookup(path.join(current, 'package.json'), false);
      if (metadata?.entry) return JSON.parse(readFileSync(metadata.filename, 'utf8')).type === 'module' ? 'module' : 'commonjs';
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return 'commonjs';
  }
  const isOriginalFs = specifier => specifier === 'original-fs' || specifier === 'node:original-fs';
  globalThis[originalSymbol] = originalFs;
  const originalLoad = Module._load;
  Module._load = function(specifier, parent, isMain) {
    if (isOriginalFs(specifier)) return originalFs;
    const internalOptions = arguments[3];
    if (internalOptions?.shouldSkipModuleHooks && !internalOptions.resolved && split(specifier)) {
      // An application resolver may try native resolution, catch its failure,
      // then resolve inside ASAR. Node still records that native resolution ran
      // and asks its CJS translator to skip hooks, without a resolved filename.
      // Supply the same verified archive source/format a successful hook would
      // supply; keep Node's actual module cache, compilation and cycle handling.
      const filename = resolveArchive(specifier, parent?.filename && pathToFileURL(parent.filename).href);
      const physical = physicalModule(filename);
      const url = pathToFileURL(physical).href;
      const archived = physical === filename;
      return originalLoad.call(this, specifier, parent, isMain, {
        ...internalOptions,
        resolved: { filename: physical, url, format: archived ? format(filename) : undefined },
        ...(archived ? { source: readFileSync(filename, 'utf8') } : {}),
      });
    }
    // Node forwards resolved format/source as a fourth internal argument when
    // an ESM import evaluates CommonJS. Dropping it re-enters native package
    // type detection outside the archive and can create a false require(esm)
    // cycle under a consumer with "type": "module".
    return originalLoad.apply(this, arguments);
  };
  if (!process.versions.bun && typeof Module.registerHooks === 'function') Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isOriginalFs(specifier)) return { url: 'weber:original-fs', shortCircuit: true };
      const result = resolveArchive(specifier, context.parentURL, context.conditions);
      if (!result) return nextResolve(specifier, context);
      const physical = physicalModule(result);
      if (physical !== result) return nextResolve(physical, context);
      return { url: pathToFileURL(result).href, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (url === 'weber:original-fs') {
        const names = Object.keys(originalFs).filter(name => /^[a-zA-Z_$][\w$]*$/.test(name));
        return { format: 'module', shortCircuit: true, source: `const fs = globalThis[Symbol.for('weber.asar.original-fs')];\nexport default fs;\n` +
          names.map(name => `export const ${name} = fs.${name};`).join('\n') };
      }
      if (!url.startsWith('file:') || !split(fileURLToPath(url))) return nextLoad(url, context);
      const filename = fileURLToPath(url);
      const type = format(filename);
      if (type === 'json' && context.conditions?.includes('import') && context.importAttributes?.type !== 'json')
        throw failure('ERR_IMPORT_ATTRIBUTE_MISSING', filename, 'JSON import requires type: json');
      return { format: type, source: readFileSync(filename), shortCircuit: true };
    },
  });
  const result = { originalFs, resolveArchive, physicalModule, nodeModuleHooks: !process.versions.bun && typeof Module.registerHooks === 'function' };
  globalThis[installed] = result;
  return result;
}
module.exports = { installAsar };

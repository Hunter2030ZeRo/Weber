// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { createCommonJSLoader } = require('./commonjs-loader.cjs');
const runtime = require('./asar.cjs').installAsar();
const original = runtime.originalFs;

function pickle(header, body = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const payload = Math.ceil((4 + json.length) / 4) * 4;
  const result = Buffer.alloc(12 + payload + body.length);
  result.writeUInt32LE(4, 0); result.writeUInt32LE(payload + 4, 4);
  result.writeUInt32LE(payload, 8); result.writeUInt32LE(json.length, 12);
  json.copy(result, 16); body.copy(result, 12 + payload);
  return result;
}
function fixture(t, files, archiveName = 'node_modules.asar') {
  const directory = original.mkdtempSync(path.join(os.tmpdir(), 'weber-asar-'));
  t.after(() => original.rmSync(directory, { recursive: true, force: true }));
  const archive = path.join(directory, archiveName);
  const header = { files: {} }, chunks = [];
  let size = 0;
  for (const [filename, input] of Object.entries(files)) {
    const spec = typeof input === 'string' || Buffer.isBuffer(input) ? { data: input } : input;
    const data = Buffer.from(spec.data);
    const names = filename.split('/');
    let parent = header;
    for (const name of names.slice(0, -1)) parent = parent.files[name] ??= { files: {} };
    const entry = { size: data.length };
    if (spec.unpacked) {
      entry.unpacked = true;
      const physical = path.join(archive + '.unpacked', filename);
      original.mkdirSync(path.dirname(physical), { recursive: true });
      original.writeFileSync(physical, data);
    } else { entry.offset = String(size); chunks.push(data); size += data.length; }
    if (spec.executable) entry.executable = true;
    parent.files[names.at(-1)] = entry;
  }
  original.writeFileSync(archive, pickle(header, Buffer.concat(chunks)));
  return { directory, archive, filename: name => path.join(archive, name), header };
}
const hash = filename => createHash('sha256').update(original.readFileSync(filename)).digest('hex');

test('archive reads preserve original-fs, archive bytes and directory layout', async t => {
  const { archive, filename, directory } = fixture(t, { 'a/text.txt': 'héllo archive', 'a/empty': '', 'unpacked.txt': { data: 'real bytes', unpacked: true } });
  const before = hash(archive);
  assert.equal(fs.readFileSync(filename('a/text.txt'), 'utf8'), 'héllo archive');
  assert.deepEqual(await fs.promises.readFile(pathToFileURL(filename('a/text.txt'))), Buffer.from('héllo archive'));
  assert.equal(await promisify(fs.readFile)(Buffer.from(filename('unpacked.txt')), 'utf8'), 'real bytes');
  assert.equal(fs.readFileSync(filename('a/empty')).length, 0);
  assert.ok(fs.statSync(archive).isDirectory()); assert.ok(original.statSync(archive).isFile());
  assert.equal(fs.statSync(filename('a/text.txt'), { bigint: true }).size, 14n);
  assert.equal(fs.statSync(filename('absent'), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(fs.readdirSync(archive).sort(), ['a', 'unpacked.txt']);
  const entries = await fs.promises.readdir(archive, { withFileTypes: true });
  assert.ok(entries.find(entry => entry.name === 'a').isDirectory());
  assert.ok(entries.find(entry => entry.name === 'unpacked.txt').isFile());
  assert.equal(fs.realpathSync(filename('a/text.txt')), filename('a/text.txt'));
  assert.throws(() => fs.readFileSync(archive), { code: 'EISDIR' });
  assert.throws(() => fs.accessSync(filename('a/text.txt'), fs.constants.W_OK), { code: 'EACCES' });
  assert.throws(() => fs.readFileSync(filename('a/text.txt'), { flag: 'w' }), { code: 'EROFS' });
  assert.throws(() => original.readFileSync(filename('a/text.txt')), { code: 'ENOTDIR' });
  if (runtime.nodeModuleHooks) {
    assert.equal(require('original-fs'), original); assert.equal(require('node:original-fs'), original);
  } else {
    // Bun application imports go through the same custom loader as bootstrap.
    const source = path.join(directory, 'original-check.cjs');
    original.writeFileSync(source, 'module.exports=[require("original-fs"),require("node:original-fs")];');
    const loader = createCommonJSLoader(request => ['original-fs', 'node:original-fs'].includes(request) ? { value: original } : undefined, runtime);
    assert.deepEqual(loader.load(source), [original, original]); original.unlinkSync(source);
  }
  assert.deepEqual(original.readdirSync(directory).sort(), ['node_modules.asar', 'node_modules.asar.unpacked']);
  assert.equal(hash(archive), before);
  process.noAsar = true;
  try { assert.ok(fs.statSync(archive).isFile()); assert.throws(() => fs.readFileSync(filename('a/text.txt')), { code: 'ENOTDIR' }); }
  finally { delete process.noAsar; }
});

test('callbacks, promises, stream ranges, cancellation and missing entries report real results', async t => {
  const { filename } = fixture(t, { 'letters': 'abcdef' });
  let sync = true;
  await new Promise(resolve => {
    fs.readFile(filename('letters'), 'utf8', (error, result) => { assert.equal(sync, false); assert.ifError(error); assert.equal(result, 'abcdef'); resolve(); });
    sync = false;
  });
  assert.equal(await promisify(fs.exists)(filename('letters')), true);
  await assert.rejects(fs.promises.readFile(filename('missing')), { code: 'ENOENT' });
  const parts = [];
  for await (const part of fs.createReadStream(filename('letters'), { start: 1, end: 3 })) parts.push(part);
  assert.equal(Buffer.concat(parts).toString(), 'bcd');
  await assert.rejects(async () => { for await (const part of fs.createReadStream(filename('missing'))) void part; }, { code: 'ENOENT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fs.promises.readFile(filename('letters'), { signal: controller.signal }), { code: 'ABORT_ERR' });
});

test('archive CommonJS resolution retains filename, dependencies, JSON and module cache', t => {
  const { archive, filename } = fixture(t, {
    'pkg/package.json': '{"name":"pkg","main":"lib/start.js"}',
    'pkg/lib/start.js': 'module.exports = { value: require("dep") + require("./value.json").n, filename: __filename };',
    'pkg/lib/value.json': '{"n": 2}',
    'dep/index.js': 'module.exports = 40;',
  });
  const request = Module.createRequire(filename('x.js'));
  const load = runtime.nodeModuleHooks ? name => request(name) : name => {
    const target = runtime.resolveArchive(name, pathToFileURL(filename('x.js')).href);
    return loader.load(target);
  };
  const loader = createCommonJSLoader(() => undefined, runtime);
  const result = load('./pkg');
  assert.equal(result.value, 42); assert.equal(result.filename, filename('pkg/lib/start.js'));
  assert.equal(load('./pkg'), result);
  if (runtime.nodeModuleHooks) assert.equal(request.resolve('./pkg/package.json'), filename('pkg/package.json'));
  assert.ok(original.statSync(archive).isFile());
});

test('Node archive ESM supports relative imports and preserves unwrapped original-fs named exports', { skip: !runtime.nodeModuleHooks }, async t => {
  const { filename, archive } = fixture(t, {
    'esm/package.json': '{"type":"module"}',
    'esm/index.js': 'import { n } from "./value.js"; import { statSync } from "node:original-fs"; export const answer=n+2; export const raw=statSync(new URL("../..",import.meta.url)).isFile();',
    'esm/value.js': 'export const n = 40;',
    'esm/query.js': 'import { n } from "./value.js?different=1"; export default n;',
  });
  // Check raw original-fs on the archive itself without depending on URL dot semantics.
  const raw = await import('node:original-fs');
  assert.equal(raw.default, original); assert.equal(raw.statSync, original.statSync);
  assert.ok(raw.statSync(archive).isFile());
  const loaded = await import(pathToFileURL(filename('esm/index.js')).href);
  assert.equal(loaded.answer, 42);
  await assert.rejects(import(pathToFileURL(filename('esm/value.js')).href + '?different=1'), { code: 'ENOTSUP' });
  await assert.rejects(import(pathToFileURL(filename('esm/query.js')).href), { code: 'ENOTSUP' });
});

test('package exports cannot be bypassed by fallback and conditional require/import differ', { skip: !runtime.nodeModuleHooks }, async t => {
  const { filename } = fixture(t, {
    'exports/package.json': JSON.stringify({ name: 'exports', exports: { '.': { require: './cjs.cjs', import: './esm.mjs' }, './absent': './does-not-exist.js' } }),
    'exports/cjs.cjs': 'module.exports=21;', 'exports/esm.mjs': 'export default 42;',
    'exports/secret.js': 'module.exports="not exported";', 'exports/absent.js': 'module.exports="must not load";',
    'consumer.mjs': 'import answer from "exports"; export default answer;',
  });
  const request = Module.createRequire(filename('x.js'));
  assert.equal(request('exports'), 21);
  assert.equal((await import(pathToFileURL(filename('consumer.mjs')).href)).default, 42);
  assert.throws(() => request('exports/secret.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.throws(() => request('exports/absent'), { code: 'ERR_MODULE_NOT_FOUND' });
});

test('native addons load actual unpacked bytes and packed addons fail explicitly', t => {
  const native = path.join(__dirname, 'dist/native/weber_platform.node');
  assert.ok(original.existsSync(native), 'build the existing native runtime before the ASAR native-addon gate');
  const { filename } = fixture(t, {
    'addon/package.json': '{"main":"index.js"}',
    'addon/index.js': 'module.exports=require("./native.node");',
    'addon/native.node': { data: original.readFileSync(native), unpacked: true },
    'packed.node': 'not a native addon',
  });
  const target = runtime.resolveArchive('./addon', pathToFileURL(filename('x.js')).href);
  const loader = createCommonJSLoader(() => undefined, runtime);
  const addon = runtime.nodeModuleHooks ? Module.createRequire(filename('x.js'))('./addon') : loader.load(target);
  assert.equal(typeof addon.guardParent, 'function');
  assert.throws(() => runtime.physicalModule(filename('packed.node')), { code: 'ENOTSUP' });
});

test('malformed ranges, unsafe paths, symlinks and changed unpacked bytes fail closed', t => {
  const { archive, directory, filename } = fixture(t, { 'safe': 'yes', 'real': { data: 'hello', unpacked: true } });
  let number = 0;
  const reject = (header, body = Buffer.alloc(0)) => {
    const candidate = path.join(directory, `${++number}.asar`); original.writeFileSync(candidate, pickle(header, body));
    assert.throws(() => fs.readdirSync(candidate), { code: 'ERR_ASAR_INVALID' });
  };
  reject({ files: { x: { size: 20, offset: '0' } } });
  reject({ files: { x: { size: 1, offset: '9007199254740993' } } });
  reject({ files: { '..': { size: 0, offset: '0' } } });
  reject({ files: { 'a/b': { size: 0, offset: '0' } } });
  reject({ files: { x: { link: '../outside' } } });
  const truncated = path.join(directory, 'truncated.asar'); original.writeFileSync(truncated, Buffer.from('no'));
  assert.throws(() => fs.readFileSync(path.join(truncated, 'x')), { code: 'ERR_ASAR_INVALID' });
  original.writeFileSync(path.join(archive + '.unpacked', 'real'), 'changed bytes');
  assert.throws(() => fs.readFileSync(filename('real')), { code: 'ERR_ASAR_INVALID' });
  original.unlinkSync(path.join(archive + '.unpacked', 'real'));
  original.writeFileSync(path.join(directory, 'outside'), 'hello');
  original.symlinkSync(path.join(directory, 'outside'), path.join(archive + '.unpacked', 'real'));
  assert.throws(() => fs.readFileSync(filename('real')), { code: 'ERR_ASAR_INVALID' });
});

test('ordinary files and real directories named .asar preserve native behavior', async t => {
  const directory = original.mkdtempSync(path.join(os.tmpdir(), 'weber-no-asar-'));
  t.after(() => original.rmSync(directory, { recursive: true, force: true }));
  const realDirectory = path.join(directory, 'ordinary.asar'); original.mkdirSync(realDirectory);
  const filename = path.join(realDirectory, 'file.txt'); original.writeFileSync(filename, 'plain');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'plain');
  assert.equal(await fs.promises.readFile(filename, 'utf8'), 'plain');
  assert.equal(fs.statSync(filename).size, 5); assert.equal(fs.existsSync(filename), true);
});

test('utility process executes an archived entry and returns real archive data over ParentPort', { timeout: 10000 }, async t => {
  const { once, EventEmitter } = require('node:events');
  const { archive, filename } = fixture(t, {
    'child.cjs': `const fs=require('node:fs'); const raw=require('original-fs');
      process.parentPort.on('message', () => {
        process.parentPort.postMessage({pid:process.pid,filename:__filename,value:require('./data.json').answer,
          text:fs.readFileSync(__dirname+'/text.txt','utf8'),raw:raw.statSync(__dirname).isFile()});
        process.exit(0);
      });`,
    'data.json': '{"answer":42}', 'text.txt': 'authentic child bytes',
  }, 'child.asar');
  const before = hash(archive);
  const app = new EventEmitter(); app.isReady = () => true;
  const failures = []; app.on('weber-error', error => failures.push(error));
  const binding = require('./utility-binding.cjs').createUtilityBinding({ app,
    unsupported: name => { throw new Error('Unsupported: ' + name); } });
  const originalBinding = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_utility_process' ? binding : originalBinding(name);
  let utility;
  const loader = createCommonJSLoader(request => request.startsWith('@electron/internal/') ?
    { value: loader.load(path.join(__dirname, 'dist', request.slice('@electron/internal/'.length) + '.js')) } : undefined);
  try { utility = loader.load(path.join(__dirname, 'dist/browser/api/utility-process.js')); }
  finally { process._linkedBinding = originalBinding; }
  const child = utility.fork(filename('child.cjs'), [], { stdio: 'pipe' });
  const exit = once(child, 'exit'); const response = once(child, 'message');
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child._unwrapHandle()) child._unwrapHandle().stop('SIGKILL'); await exit; });
  await once(child, 'spawn');
  const pid = child.pid;
  child.postMessage('read');
  const [message] = await Promise.race([response, exit.then(([code]) => { throw new Error(`Utility exited ${code} before response: ${stderr}`); })]);
  assert.deepEqual(message, { pid, filename: filename('child.cjs'), value: 42, text: 'authentic child bytes', raw: true });
  assert.notEqual(pid, process.pid); assert.deepEqual(await exit, [0]);
  assert.equal(stderr, ''); assert.deepEqual(failures, []); assert.equal(hash(archive), before);
});

test('ESM package lookup matches ordinary Node package boundaries and index fallback', { skip: !runtime.nodeModuleHooks }, async t => {
  const files = {
    'package.json': '{"type":"module"}',
    'node_modules/legacy/index.js': 'module.exports=42;',
    'node_modules/legacy/subpath.js': 'module.exports=21;',
    'consumer.mjs': 'import answer from "legacy"; import nested from "legacy/subpath.js"; export default [answer,nested];',
    'extensionless.mjs': 'import answer from "legacy/subpath"; export default answer;',
  };
  const { filename, directory } = fixture(t, files, 'app.asar');
  const ordinary = path.join(directory, 'ordinary');
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(ordinary, name); original.mkdirSync(path.dirname(target), { recursive: true }); original.writeFileSync(target, bytes);
  }
  const native = await import(pathToFileURL(path.join(ordinary, 'consumer.mjs')).href);
  const archived = await import(pathToFileURL(filename('consumer.mjs')).href);
  assert.deepEqual(archived.default, native.default); assert.deepEqual(archived.default, [42, 21]);
  await assert.rejects(import(pathToFileURL(filename('extensionless.mjs')).href), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(import(pathToFileURL(path.join(ordinary, 'extensionless.mjs')).href), { code: 'ERR_MODULE_NOT_FOUND' });
});

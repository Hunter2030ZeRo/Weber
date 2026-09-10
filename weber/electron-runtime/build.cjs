// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// Compile the fork's actual Electron sources. Do not maintain a second copy of
// loadFile, loadURL, BrowserWindow forwarding, or WebContents event semantics.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const output = path.resolve(process.argv[3] || path.join(__dirname, 'dist'));
const entries = [
  'browser/api/base-window', 'browser/api/browser-window',
  'browser/api/web-contents', 'browser/api/view',
  'browser/api/web-contents-view', 'browser/api/ipc-main',
  'browser/ipc-main-internal',
  'browser/api/menu', 'browser/api/menu-item',
  'browser/api/notification',
  'browser/api/desktop-capturer',
  'browser/api/power-monitor', 'browser/api/power-save-blocker',
  'browser/api/crash-reporter', 'browser/api/content-tracing',
  'common/api/shell', 'browser/api/safe-storage',
  'browser/api/net', 'browser/api/net-fetch', 'utility/api/net',
  'browser/api/utility-process', 'utility/parent-port',
  'browser/api/screen', 'browser/api/system-preferences', 'browser/api/message-channel', 'browser/api/clipboard', 'browser/api/global-shortcut', 'browser/api/protocol',
];
const seen = new Set();
const sources = [];
const bindings = new Set();
// Record scoped fork fixes rather than labelling adapted source as unmodified.
const adaptations = {
  'lib/common/api/net-client-request.ts': 'Start empty chunked uploads and propagate response destruction to the owned URLLoader',
  'lib/browser/api/net-fetch.ts': 'Preserve explicit Bun fetch policies and abort failed streaming uploads',
};

function compile(id) {
  if (seen.has(id)) return;
  if (!/^[a-z0-9_/-]+$/.test(id) || id.split('/').includes('..')) {
    throw new Error(`Invalid Electron module id: ${id}`);
  }
  seen.add(id);
  const relative = `lib/${id}.ts`;
  const filename = path.join(root, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      sourceMap: true,
      inlineSources: true,
      removeComments: false,
    },
  });
  const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) || [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: p => p, getNewLine: () => '\n',
  }));
  for (const match of source.matchAll(/process\._linkedBinding\(['"]([^'"]+)['"]\)/g)) {
    bindings.add(match[1]);
  }
  const destination = path.join(output, `${id}.js`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, compiled.outputText);
  fs.writeFileSync(`${destination}.map`, compiled.sourceMapText);
  sources.push({ path: relative, sha256: crypto.createHash('sha256').update(source).digest('hex'),
    ...(adaptations[relative] ? { adaptation: adaptations[relative] } : {}) });
  // Examine emitted imports, so imports used only as TypeScript types are not
  // accidentally turned into runtime dependencies.
  for (const match of compiled.outputText.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const dependency = match[1];
    if (dependency.startsWith('@electron/internal/')) {
      compile(dependency.slice('@electron/internal/'.length));
    } else if (dependency.startsWith('.')) {
      compile(path.posix.normalize(path.posix.join(path.posix.dirname(id), dependency)));
    } else if (!['electron', 'electron/main'].includes(dependency) &&
               !require('node:module').isBuiltin(dependency)) {
      throw new Error(`Unexpected external dependency ${dependency} in ${relative}`);
    }
  }
}

fs.mkdirSync(output, { recursive: true });
for (const entry of entries) compile(entry);
fs.writeFileSync(path.join(output, 'package.json'), '{"type":"commonjs"}\n');
fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify({
  description: 'Electron fork sources compiled for replacement native bindings; scoped Weber adaptations are identified per source',
  entries, sources: sources.sort((a, b) => a.path.localeCompare(b.path)),
  linkedBindings: [...bindings].sort(),
}, null, 2) + '\n');
console.log(`Compiled ${sources.length} Electron source modules to ${output}`);
require('./platform-sync/build.cjs').build(output);

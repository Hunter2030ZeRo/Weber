'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const output = path.join(__dirname, 'dist');
fs.mkdirSync(output, { recursive: true });
esbuild.buildSync({ absWorkingDir: __dirname, entryPoints: {
  editor: 'editor.js', 'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
}, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  loader: { '.ttf': 'file' }, outdir: output, logLevel: 'info' });
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(output, 'index.html'));
const files = fs.readdirSync(output).sort().map(name => {
  const bytes = fs.readFileSync(path.join(output, name));
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
  monaco: require('monaco-editor/package.json').version,
  monacoSourceTag: 'v0.52.2', monacoSourceCommit: '404545bded1df6ffa41ea0af4e8ddb219018c6c1',
  esbuild: esbuild.version, applicationSourceModified: false, files,
}, null, 2));

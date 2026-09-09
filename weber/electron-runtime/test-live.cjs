'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

async function run() {
  if (process.platform !== 'linux') throw new Error('Native live test currently requires Linux');
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist/source-manifest.json')));
  for (const source of manifest.sources) {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(root, source.path))).digest('hex');
    assert.equal(hash, source.sha256, `Compiled API drift: ${source.path}`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weber-electron-live-'));
  const resultPath = path.join(temporary, 'result.json');
  const project = path.join(temporary, 'app');
  fs.cpSync(path.join(__dirname, 'fixture'), project, { recursive: true });
  const backend = process.versions.bun ? 'bun' : 'node';
  // This is the same application. Only the TOML backend selection changes.
  fs.writeFileSync(path.join(project, 'weber.toml'), `[backend]\nkind = '${backend}'\nentry = 'main.cjs'\n`);
  const launcher = process.env.WEBER_BACKEND_LAUNCHER;
  const executable = launcher || process.execPath;
  const args = launcher ? ['run', '--runtime-root', __dirname, '--project', project] :
    [path.join(__dirname, 'bootstrap.cjs'), project];
  const child = spawn(executable, args, {
    env: { ...process.env, WEBER_LIVE_RESULT: resultPath }, stdio: 'inherit', shell: false,
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 110000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(code, 0, report.error);
    assert.equal(report.ok, true, report.error);
    report.originalElectronModules = manifest.sources.length;
    report.backend = backend;
    report.tomlLauncher = Boolean(launcher);
    fs.writeFileSync(path.join(root, 'weber-electron-live-result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearTimeout(timeout);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

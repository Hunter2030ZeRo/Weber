import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const launcher = resolve('target/debug/weber');
const root = mkdtempSync(join(tmpdir(), 'weber-launcher-'));
try {
  writeFileSync(join(root, 'index.html'), '<h1>shared frontend</h1>');
  writeFileSync(join(root, 'main.mjs'), `console.log(JSON.stringify({backend:process.env.WEBER_BACKEND,frontend:process.env.WEBER_FRONTEND,args:process.argv.slice(2),cwd:process.cwd(),runtime:process.versions.bun?'bun':'node'}));`);
  // The native branch must launch a compiled Rust executable, not a script.
  // Reuse the CLI's --help mode as an independent native process probe.
  copyFileSync(launcher, join(root, 'native-probe'));
  chmodSync(join(root, 'native-probe'), 0o755);
  const config = `schema = 1
backend = "node"
[app]
frontend = "index.html"
channels = ["system.info"]
[node]
entry = "main.mjs"
args = ["space here", "$(literal)"]
[bun]
entry = "main.mjs"
args = ["space here", "$(literal)"]
[native]
binary = "native-probe"
args = ["--help"]
`;
  for (const backend of ['node', 'bun', 'native']) {
    // Switch only the TOML setting; command and working project stay the same.
    writeFileSync(join(root, 'weber.toml'), config.replace('backend = "node"', `backend = "${backend}"`));
    const run = spawnSync(launcher, ['run', '--project', root], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    if (backend === 'native') assert.match(run.stdout, /weber run/);
    else {
      const output = JSON.parse(run.stdout);
      assert.equal(output.runtime, backend);
      assert.equal(output.backend, backend);
      assert.equal(output.frontend, join(root, 'index.html'));
      assert.equal(output.cwd, root);
      assert.deepEqual(output.args, ['space here', '$(literal)']);
    }
  }
  console.log('TOML switching passed: actual Node, Bun and compiled Rust process launches');
} finally { rmSync(root, { recursive: true, force: true }); }

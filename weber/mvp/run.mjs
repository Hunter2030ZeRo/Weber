// Linux acceptance runner for a built Weber Electron executable.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const executable = process.argv[2];
if (!executable) throw new Error('Usage: node weber/mvp/run.mjs /absolute/path/to/built/weber');
if (process.platform !== 'linux') throw new Error('This acceptance runner currently targets Linux');
const temporary = await mkdtemp(join(tmpdir(), 'weber-mvp-'));
try {
  const resultFile = join(temporary, 'result.json');
  const child = spawn(resolve(executable), [fileURLToPath(new URL('./app', import.meta.url))], {
    stdio: 'inherit', shell: false,
    env: { ...process.env, WEBER_MVP_RESULT: resultFile },
    detached: true
  });
  let timedOut = false;
  const terminate = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, 60000);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally { clearTimeout(timer); terminate(); }
  if (timedOut) throw new Error('MVP process group exceeded 60 seconds');
  const report = JSON.parse(await readFile(resultFile, 'utf8'));
  if (exit.code !== 0 || !report.ok) throw new Error(report.error ?? JSON.stringify(exit));
  console.log('Electron app MVP execution contract passed. Full engine replacement still requires build/dependency and broader API review.');
} finally { await rm(temporary, { recursive: true, force: true }); }

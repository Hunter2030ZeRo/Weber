// Local release artifacts only: this script never publishes or downloads a runtime.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { root, sdkVersion, runtimePackageName } from '../sdk/toolchain.mjs';
import { atomicOutput, digest } from '../sdk/project.mjs';
import { copyRuntime } from '../sdk/runtime-package.mjs';

const execute = promisify(execFile);
const binary = resolve(process.argv[2] ?? join(root, 'target/package/weber-foundation-jit/weber'));
const output = join(root, 'target/npm');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Local native npm release is currently validated only for Linux x64');
const info = JSON.parse((await execute(binary, ['--build-info'])).stdout);
if (info.aotAvailable !== false) throw new Error('The default npm runtime must be a JIT-only build');
await atomicOutput(output, 'release.json', async staging => {
  const work = await mkdtemp(join(dirname(staging), '.weber-npm-'));
  try {
    const sdk = join(work, 'sdk'), runtime = join(work, 'runtime');
    await cp(join(root, 'sdk'), sdk, { recursive: true });
    await cp(join(root, 'examples'), join(sdk, 'templates'), { recursive: true, filter: path => !['node_modules', 'dist', 'package'].includes(path.split('/').at(-1)) });
    await copyRuntime(binary, runtime, info);
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: runtimePackageName, version: sdkVersion, private: true, description: 'Weber experimental Linux Wayland SpiderMonkey runtime', os: ['linux'], cpu: ['x64'], type: 'module', exports: { './package.json': './package.json' }, files: ['weber', 'lib', 'manifest.json', 'notices', 'patches', 'README.txt'] }, null, 2));
    const packages = [];
    for (const directory of [sdk, runtime]) {
      const logPath = join(work, 'npm-pack.json'), errorPath = join(work, 'npm-pack.log');
      const log = openSync(logPath, 'w'), errors = openSync(errorPath, 'w');
      const child = spawn('npm', ['pack', directory, '--pack-destination', staging, '--cache', '/tmp/weber-vite-npm-cache', '--json'], { stdio: ['ignore', log, errors] });
      closeSync(log); closeSync(errors);
      const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
      if (code !== 0) throw new Error(`npm pack failed (${code}): ${await readFile(errorPath, 'utf8')}`);
      const packed = JSON.parse(await readFile(logPath, 'utf8'));
      const [result] = Array.isArray(packed) ? packed : Object.values(packed);
      packages.push({ name: result.name, version: result.version, file: result.filename, sha256: digest(await readFile(join(staging, result.filename))), sizeBytes: result.size, unpackedBytes: result.unpackedSize, files: result.files.map(file => file.path) });
    }
    if ((await readdir(staging)).length !== 2) throw new Error('Unexpected npm release output');
    await writeFile(join(staging, 'release.json'), JSON.stringify({ schemaVersion: 1, sdkVersion, runtime: info, packages, published: false }, null, 2));
  } finally { await rm(work, { recursive: true, force: true }); }
});
console.log(`Local npm artifacts: ${output}`);

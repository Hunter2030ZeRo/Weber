import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sdk } from './toolchain.mjs';
import { inside, command, digest } from './project.mjs';

export async function buildBackend(project, config, destination) {
  if (config.backend === undefined) return undefined;
  if (typeof config.backend !== 'string' || !inside(project, resolve(project, config.backend))) throw new Error('backend must be an entry path inside the project');
  const bun = process.env.WEBER_BUN ?? 'bun';
  const version = (await promisify(execFile)(bun, ['--version'])).stdout.trim();
  const main = join(destination, '.backend-entry.mjs');
  await writeFile(main, `import { serve } from ${JSON.stringify(join(sdk, 'backend-runner.mjs'))};\nawait serve(() => import(${JSON.stringify(resolve(project, config.backend))}));\n`);
  try { await command(bun, ['build', '--compile', main, '--outfile', join(destination, 'backend')], { cwd: project }); }
  finally { await rm(main, { force: true }); }
  return { runtime: 'bun', bunVersion: version, file: 'backend', sha256: digest(await readFile(join(destination, 'backend'))) };
}

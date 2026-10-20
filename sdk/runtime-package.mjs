import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { root, checkout } from './toolchain.mjs';
import { command, digest, inside } from './project.mjs';

async function copyTree(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Runtime bundle must not contain symbolic links: ${source}`);
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) await copyTree(join(source, name), join(destination, name));
  } else if (stat.isFile()) await cp(source, destination);
  else throw new Error(`Unsupported runtime bundle file: ${source}`);
}

/** Copy a prepared, relocatable runtime. Never copy an embedded application. */
export async function copyRuntime(binary, destination, info) {
  const bundle = dirname(binary);
  const manifestPath = join(bundle, 'manifest.json');
  if (!existsSync(manifestPath)) {
    if (!checkout) throw new Error('WEBER_HOST must point to weber inside a prepared runtime bundle with manifest.json and lib/');
    // Keep the raw-binary developer bundler's source-directory protection intact.
    await mkdir(join(root, 'target'), { recursive: true });
    const temporary = await mkdtemp(join(root, 'target/sdk-runtime-'));
    try {
      await command('python3', ['scripts/package.py', '--profile', info.profile === 'debug' ? 'dev' : 'release', '--binary', binary, '--output', temporary]);
      await copyRuntime(join(temporary, 'weber'), destination, info);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isDeepStrictEqual(manifest.build, info)) throw new Error('Runtime manifest build information does not match the executable');
  if (!manifest.privateLibraries || typeof manifest.privateLibraries !== 'object' || Array.isArray(manifest.privateLibraries)) throw new Error('Invalid runtime library manifest');
  const files = new Map([['weber', manifest.executableSha256]]);
  for (const [name, library] of Object.entries(manifest.privateLibraries)) {
    if (!/^[\w+-][\w.+-]*$/.test(name)) throw new Error('Invalid runtime library name');
    files.set(`lib/${name}`, library.sha256);
  }
  const canonical = await realpath(bundle);
  for (const [file, hash] of files) {
    const path = resolve(bundle, file);
    if (!inside(canonical, await realpath(path)) || (await lstat(path)).isSymbolicLink()) throw new Error('Runtime file must be inside its bundle');
    if (typeof hash !== 'string' || digest(await readFile(path)) !== hash) throw new Error(`Runtime file hash mismatch: ${file}`);
  }
  if (resolve(binary) !== resolve(bundle, 'weber')) throw new Error('Prepared runtime executable must be named weber');
  await mkdir(destination, { recursive: true });
  for (const file of files.keys()) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await cp(join(bundle, file), join(destination, file));
  }
  for (const name of ['manifest.json', 'README.txt', 'notices', 'patches']) await copyTree(join(bundle, name), join(destination, name));
}

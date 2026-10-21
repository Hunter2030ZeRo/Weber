import { readFile, writeFile, mkdir, cp, readdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, join, dirname, sep } from 'node:path';
import { root, checkout, sdkVersion } from './toolchain.mjs';
import { copyRuntime } from './runtime-package.mjs';
import { metadata, check, withTarget, viteConfig, atomicOutput, inside, digest, command, host } from './project.mjs';
import { buildBackend } from './backend-build.mjs';
import { desktopEntry } from './launcher.mjs';

async function list(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await list(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported build output: ${path}`);
  }
  return files;
}
async function buildInto(project, destination, aot) {
  if (aot && !checkout) throw new Error('Experimental AOT compilation requires the Weber source checkout and Static Hermes toolchain; the npm SDK provides the SpiderMonkey JIT workflow');
  const { config, entry } = await metadata(project);
  await check(project);
  if (aot && process.platform !== 'linux') throw new Error('Native AOT compilation is currently implemented only on Linux');
  for (const engine of aot ? ['web', 'aot'] : ['web']) await withTarget(project, engine, async () => {
    const { vite, config: user } = await viteConfig(project, 'build');
    if (user.build?.watch || user.build?.rollupOptions?.input || user.build?.rollupOptions?.output) throw new Error('Weber owns the bundle input/output; Vite build.watch and custom Rollup input/output are not supported');
    const bundled = vite.mergeConfig(user, {
      base: '/',
      build: { target: user.build?.target ?? 'es2020', minify: user.build?.minify ?? false, outDir: destination, emptyOutDir: false },
    });
    bundled.build.lib = { entry, name: 'WeberApplicationBundle', formats: ['iife'], fileName: () => `${engine}.js`, cssFileName: 'style' };
    await vite.build(bundled);
  });
  const manifest = { schemaVersion: 1, id: config.id, name: config.name, version: config.version, assets: {} };
  const backend = await buildBackend(project, config, destination);
  if (backend) manifest.backend = backend;
  if (aot) {
    const { aotAbi } = await import('../scripts/aot-abi.mjs');
    await command(join(root, 'target/hermes/bin/shermes'), ['-O', '-Xes6-block-scoping', '-Wc,-O3', '-Wc,-fPIC', '-c', '-exported-unit=weber_application', '-o', join(destination, 'app.o'), join(destination, 'aot.js')]);
    await command('cc', ['-shared', join(destination, 'app.o'), '-L' + join(root, 'target/hermes/lib'), '-lhermesvm', '-Wl,-rpath,$ORIGIN/../lib', '-o', join(destination, 'app.so')]);
    manifest.engine = { hermesRevision: (await promisify(execFile)('git', ['-C', join(root, 'vendor/hermes'), 'rev-parse', 'HEAD'])).stdout.trim(), abi: await aotAbi() };
    manifest.nativeUnit = { file: 'app.so', sha256: digest(await readFile(join(destination, 'app.so'))) };
  }
  const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
  for (const file of await list(destination)) {
    const path = relative(destination, file).split(sep).join('/');
    if (['app.o', 'app.so', 'backend', 'app.json', 'aot.js', 'aot.js.map', 'build.json'].includes(path)) continue;
    const bytes = await readFile(file);
    if (bytes.length > 16 * 1024 * 1024) throw new Error(`Asset too large: ${path}`);
    manifest.assets['/' + encodeURI(path)] = { file: path, sha256: digest(bytes), mime: types[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream' };
  }
  if (!manifest.assets['/web.js']) throw new Error('Vite must emit web.js; custom library output names are not supported');
  await writeFile(join(destination, 'app.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(destination, 'build.json'), JSON.stringify({ sdkVersion, project, entry: config.entry, entrySha256: digest(await readFile(entry)), engines: aot ? ['web', 'aot'] : ['web'], nativeOptimization: aot ? 'O3' : null }, null, 2));
}
export async function build(project, destination, aot) {
  if (project === destination || inside(destination, project)) throw new Error('Build output must not replace application sources');
  await atomicOutput(destination, 'app.json', staging => buildInto(project, staging, aot));
  console.log(`Application ready (${aot ? 'AOT + JIT' : 'JIT'}): ${destination}`);
}
export async function packageApp(source, output) {
  if (source === output || inside(source, output) || inside(output, source)) throw new Error('Package output must be separate from compiled app');
  if (process.platform !== 'linux') throw new Error('Application packaging is currently implemented only on Linux');
  const manifest = JSON.parse(await readFile(join(source, 'app.json'), 'utf8'));
  const files = new Map(Object.values(manifest.assets).map(asset => [asset.file, asset.sha256]));
  if (manifest.nativeUnit) files.set(manifest.nativeUnit.file, manifest.nativeUnit.sha256);
  if (manifest.backend) files.set(manifest.backend.file, manifest.backend.sha256);
  const canonical = await realpath(source);
  for (const [file, hash] of files) {
    if (!inside(source, resolve(source, file)) || !inside(canonical, await realpath(join(source, file)))) throw new Error('Invalid package file');
    if (digest(await readFile(join(source, file))) !== hash) throw new Error(`Application file hash mismatch: ${file}`);
  }
  await atomicOutput(output, 'manifest.json', async staging => {
    const binary = host(Boolean(manifest.nativeUnit));
    const info = JSON.parse((await promisify(execFile)(binary, ['--build-info'])).stdout);
    if (manifest.nativeUnit && info.aotAvailable === false) throw new Error('Selected host has no AOT runtime; set WEBER_HOST to an AOT-enabled host');
    if (info.appIntegrationProtocol !== 1) throw new Error('This SDK alpha requires appIntegrationProtocol 1; select the matching alpha runtime');
    if (!manifest.nativeUnit && !info.sdkWorkflowVersion) throw new Error('Selected host does not support JIT-only app packages; rebuild Weber or set WEBER_HOST');
    if (manifest.backend && info.bunBackendProtocol !== 1) throw new Error('Selected host does not support the Bun backend protocol; rebuild Weber or set WEBER_HOST');
    await copyRuntime(binary, staging, info);
    const app = join(staging, 'application'); await mkdir(app, { recursive: true });
    for (const file of ['app.json', ...files.keys()]) { await mkdir(dirname(join(app, file)), { recursive: true }); await cp(join(source, file), join(app, file)); }
    await writeFile(join(staging, 'APPLICATION.txt'), `Run ./weber --app ./application\n${manifest.nativeUnit ? 'Web comparison: ./weber --app ./application --web\n' : 'SpiderMonkey JIT application; no native AOT module.\n'}`);
    await writeFile(join(staging, `${manifest.id}.desktop`), desktopEntry(output, manifest));
  });
  console.log(`Relocatable application package: ${output}`);
}

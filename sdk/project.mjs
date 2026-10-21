import { readFile, writeFile, mkdir, cp, readdir, mkdtemp, rename, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve, relative, join, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { importTool, resolveTool, root, sdk, checkout, sdkVersion, installedRuntime, runtimePackageName, packageDirectory } from './toolchain.mjs';
import { weber } from './vite.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const inside = (parent, path) => { const part = relative(parent, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
export const command = (program, args, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { cwd: root, stdio: 'inherit', ...options });
  child.once('error', reject);
  child.once('close', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${program} exited ${code ?? signal}`)));
});
export function host(aot = false, project = process.cwd()) {
  if (process.env.WEBER_HOST) return resolve(process.env.WEBER_HOST);
  const runtime = installedRuntime(project);
  if (runtime && !aot) return join(runtime, 'weber');
  const prepared = checkout && [
  ...(aot ? ['target/package/weber-platform-aot/weber'] : ['target/package/weber-clipboard-jit/weber', 'target/package/weber-foundation-jit/weber', 'target/package/weber-platform-jit/weber']),
  ...(aot ? ['target/package/weber-beta-aot/weber'] : ['target/package/weber-beta-jit/weber']),
  'target/package/weber-bun/weber', 'target/package/weber-vite/weber', 'target/debug/weber-servo', 'target/package/weber-framework/weber',
  ].map(path => join(root, path)).find(existsSync);
  if (prepared) return prepared;
  throw new Error(aot ? 'Experimental AOT requires a prepared source checkout and an AOT-enabled WEBER_HOST' : `Native runtime missing: install ${runtimePackageName} from the local Weber runtime tarball, or set WEBER_HOST to a prepared host`);
}
export async function metadata(project) {
  const config = JSON.parse(await readFile(join(project, 'weber.json'), 'utf8'));
  if (config.schemaVersion !== 1 || !/^[\w.-]{1,200}$/.test(config.id) || typeof config.name !== 'string' || !config.name || typeof config.version !== 'string' || typeof config.entry !== 'string') throw new Error('Invalid weber.json application metadata');
  const entry = resolve(project, config.entry);
  if (!inside(project, entry) || !inside(await realpath(project), await realpath(entry))) throw new Error('Application entry must be inside its project');
  return { config, entry };
}
export async function check(project) {
  const compiler = resolveTool('typescript/bin/tsc', project);
  if (existsSync(join(project, 'tsconfig.json'))) {
    await command(process.execPath, [compiler, '--project', join(project, 'tsconfig.json'), '--noEmit'], { cwd: project }); return;
  }
  // Compatibility for SDK 0.2 projects without their own TypeScript config.
  const directory = await mkdtemp(join(tmpdir(), 'weber-sdk-check-'));
  const solidRoot = packageDirectory('solid-js', project);
  const config = { compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve', jsxImportSource: 'solid-js', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], skipLibCheck: true,
    paths: { 'solid-js': [solidRoot], 'solid-js/*': [join(solidRoot, '*')], '@weber/runtime': [join(sdk, 'runtime.ts')], '@weber/solid': [join(sdk, 'solid.ts')], '@weber/dom': [join(sdk, 'dom.d.ts')] } },
    include: [join(project, '**/*.ts'), join(project, '**/*.tsx')], exclude: [join(project, 'dist'), join(project, 'node_modules')] };
  try { await writeFile(join(directory, 'tsconfig.json'), JSON.stringify(config)); await command(process.execPath, [compiler, '--project', join(directory, 'tsconfig.json')]); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
export async function withTarget(project, engine, work) {
  const previous = { WEBER_BUILD_ENGINE: process.env.WEBER_BUILD_ENGINE, WEBER_PROJECT_ROOT: process.env.WEBER_PROJECT_ROOT };
  process.env.WEBER_BUILD_ENGINE = engine; process.env.WEBER_PROJECT_ROOT = project;
  try { return await work(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
export async function viteConfig(project, action) {
  const vite = await importTool('vite', project);
  const loaded = await vite.loadConfigFromFile({ command: action, mode: action === 'serve' ? 'development' : 'production' }, undefined, project);
  const config = loaded?.config ?? {};
  const flatten = async plugins => (await Promise.all((plugins ?? []).map(async plugin => Array.isArray(await plugin) ? flatten(await plugin) : await plugin))).flat(Infinity).filter(Boolean);
  const plugins = await flatten(config.plugins);
  if (!plugins.some(plugin => plugin.name === 'weber:bindings')) {
    const hasSolid = plugins.some(plugin => plugin.name.startsWith('solid'));
    if (process.env.WEBER_BUILD_ENGINE === 'aot' && hasSolid) throw new Error('For AOT, replace solid() with weber() from @weber/sdk/vite');
    config.plugins = [...plugins, await weber({ project, solid: !hasSolid })];
  } else config.plugins = plugins;
  if (config.root && resolve(project, config.root) !== project) throw new Error('Weber currently requires the Vite root to be the application directory');
  return { vite, config: { ...config, root: project, configFile: false } };
}
export async function atomicOutput(destination, marker, work) {
  if (existsSync(destination) && (await readdir(destination)).length && !existsSync(join(destination, marker))) throw new Error('Output directory contains files from outside a recognized Weber build/package');
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.weber-build-')), backup = staging + '-previous';
  try {
    await work(staging);
    if (existsSync(destination)) await rename(destination, backup);
    try { await rename(staging, destination); }
    catch (error) { if (existsSync(backup)) await rename(backup, destination); throw error; }
    await rm(backup, { recursive: true, force: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function init(project, template) {
  if (!['solid', 'dom', 'node', 'windows', 'notes', 'workbench'].includes(template)) throw new Error('Template must be solid, dom, node, windows, notes or workbench');
  if (existsSync(project)) throw new Error('Project directory already exists');
  if (!checkout && !process.env.WEBER_SDK_SPEC) throw new Error(`This SDK preview is not published: set WEBER_SDK_SPEC=file:/absolute/path/to/weber-sdk-${sdkVersion}.tgz before init`);
  await cp(join(checkout ? root : sdk, checkout ? 'examples' : 'templates', template), project, { recursive: true, filter: source => !['dist', 'node_modules'].includes(source.split(sep).at(-1)) });
  const spec = JSON.parse(await readFile(join(sdk, 'defaults.json'), 'utf8'));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'weber-app', private: true, type: 'module', scripts: {
    dev: 'weber dev .', check: 'weber check .', build: 'weber build .', 'build:aot': 'weber build . --aot', start: 'weber run dist',
    package: 'npm run build && weber package dist package', 'package:aot': 'npm run build:aot && weber package dist package',
  }, dependencies: { 'solid-js': spec['solid-js'] }, devDependencies: { '@weber/sdk': process.env.WEBER_SDK_SPEC ?? `file:${sdk}`, vite: spec.vite, 'vite-plugin-solid': spec['vite-plugin-solid'], typescript: spec.typescript } }, null, 2));
  await writeFile(join(project, 'vite.config.mjs'), 'import { weber } from "@weber/sdk/vite";\nexport default { plugins: [weber()] };\n');
  await writeFile(join(project, 'index.html'), '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="aot-dom-root"></div><script type="module">import "./src/main.' + (template === 'dom' ? 'ts' : 'tsx') + '"; import { mount } from "@weber/sdk/dev"; mount();</script></body></html>\n');
  await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve', jsxImportSource: 'solid-js', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['vite/client'], skipLibCheck: true,
    paths: { '@weber/dom': ['./node_modules/@weber/sdk/dom.d.ts'], '@weber/runtime': ['./node_modules/@weber/sdk/runtime.ts'], '@weber/solid': ['./node_modules/@weber/sdk/solid.ts'], 'solid-js': ['./node_modules/solid-js'], 'solid-js/*': ['./node_modules/solid-js/*'] } }, include: ['src'] }, null, 2));
  await writeFile(join(project, '.gitignore'), 'node_modules/\ndist/\npackage/\n');
  console.log(`Created ${template} application: ${project}\nInstall dependencies with npm install, then npm run dev.`);
}

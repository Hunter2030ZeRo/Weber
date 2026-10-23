// Test the installed SDK tarball; no repository tool fallback or renderer shim.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
const directory = resolve('artifacts/frameworks');
const release = JSON.parse(await readFile('target/npm/release.json', 'utf8'));
const sdk = release.packages.find(pkg => pkg.name === '@weber/sdk');
const runtime = release.packages.find(pkg => pkg.name !== '@weber/sdk');
const cache = resolve('artifacts/npm-cache');
const results = [];
await mkdir(directory, { recursive: true });
await writeFile('artifacts/framework-workflow.json', JSON.stringify({ passed: false }));
async function run(name, args, cwd, expected = 0) {
  const path = join(directory, name + '.log'), log = openSync(path, 'w');
  const child = spawn(args[0], args.slice(1), { cwd, env: { ...process.env, WEBER_SDK_SPEC: `file:${resolve('target/npm', sdk.file)}` }, stdio: ['ignore', log, log] });
  closeSync(log);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  const text = await readFile(path, 'utf8');
  assert.equal(code, expected, text);
  return text;
}
// Bootstrap from the packed SDK itself, including its shipped templates.
const bootstrap = join(directory, 'bootstrap');
await rm(bootstrap, { recursive: true, force: true }); await mkdir(bootstrap);
await run('unpack', ['tar', '-xzf', resolve('target/npm', sdk.file), '-C', bootstrap], directory);
for (const template of ['dom', 'solid', 'react', 'vue']) {
  const project = join(directory, template), moved = join(directory, template + '-relocated');
  await rm(project, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true });
  await run(template + '-init', [process.execPath, join(bootstrap, 'package/cli.mjs'), 'init', project, template], directory);
  await run(template + '-install', ['npm', 'install', '--save-dev', `file:${resolve('target/npm', runtime.file)}`, '--cache', cache, '--no-audit', '--no-fund', ...(process.env.WEBER_OFFLINE === '1' ? ['--offline'] : [])], project);
  const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'));
  const solidInstalled = Object.keys(lock.packages).some(name => /node_modules\/(solid-js|vite-plugin-solid)$/.test(name));
  assert.equal(solidInstalled, template === 'solid');
  const dependencies = Object.fromEntries(Object.entries(lock.packages).filter(([name]) => ['react','react-dom','vue','vite','typescript','vue-tsc','@vitejs/plugin-react','@vitejs/plugin-vue','solid-js'].some(pkg => name === 'node_modules/' + pkg)).map(([name, pkg]) => [name.slice(13), pkg.version]));
  const entry = JSON.parse(await readFile(join(project, 'weber.json'))).entry;
  await cp('scripts/framework-probe.ts', join(project, 'src/framework-probe.ts'));
  const main = join(project, entry);
  await writeFile(main, await readFile(main, 'utf8') + '\nimport "./framework-probe";\n');
  await run(template + '-check', ['npm', 'run', 'check'], project);
  if (template === 'dom' || template === 'solid') {
    const tsconfigPath = join(project, 'tsconfig.json'), tsconfig = await readFile(tsconfigPath);
    try {
      await rm(tsconfigPath);
      await run(template + '-check-no-tsconfig', ['npm', 'run', 'check'], project);
    } finally { await writeFile(tsconfigPath, tsconfig); }
  }
  if (['react', 'vue'].includes(template)) {
    const component = join(project, 'src', template === 'vue' ? 'App.vue' : 'App.tsx');
    const source = await readFile(component, 'utf8');
    try {
      await writeFile(component, source.replace(template === 'vue' ? 'count++' : 'setCount(previous => previous + 1)', 'count.missingMethod()'));
      assert.match(await run(template + '-type-error', ['npm', 'run', 'check'], project, 1), /missingMethod/);
    } finally { await writeFile(component, source); }
    assert.match(await run(template + '-aot-rejected', [process.execPath, join(project, 'node_modules/@weber/sdk/cli.mjs'), 'build', '.', 'aot-rejected', '--aot'], project, 1), /React\/Vue use the SpiderMonkey JIT path/);
  }
  // Existing Vite configs need not include Weber's plugin explicitly.
  const configPath = join(project, 'vite.config.mjs'), config = await readFile(configPath, 'utf8');
  try {
    const external = template === 'solid' ? 'import solid from "vite-plugin-solid";\nexport default { plugins: [solid()] };\n' : config.replace('weber()', 'false');
    await writeFile(configPath, external);
    await run(template + '-build-auto-bindings', ['npm', 'run', 'build'], project);
  } finally { await writeFile(configPath, config); }
  const mainSource = await readFile(main, 'utf8');
  try {
    await writeFile(main, mainSource + '\nimport "node:fs";\n');
    assert.match(await run(template + '-node-ui-rejected', [process.execPath, join(project, 'node_modules/@weber/sdk/cli.mjs'), 'build', project, join(project, 'node-rejected')], directory, 1), /Node.js runtime API "node:fs" is not available/);
  } finally { await writeFile(main, mainSource); }
  // Exercise the public generated package script and its automatic build/check.
  await run(template + '-package', ['npm', 'run', 'package'], project);
  await cp(join(project, 'package'), moved, { recursive: true });
  const info = JSON.parse(await run(template + '-runtime-info', [join(moved, 'weber'), '--build-info'], project));
  assert.deepEqual(info, release.runtime);
  const manifest = JSON.parse(await readFile(join(moved, 'application/app.json')));
  assert.equal(manifest.nativeUnit, undefined); assert.equal(manifest.backend, undefined);
  results.push({ template, project, package: moved, dependencies, solidInstalled, typeCheck: true, packaged: true, automaticBindings: true, ...(template === 'react' || template === 'vue' ? { componentTypeErrorRejected: true, aotRejected: true } : {}) });
  console.log(template + ': installed SDK, type check, build, package passed');
}
await writeFile('artifacts/framework-workflow.json', JSON.stringify({ passed: true, sdkVersion: release.sdkVersion, sdkSha256: sdk.sha256, runtime: release.runtime, results }, null, 2));

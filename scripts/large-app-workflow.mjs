// Build an isolated workload with the existing checkout SDK and pinned UI tools.
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { command } from '../sdk/project.mjs';

const project = resolve('artifacts/large-app/project'); await mkdir(join(project, 'src'), { recursive: true });
const source = resolve('compatibility/large-app');
const profile = await readFile(join(source, 'profile.json'));
const profileSha256 = createHash('sha256').update(profile).digest('hex');
assert.equal(profileSha256, (await readFile(join(source, 'profile.sha256'), 'utf8')).trim(), 'Compatibility profile lock changed');
for (const [file, expected] of Object.entries(JSON.parse(profile).sources)) {
  assert.equal(createHash('sha256').update(await readFile(join(source, file))).digest('hex'), expected, `Locked workload source changed: ${file}`);
}
const tools = {};
for (const [name, expected] of [['vite', '7.1.12'], ['typescript', '5.9.3']]) {
  tools[name] = JSON.parse(await readFile(`app/node_modules/${name}/package.json`)).version;
  assert.equal(tools[name], expected, `Unexpected ${name} version`);
}
await cp(join(source, 'main.ts'), join(project, 'src/main.ts'));
await cp(join(source, 'profile.json'), join(project, 'src/profile.json'));
await cp(join(source, 'public'), join(project, 'public'), { recursive: true });
// An empty valid wasm module: this checks loading/instantiation, not an editor's
// grammar/tokenizer workload or wasm feature coverage.
await writeFile(join(project, 'public/empty.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
try { await symlink(resolve('app/node_modules'), join(project, 'node_modules'), 'dir'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module', devDependencies: { vite: '7.1.12', typescript: '5.9.3' } }, null, 2));
await writeFile(join(project, 'weber.json'), JSON.stringify({ schemaVersion: 1, id: 'dev.weber.large-app-test', name: 'Weber large-app compatibility', version: '0.1.0', entry: 'src/main.ts' }, null, 2));
await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', resolveJsonModule: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], skipLibCheck: true, paths: { '@weber/runtime': [resolve('sdk/runtime.ts')] } }, include: ['src'] }, null, 2));
await command(process.execPath, ['sdk/cli.mjs', 'build', project]);
const manifest = JSON.parse(await readFile(join(project, 'dist/app.json')));
const assets = Object.fromEntries(Object.entries(manifest.assets).map(([route, asset]) => [route, { mime: asset.mime, sha256: asset.sha256 }]));
await writeFile('artifacts/large-app/workflow.json', JSON.stringify({ passed: true, application: join(project, 'dist'), profile: JSON.parse(profile).id, profileSha256, tools, assets }, null, 2));
console.log('Large-app fixture built; native browser behavior is not yet certified.');

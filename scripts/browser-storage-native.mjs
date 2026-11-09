import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { launch, execute } from './native-desktop.mjs';

assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
assert.ok(process.env.XDG_DATA_HOME?.startsWith('/tmp/weber-wayland-'), 'Only the owned disposable browser profile');
const fixture = JSON.parse(await readFile('artifacts/browser-storage/workflow.json'));
const profileBytes = await readFile('compatibility/browser-storage/profile.json'), profile = JSON.parse(profileBytes);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(fixture.profileSha256, digest(profileBytes));
assert.equal(fixture.profileSha256, (await readFile('compatibility/browser-storage/profile.sha256', 'utf8')).trim());
for (const [file, hash] of Object.entries(profile.sources)) assert.equal(digest(await readFile(join('compatibility/browser-storage', file))), hash);
const binary = resolve(process.env.WEBER_HOST || 'target/optimized/release/weber-servo');
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout);
const ids = { a: 'dev.weber.browser-storage-a', b: 'dev.weber.browser-storage-b' };
const origin = id => { const hash = digest(id); return `weber-app://${hash.slice(0,32)}.${hash.slice(32)}.app:0`; };
const values = { a: '한글 A ' + randomUUID(), b: '한글 B ' + randomUUID() };
const scenarios = [
  ['write-a','a','write',values.a], ['read-a','a','read',values.a], ['empty-b','b','read',null],
  ['write-b','b','write',values.b], ['read-b','b','read',values.b], ['reread-a','a','read',values.a],
  ['upgrade-a','a','upgrade',values.a], ['older-version-rejected','a','old-version',null],
  ['delete-a','a','delete',null], ['delete-missing-a','a','delete-missing',null], ['empty-a','a','read',null], ['reread-b','b','read',values.b],
];
assert.deepEqual(scenarios.map(([step]) => step), profile.required);
const runs = [], output = 'artifacts/browser-storage/native.json';
await writeFile(output, JSON.stringify({ passed: false, build, runs }));
try {
  for (const [step, appId, command, expected] of scenarios) {
    const application = resolve('artifacts/browser-storage/cases', step); await mkdir(application, { recursive: true });
    await cp(fixture.application, application, { recursive: true });
    const manifest = JSON.parse(await readFile(join(application, 'app.json'))); manifest.id = ids[appId];
    const bytes = JSON.stringify({ step, command, expected, foreignOrigin: origin(ids[appId === 'a' ? 'b' : 'a']) });
    await writeFile(join(application, 'scenario.json'), bytes);
    manifest.assets['/scenario.json'].sha256 = digest(bytes);
    await writeFile(join(application, 'app.json'), JSON.stringify(manifest, null, 2));
    let app;
    try {
      app = await launch({ binary, engine: 'web', application, name: `browser-storage-${step}` });
      const result = (await app.waitEvent(event => event.data.stage === 'browser-storage-result', step, 25000)).data;
      assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.step, step);
      assert.equal(result.profile, profile.id); assert.equal(result.origin, origin(ids[appId]));
      await app.waitEvent(event => event.data.stage === 'first-app-present', 'native browser storage presentation');
      assert.equal((await app.waitExit()).code, 0);
      runs.push({ step, applicationId: ids[appId], ...result, trace: app.path });
      console.log(`${step}: persisted/isolation acceptance passed`);
    } finally { if (app) await app.stop(); }
  }
  const profiles = [];
  for (const id of Object.values(ids)) {
    const path = join(process.env.XDG_DATA_HOME, 'weber/apps', digest(id), 'data/browser-profile');
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    const files = await readdir(path, { recursive: true }); assert.ok(files.some(name => name.endsWith('indexeddb.sqlite')), 'Durable database file missing');
    profiles.push({ applicationId: id, path, files });
  }
  assert.notEqual(profiles[0].path, profiles[1].path);
  await writeFile(output, JSON.stringify({ passed: true, profile: profile.id, profileSha256: fixture.profileSha256, build, display: process.env.WEBER_TEST_DISPLAY, runs, profiles, scope: 'Packaged native apps, stable distinct origins and private persistent profiles, sequential process restarts, independent A/B records, binary data, worker reads, schema upgrade/version rejection and deletion. No whole IndexedDB conformance, concurrent multi-process writers, production quota/recovery, OS sandbox or performance claim. Disposable profile paths are removed by the private display runner.' }, null, 2));
} catch (error) { await writeFile(output, JSON.stringify({ passed: false, profile: profile.id, build, runs, error: String(error) }, null, 2)); throw error; }

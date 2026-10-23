import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { NativeKeys, launch, execute, waitFor, readEvents, delay } from './native-desktop.mjs';

assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated Hyprland'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const workflow = JSON.parse(await readFile('artifacts/framework-workflow.json', 'utf8'));
assert.equal(workflow.passed, true);
const results = [];
await writeFile('artifacts/framework-native.json', JSON.stringify({ passed: false }));
const dir = join(process.env.XDG_CONFIG_HOME, 'fcitx5'); await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'profile'), '[Groups/0]\nName=Default\nDefault Layout=kr-kr104\nDefaultIM=hangul\n[Groups/0/Items/0]\nName=keyboard-kr-kr104\n[Groups/0/Items/1]\nName=hangul\n[GroupOrder]\n0=Default\n');
await writeFile(join(dir, 'config'), '[Hotkey/TriggerKeys]\n0=Hangul\n');
const fd = openSync('artifacts/framework-fcitx.log', 'w');
const fcitx = spawn('fcitx5', ['--disable=xcb,classicui,notifications,ibusfrontend'], { stdio: ['ignore', fd, fd] }); closeSync(fd);
let keys, app, dev;
const state = async () => (await app.events()).filter(event => event.data.stage === 'framework-state').at(-1)?.data;
const expect = async (predicate, label) => waitFor(async () => {
  const events = await app.events();
  const failure = events.find(event => ['failure', 'error', 'application-error'].includes(event.data.stage));
  if (failure) throw new Error(JSON.stringify(failure));
  const current = await state(); return current && predicate(current) ? current : null;
}, label, 25000);
async function hangul() {
  await waitFor(async () => {
    try { return /frontend:wayland[^ ]* cap:\S+ focus:1/.test((await execute('gdbus', ['call', '--session', '--dest', 'org.fcitx.Fcitx5', '--object-path', '/controller', '--method', 'org.fcitx.Fcitx.Controller1.DebugInfo'])).stdout); }
    catch { return false; }
  }, 'focused Fcitx Wayland context');
  await execute('fcitx5-remote', ['-s', 'hangul']); await execute('fcitx5-remote', ['-o']);
  await waitFor(async () => (await execute('fcitx5-remote', ['-n'])).stdout.trim() === 'hangul' && (await execute('fcitx5-remote', [])).stdout.trim() === '2', 'Hangul engine active');
}
async function descendants(pid) {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number);
  return [pid, ...(await Promise.all(children.map(descendants))).flat()];
}
try {
  keys = await NativeKeys.open();
  for (const fixture of workflow.results) {
    const { template, project, package: bundle } = fixture;
    // Only the native app gets an empty executable search path; the input driver
    // retains its normal tools. Node/npm/Bun cannot start inside the package.
    const path = process.env.PATH;
    try { process.env.PATH = '/nonexistent-weber-test'; app = await launch({ binary: join(bundle, 'weber'), application: join(bundle, 'application'), engine: 'web', name: `framework-${template}` }); }
    finally { process.env.PATH = path; }
    keys.app = app;
    await expect(() => true, template + ' component mounted');
    await app.waitEvent(event => event.data.stage === 'ready', template + ' host ready'); await keys.activate();
    if (template !== 'dom') {
      await keys.key(65); await keys.key(57); await keys.key(28);
      const count = await expect(s => s.count === 'Count: 2' && s.width === '22px', template + ' native button activation');
      assert.equal(count.buttons, 1);
    }
    await keys.key(64);
    await app.waitEvent(event => event.data.stage === 'first-app-present', template + ' presented with focused control');
    await hangul();
    for (const code of [34, 37, 31, 19, 50, 33, 57]) await keys.key(code);
    const typed = await expect(s => s.value === '한글 ' && (template === 'dom' || s.greeting === '한글 '), template + ' framework-controlled Hangul input');
    assert.ok(typed.trustedInputs > 0 && typed.compositions > 0);
    if (template === 'dom') {
      await keys.key(65); await keys.key(28);
      await expect(s => s.notes.join('') === '한글 ' && s.value === '', 'vanilla note insertion');
    }
    // Fcitx Hangul reserves F9 for Hanja; leave the editable context before
    // exercising fixture-only control keys.
    await keys.key(65); await execute('fcitx5-remote', ['-c']);
    await keys.key(67); const native = await expect(s => s.sdk, template + ' native window/storage APIs');
    await keys.key(66);
    const remounted = await expect(s => s.remounts === 1 && s.value === '' && (template === 'dom' ? s.notes.length === 0 : s.count === 'Count: 0'), template + ' disposal and remount');
    assert.equal(remounted.buttons, 1);
    if (template !== 'dom') {
      await keys.key(65); await keys.key(57); await expect(s => s.count === 'Count: 1', 'one handler after remount');
    }
    await keys.key(68); assert.equal((await app.waitExit()).code, 0); await app.stop(); app = null;
    results.push({ template, mode: 'relocated-package', passed: true, noNodeOrBunPath: true, typed, nativeApis: native.sdk, remounted, trace: resolve(`artifacts/framework-${template}.jsonl`) });
    console.log(template + ': native OS buttons, real Hangul, SDK storage/window, remount passed');

    const telemetry = resolve(`artifacts/framework-${template}-dev.jsonl`), logPath = resolve(`artifacts/framework-${template}-dev.log`);
    await writeFile(telemetry, '');
    const log = openSync(logPath, 'w');
    dev = spawn('npm', ['run', 'dev'], { cwd: project, detached: true, env: { ...process.env, WEBER_TELEMETRY: telemetry }, stdio: ['ignore', log, log] }); closeSync(log);
    const completion = new Promise((done, reject) => { dev.once('error', reject); dev.once('close', (code, signal) => done({ code, signal })); }); completion.catch(() => {});
    const cssPath = join(project, 'src/style.css'), css = await readFile(cssPath, 'utf8');
    const componentFile = { react: 'App.tsx', vue: 'App.vue', svelte: 'App.svelte', angular: 'app.html' }[template];
    const componentPath = componentFile ? join(project, 'src', componentFile) : null;
    const component = componentPath ? await readFile(componentPath, 'utf8') : null;
    try {
      const pid = await waitFor(async () => {
        if (dev.exitCode !== null) throw new Error(await readFile(logPath, 'utf8'));
        const own = await descendants(dev.pid);
        return JSON.parse((await execute(process.env.WEBER_TEST_HYPRCTL, ['-j', 'clients'])).stdout).find(client => own.includes(Number(client.pid)))?.pid;
      }, template + ' Vite native host', 30000);
      app = { child: { pid: Number(pid), exitCode: null }, events: () => readEvents(telemetry) }; keys.app = app;
      const first = await expect(() => true, 'development component ready'); await keys.activate();
      if (template !== 'dom') { await keys.key(65); await keys.key(57); await expect(s => s.count === 'Count: 1', 'development native button'); }
      await writeFile(cssPath, css + '\n#counter, #add { color: rgb(12, 34, 56); }\n');
      const styled = await expect(s => s.color === 'rgb(12, 34, 56)', template + ' CSS HMR');
      const cssPreservesPageAndState = styled.page === first.page && (template === 'dom' || styled.count === 'Count: 1');
      if (template !== 'angular') assert.equal(cssPreservesPageAndState, true);
      else if (styled.page !== first.page) {
        assert.equal(styled.count, 'Count: 0');
        await keys.key(65); await keys.key(57); await expect(s => s.count === 'Count: 1', 'Angular remains interactive after reload');
      }
      let refreshed, interactiveAfterUpdate;
      if (componentPath) {
        await writeFile(componentPath, component.replace('Counter</h1>', 'Updated Counter</h1>'));
        refreshed = await expect(s => s.heading?.includes('Updated Counter'), template + ' official component HMR');
        if (['react', 'vue'].includes(template)) { assert.equal(refreshed.page, first.page); assert.equal(refreshed.count, 'Count: 1'); }
      }
      if (refreshed) {
        const count = Number(refreshed.count?.match(/^Count: (\d+)$/)?.[1]);
        assert.ok(Number.isSafeInteger(count));
        await keys.key(65); await keys.key(57);
        interactiveAfterUpdate = await expect(s => s.count === `Count: ${count + 1}`, template + ' remains interactive after source update');
      }
      await keys.key(68);
      const exit = await waitFor(async () => dev.exitCode !== null ? await completion : null, 'Vite exits with native window');
      assert.equal(exit.code, 0);
      const output = await readFile(logPath, 'utf8');
      const url = output.match(/Weber development \(SpiderMonkey\): (http:\/\/\S+)/)?.[1]; assert.ok(url); await assert.rejects(fetch(url));
      results.push({ template, mode: 'npm-run-dev', passed: true, first, styled, refreshed, interactiveAfterUpdate, cssPreservesPageAndState, cssReloadedPage: styled.page !== first.page, componentHmrPreservesPageAndState: Boolean(refreshed && refreshed.page === first.page && refreshed.count === 'Count: 1'), componentReloadedPage: Boolean(refreshed && refreshed.page !== first.page), serverClosedWithWindow: true, trace: telemetry });
      console.log(template + ': native Vite CSS' + (refreshed ? '/component' : '') + ' HMR and cleanup passed');
    } finally {
      if (dev.exitCode === null) { process.kill(-dev.pid, 'SIGTERM'); await completion; }
      await writeFile(cssPath, css); if (componentPath) await writeFile(componentPath, component);
      dev = null; app = null;
    }
  }
  await writeFile('artifacts/framework-native.json', JSON.stringify({ passed: true, sdkVersion: workflow.sdkVersion, runtime: workflow.runtime, display: process.env.WEBER_TEST_DISPLAY, results, scope: 'Actual Servo/SpiderMonkey native windows, virtual Wayland OS keys and real Fcitx5 Hangul. Observer probes are not performance measurements or physical-human keyboard coverage; SSR and arbitrary third-party components are not established.' }, null, 2));
} catch (error) {
  await writeFile('artifacts/framework-native.json', JSON.stringify({ passed: false, results, error: String(error), state: app ? await state() : null }, null, 2)); throw error;
} finally {
  if (keys) await keys.close();
  if (app?.stop) await app.stop();
  if (dev?.exitCode === null) process.kill(-dev.pid, 'SIGTERM');
  if (fcitx.exitCode === null) fcitx.kill();
}

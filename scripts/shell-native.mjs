import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { NativeKeys, execute, launch, waitFor, readEvents, delay } from './native-desktop.mjs';
import { createHyprlandClient } from '../sdk/hyprland.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated Hyprland'));
assert.ok(!process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/'));
const fixture = JSON.parse(await readFile('artifacts/shell-workflow.json'));
assert.equal(fixture.passed, true);
const binary = join(fixture.package, 'weber'), application = join(fixture.package, 'application');
const hyprland = createHyprlandClient(), results = [];
const control = async name => JSON.parse((await execute(process.env.WEBER_TEST_HYPRCTL, ['-j', name])).stdout);
const telemetry = resolve('artifacts/shell-panel.jsonl'); await writeFile(telemetry, '');
const events = () => readEvents(telemetry);
const state = async mode => (await events()).filter(event => event.data.stage === 'shell-state' && event.data.mode === mode).at(-1)?.data;
async function expect(mode, predicate, message) {
  return waitFor(async () => {
    const failure = (await events()).find(e => ['failure', 'application-error'].includes(e.data.stage));
    if (failure) throw new Error(JSON.stringify(failure));
    const value = await state(mode); return value && predicate(value) ? value : null;
  }, message, 25000);
}
const dir = join(process.env.XDG_CONFIG_HOME, 'fcitx5'); await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'profile'), '[Groups/0]\nName=Default\nDefault Layout=kr-kr104\nDefaultIM=hangul\n[Groups/0/Items/0]\nName=keyboard-kr-kr104\n[Groups/0/Items/1]\nName=hangul\n[GroupOrder]\n0=Default\n');
const fc = openSync('artifacts/shell-fcitx.log', 'w'); const fcitx = spawn('fcitx5', ['--disable=xcb,classicui,notifications,ibusfrontend'], { stdio: ['ignore', fc, fc] }); closeSync(fc);
let keys, panel, target, ended;
const layer = async () => Object.values(await control('layers')).flatMap(m => Object.values(m.levels ?? {}).flat()).find(l => l.namespace === 'weber-panel' && Number(l.pid) === panel.pid);
async function click(point) {
  const own = await layer(); assert.ok(own, 'owned panel still mapped');
  assert.ok(point && point.x >= 0 && point.x < own.w && point.y >= 0 && point.y < own.h);
  const monitors = await control('monitors'); assert.equal(monitors.length, 1); assert.equal(monitors[0].scale, 1);
  await keys.command({ point: [Math.round(own.x + point.x), Math.round(own.y + point.y), monitors[0].width, monitors[0].height] });
  await delay(80);
  await keys.command({ button: 272, pressed: true }); await delay(40); await keys.command({ button: 272, pressed: false });
}
try {
  keys = await NativeKeys.open();
  target = await launch({ binary, application: resolve('artifacts/frameworks/dom-relocated/application'), engine: 'web', name: 'shell-target' });
  await target.waitEvent(e => e.data.stage === 'ready', 'ordinary target app ready');
  const targetInfo = await waitFor(async () => (await control('clients')).find(c => Number(c.pid) === target.child.pid), 'target client');
  const fd = openSync('artifacts/shell-panel.log', 'w');
  panel = spawn(binary, ['--panel-app', application], { cwd: fixture.package, env: { ...process.env, PATH: '/nonexistent-weber-test', WEBER_TELEMETRY: telemetry }, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const completion = new Promise((done, reject) => { panel.once('error', reject); panel.once('close', (code, signal) => { ended = { code, signal }; done(ended); }); }); completion.catch(() => {});
  const mapped = await waitFor(layer, 'actual owned layer-shell panel'); assert.equal(mapped.h, 48); assert.equal(mapped.w, 960);
  const first = await expect('panel', s => s.connected === 'true', 'live Hyprland snapshot reaches panel DOM');
  assert.equal((await control('activewindow')).pid, target.child.pid, 'panel does not steal keyboard focus');
  assert.ok((await control('clients')).find(c => Number(c.pid) === target.child.pid).at[1] >= 48, 'top exclusive zone constrains ordinary windows');
  results.push({ name: 'native panel / exclusive zone / no keyboard theft / live IPC', passed: true, mapped, state: first });
  await click(first.workspace2);
  await waitFor(async () => (await hyprland.snapshot()).monitors[0].activeWorkspace === 2, 'real workspace changes through panel click');
  const switched = await expect('panel', s => s.workspace === '2' && s.clicks >= 1, 'compositor event reaches UI');
  results.push({ name: 'trusted pointer click switches real Hyprland workspace', passed: true, state: switched });
  await click(switched.launcher);
  const launcher = await waitFor(async () => (await control('clients')).find(c => c.pid !== target.child.pid && c.title === 'Shell Launcher · Weber'), 'normal launcher window');
  keys.app = { child: { pid: launcher.pid, exitCode: null }, events };
  await expect('launcher', s => s.connected === 'true', 'launcher connected'); await keys.activate(); await keys.key(64);
  await waitFor(async () => /frontend:wayland[^ ]* cap:\S+ focus:1/.test((await execute('gdbus', ['call', '--session', '--dest', 'org.fcitx.Fcitx5', '--object-path', '/controller', '--method', 'org.fcitx.Fcitx.Controller1.DebugInfo'])).stdout), 'launcher Wayland IME context');
  await execute('fcitx5-remote', ['-s', 'hangul']); await execute('fcitx5-remote', ['-o']);
  await waitFor(async () => (await execute('fcitx5-remote', [])).stdout.trim() === '2', 'Hangul active');
  for (const code of [34, 37, 31, 19, 50, 33, 57]) await keys.key(code);
  const korean = await expect('launcher', s => s.query === '한글 ' && s.inputs > 0 && s.compositions > 0, 'actual Hangul launcher search');
  results.push({ name: 'panel opens ordinary IME-capable launcher; real Hangul search', passed: true, state: korean });
  await execute('fcitx5-remote', ['-c']); await keys.key(30, [29]); await keys.key(14);
  for (const code of [49, 24, 20, 18, 31]) await keys.key(code); // notes
  await expect('launcher', s => s.query === 'notes' && s.windows.length === 1 && s.windows[0].address === targetInfo.address, 'target window filter');
  await keys.key(15); await keys.key(28);
  await waitFor(async () => (await control('activewindow')).address === targetInfo.address, 'launcher activates target window across workspaces');
  await waitFor(async () => !(await control('clients')).some(c => c.pid === launcher.pid), 'launcher closes after selection');
  const focused = await expect('panel', s => s.workspace === '1' && s.status === 'Notes · Weber', 'panel sees selected window/workspace');
  results.push({ name: 'keyboard selection focuses actual app and closes launcher', passed: true, state: focused });
  // Leave a second owned launcher alive to verify panel-close group cleanup.
  await click(focused.launcher);
  const second = await waitFor(async () => (await control('clients')).find(c => c.pid !== target.child.pid && c.title === 'Shell Launcher · Weber'), 'second launcher');
  const last = await expect('panel', s => s.connected === 'true', 'panel stays active');
  const owned = async pid => {
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number);
    return [pid, ...(await Promise.all(children.map(owned))).flat()];
  };
  const ownedPids = await owned(panel.pid);
  assert.ok(ownedPids.includes(second.pid));
  await click(last.stop);
  await waitFor(() => ended, 'panel close'); assert.equal((await completion).code, 0);
  await waitFor(async () => !(await control('clients')).some(c => c.pid === second.pid), 'panel owns and cleans up launcher');
  await waitFor(async () => {
    for (const pid of ownedPids) {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
      if (stat && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z') return false;
    }
    return true;
  }, 'no live panel/backend/launcher descendants');
  assert.equal(await layer(), undefined);
  assert.match(await readFile('artifacts/shell-panel.log', 'utf8'), /"stage":"layer-frame"/);
  results.push({ name: 'normal panel close releases role, backend and owned launcher', passed: true, ownedPids, noLiveDescendants: true });
  await writeFile('artifacts/shell-native.json', JSON.stringify({ passed: true, sdkVersion: fixture.sdkVersion, runtime: fixture.runtime, display: process.env.WEBER_TEST_DISPLAY, results, scope: 'Single output 960x720 scale 1, actual layer-shell surface and virtual Wayland pointer/keyboard, real Fcitx5 Hangul and real Hyprland sockets. Not a complete desktop, physical-device, multimonitor or renderer-recovery certification.' }, null, 2));
  console.log('Shell native: panel, exclusive zone, trusted pointer, real IPC/workspaces, launcher Hangul, window selection and process cleanup passed');
} catch (error) {
  await writeFile('artifacts/shell-native.json', JSON.stringify({ passed: false, results, error: String(error), panel: await state('panel'), launcher: await state('launcher') }, null, 2)); throw error;
} finally {
  if (keys) await keys.close();
  if (target) await target.stop();
  if (panel && !ended) panel.kill('SIGTERM');
  if (fcitx.exitCode === null) fcitx.kill();
}

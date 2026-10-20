import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, execute, NativeKeys, waitFor, delay } from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
const binary = resolve(process.argv[2] ?? 'target/package/weber-activation-jit/weber');
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout);
assert.equal(build.activationProtocol, 1);
const fixture = JSON.parse(await readFile('artifacts/activation-workflow.json', 'utf8'));
await writeFile('artifacts/activation-native.json', JSON.stringify({ passed: false, build }));
const log = openSync('artifacts/activation-peer.log', 'w');
const peer = spawn('/usr/bin/python3', [resolve('scripts/activation-peer.py')], { stdio: ['pipe', 'pipe', log] }); closeSync(log);
let peerFocus = false, token, ready = false, app, keys;
const peerCompletion = new Promise((done, reject) => { peer.once('error', reject); peer.once('exit', done); }); peerCompletion.catch(() => {});
createInterface({ input: peer.stdout }).on('line', line => {
  const value = JSON.parse(line);
  if ('focus' in value) peerFocus = value.focus;
  if (value.ready) ready = true;
  if (value.token) token = value.token;
});
async function rawKey(code, modifiers = []) {
  for (const keycode of modifiers) await keys.command({ keycode, pressed: true });
  try { await keys.command({ keycode: code, pressed: true }); await keys.command({ keycode: code, pressed: false }); }
  finally { for (const keycode of modifiers.reverse()) await keys.command({ keycode, pressed: false }); }
}
const latestFocus = async id => (await app.events()).filter(event => event.data.stage === 'window-focus' && event.data.windowId === id).at(-1)?.data.focused;
try {
  await waitFor(() => ready, 'GTK activation peer');
  keys = await NativeKeys.open();
  await delay(700);
  if (!peerFocus) { await rawKey(1); await delay(300); }
  if (!peerFocus) await rawKey(15, [56]);
  await waitFor(() => peerFocus, 'owned launcher focus');
  await rawKey(66); // A fresh F8 reaches GTK, which mints a startup token.
  await waitFor(() => token, 'GTK startup notification token');
  const previous = { token: process.env.XDG_ACTIVATION_TOKEN, startup: process.env.DESKTOP_STARTUP_ID };
  process.env.XDG_ACTIVATION_TOKEN = token; process.env.DESKTOP_STARTUP_ID = 'owned-test-startup-id';
  try { app = await launch({ binary, application: fixture.application, engine: 'web', name: 'activation-native' }); }
  finally {
    if (previous.token === undefined) delete process.env.XDG_ACTIVATION_TOKEN; else process.env.XDG_ACTIVATION_TOKEN = previous.token;
    if (previous.startup === undefined) delete process.env.DESKTOP_STARTUP_ID; else process.env.DESKTOP_STARTUP_ID = previous.startup;
    token = undefined;
  }
  keys.app = app;
  const initial = (await app.waitEvent(event => event.data.stage === 'activation-ready' && event.data.id === 1, 'Weber startup')).data;
  assert.equal(initial.backend.tokenInherited, false); assert.equal(initial.backend.startupIdInherited, false);
  await waitFor(() => latestFocus(1), 'startup token gains actual native focus'); // No focus fallback after launch.
  await keys.key(64); // F6 opens from an actual OS input event.
  const child = (await app.waitEvent(event => event.data.stage === 'activation-created', 'child creation')).data.child;
  await app.waitEvent(event => event.data.stage === 'activation-applied' && event.data.id === child, 'child receives activation token');
  await waitFor(() => latestFocus(child), 'child token gains actual native focus');
  await keys.key(68); // F10 closes the focused child.
  await app.waitEvent(event => event.data.stage === 'window-closed' && event.data.id === child, 'child closes');
  await waitFor(() => latestFocus(1), 'parent regains focus');
  await keys.key(65); // Creation may complete between synchronous SDK calls.
  const cancellation = (await app.waitEvent(event => event.data.stage === 'activation-canceled', 'concurrent open and close')).data;
  const canceled = cancellation.child;
  await delay(1000);
  const canceledEvents = await app.events();
  const canceledOpened = canceledEvents.filter(event => event.data.stage === 'window-opened' && event.data.id === canceled);
  assert.ok(canceledOpened.length <= 1, 'No duplicate or resurrected window');
  if (canceledOpened.length) await app.waitEvent(event => event.data.stage === 'window-closed' && event.data.id === canceled, 'concurrent creation closed');
  await waitFor(() => latestFocus(1), 'parent focus after concurrent creation/close');
  await keys.key(67); // F9 closes the owner with another open outstanding.
  await app.waitEvent(event => event.data.stage === 'window-closed' && event.data.id === 1, 'opening owner closes');
  const ownerClosedEvents = await app.events();
  const surviving = ownerClosedEvents.filter(event => event.data.stage === 'window-opened').find(event => ![1, child, canceled].includes(event.data.id));
  // If creation already completed, preserving the independent child is the
  // existing API contract. It must have opened BEFORE its owner closed.
  if (surviving) {
    const closed = ownerClosedEvents.find(event => event.data.stage === 'window-closed' && event.data.id === 1);
    assert.ok(surviving.unixTimeMs < closed.unixTimeMs, 'Closed owner cannot create a late window');
    await waitFor(() => latestFocus(surviving.data.id), 'independent child focus after owner closes');
    await app.waitEvent(event => event.data.stage === 'activation-ready' && event.data.id === surviving.data.id, 'independent child initialized');
    await keys.key(68);
  }
  assert.equal((await app.waitExit()).code, 0);
  const events = await app.events();
  assert.equal(events.filter(event => event.data.stage === 'activation-applied' && event.data.id === 1).length, 1);
  assert.deepEqual(events.filter(event => event.data.stage === 'window-opened').map(event => event.data.id), [1, child, ...(canceledOpened.length ? [canceled] : []), ...(surviving ? [surviving.data.id] : [])]);
  await waitFor(async () => { try { return (await readFile(`/proc/${initial.backend.pid}/stat`, 'utf8')).split(') ')[1][0] === 'Z'; } catch { return true; } }, 'owned backend reaped');
  await writeFile('artifacts/activation-native.json', JSON.stringify({ passed: true, build, fixture, child, cancellation, independentChild: surviving?.data.id ?? null, trace: app.path,
    scope: 'Private GNOME Wayland: GTK launch token minted after OS F8, actual initial and child native focus without post-launch activation helpers, Bun excludes one-shot IDs, concurrent creation/close without resurrection, owner exit and backend reaped. stateAtClose records whether creation was still pending. Checkout SDK fixture; not physical input/IME, forced-timeout/unsupported-compositor, navigation race, malicious focus-stealing resistance or other OS proof.' }, null, 2));
  console.log('Native startup/child activation and cancellation passed');
} finally {
  if (keys) await keys.close();
  if (app) await app.stop();
  if (peer.exitCode === null) peer.stdin.end('{"stop":true}\n');
  await peerCompletion;
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, NativeKeys, waitFor, delay, execute } from './native-desktop.mjs';
assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
const binary = resolve('target/package/weber-clipboard-jit/weber');
const build = JSON.parse((await execute(binary, ['--build-info'])).stdout); assert.equal(build.clipboardProtocol, 1);
const fixture = JSON.parse(await readFile('artifacts/clipboard-workflow.json', 'utf8'));
const browser = process.argv.includes('--browser');
const resultPath = browser ? 'artifacts/clipboard-browser-native.json' : 'artifacts/clipboard-native.json';
if (browser) { assert.equal(build.browserClipboardProtocol, 1); assert.equal(build.safeCutProtocol, 1); }
await writeFile(resultPath, JSON.stringify({passed:false,build,sdkVersion:fixture.sdkVersion,installedSdk:fixture.installed,scope:'Native test started; completion not yet confirmed'},null,2));
const log = openSync(resolve('artifacts/clipboard-peer.log'), 'w');
const peer = spawn('/usr/bin/python3', [resolve('scripts/clipboard-peer.py')], { stdio: ['pipe', 'pipe', log], env: { ...process.env, GDK_BACKEND: 'wayland', GSK_RENDERER: 'cairo', GTK_A11Y: 'none', GTK_IM_MODULE: 'gtk-im-context-simple' } }); closeSync(log);
const peerEvents = [], pending = new Map(); let next = 0, peerExited = false;
const peerCompletion = new Promise((done, reject) => { peer.once('error', reject); peer.once('exit', code => { peerExited = true; done(code); }); }); peerCompletion.catch(() => {});
createInterface({ input: peer.stdout }).on('line', line => {
  const event = JSON.parse(line); peerEvents.push(event);
  if (event.id) { pending.get(event.id)?.(event); pending.delete(event.id); }
});
async function command(op, text) {
  const id = ++next; let result;
  pending.set(id, value => { result = value; });
  peer.stdin.write(JSON.stringify({ id, op, text }) + '\n');
  try { return await waitFor(() => { if (peerExited) throw new Error('GTK peer exited'); return result; }, `GTK ${op}`, 10000); }
  finally { pending.delete(id); }
}
async function peerFocus() { await waitFor(() => peerEvents.filter(e => 'focus' in e).at(-1)?.focus, 'GTK peer focus'); }
let app, keys;
async function freshPeerInput() {
  await peerFocus();
  // GDK uses its last application input serial for selection ownership. Alt-Tab
  // belongs to the compositor, so supply a fresh harmless peer keyboard event.
  await keys.command({keycode:42,pressed:true});await delay(40);await keys.command({keycode:42,pressed:false});await delay(50);
}
async function focusWeber() {
  if (!(await app.events()).filter(e=>e.data.stage==='window-focus').at(-1)?.data.focused) await cycleWindow();
  await waitFor(async () => (await app.events()).filter(e=>e.data.stage==='window-focus').at(-1)?.data.focused, 'latest Weber focus');
}
async function cycleWindow() {
  // Cycle windows rather than application groups: these development executables
  // may not have installed desktop entries for GNOME's application switcher.
  await keys.command({keycode:56,pressed:true});await delay(40);
  try {await keys.command({keycode:1,pressed:true});await delay(40);await keys.command({keycode:1,pressed:false});}
  finally {await keys.command({keycode:56,pressed:false});}
}
async function focusPeer() { if (!peerEvents.filter(e=>'focus' in e).at(-1)?.focus) await cycleWindow();await peerFocus(); }
try {
  await waitFor(() => peerEvents.find(e => e.ready), 'GTK peer startup');
  await waitFor(() => peerEvents.find(e => e.mapped && e.visible), 'GTK first mapped frame');
  keys = await NativeKeys.open();
  if (!peerEvents.filter(e => 'focus' in e).at(-1)?.focus) {
    // Fresh GNOME profiles may start in Overview. All windows on this display
    // belong to this test; Escape dismisses that compositor-owned surface.
    await keys.command({keycode:1,pressed:true});await delay(40);await keys.command({keycode:1,pressed:false});await delay(500);
    await keys.command({keycode:56,pressed:true});await delay(40);await keys.command({keycode:15,pressed:true});await delay(40);await keys.command({keycode:15,pressed:false});await keys.command({keycode:56,pressed:false});
  }
  await peerFocus();
  await freshPeerInput();
  await command('write', 'GTK에서 복사한 텍스트 😀\nSecond line');
  app = await launch({ binary, application: browser ? fixture.browserApplication : fixture.application, engine: 'web', name: browser ? 'clipboard-browser-native' : 'clipboard-native' });
  await app.waitEvent(e=>e.data.stage==='window-opened','Weber window creation');await delay(300);
  keys.app = app; await focusWeber();await keys.key(64);
  if (browser) {
    const phase = n => app.waitEvent(e => e.data.stage === 'browser-phase' && e.data.phase === n, `browser phase ${n}`);
    const advance = async n => { await keys.key(64); await phase(n); };
    const select = () => keys.key(30, [29]); // Ctrl+A
    const copy = () => keys.key(46, [29]); // Ctrl+C
    const cut = () => keys.key(45, [29]); // Ctrl+X
    const paste = () => keys.key(47, [29]); // Ctrl+V
    await phase(0); await paste(); await advance(1);
    await select(); await copy(); await focusPeer();
    assert.equal((await command('read')).text, 'GTK에서 복사한 텍스트 😀\nSecond line');
    await focusWeber(); await advance(2); await select(); await cut(); await advance(3);
    await focusPeer(); assert.equal((await command('read')).text, 'Single line 한글 😀');
    await focusWeber(); await select(); await copy(); await focusPeer();
    assert.equal((await command('read')).text, 'Custom copy 한글 😀');
    await focusWeber(); await advance(4); await select(); await paste(); await advance(5);
    await paste(); await advance(6);
    await focusPeer(); await freshPeerInput(); await command('write', 'Editable 한글 😀');
    await focusWeber(); await paste(); await advance(7);
    const editable = await app.waitEvent(e => e.data.stage === 'browser-contenteditable', 'contenteditable capability observation');
    await select(); await cut(); await paste(); await advance(8);
    await select(); await cut(); await advance(9);
    await select(); await cut(); await advance(10);
    await focusPeer(); assert.equal((await command('read')).text, 'Cut recovered 한글 😀'); await focusWeber();
    await keys.key(66); const exit = await app.waitExit(); assert.equal(exit.code, 0, JSON.stringify(exit));
    await writeFile(resultPath, JSON.stringify({ passed: true, build, binary, sdkVersion: fixture.sdkVersion, installedSdk: fixture.installed, display: process.env.WEBER_TEST_DISPLAY, scope: 'Native virtual Ctrl+C/X/V in isolated Wayland: textarea multiline/Unicode paste and copy with GTK4, input cut to GTK4 and paste, trusted clipboard events/data, custom copy data, prevented paste, readonly input preservation, oversized default cut preserves text and later cut recovers, input events, clean exit. No SDK clipboard calls or synthetic clipboard events; no physical keyboard, full Clipboard API, Windows/macOS or AOT validation.', limitations: editable.data.supported ? [] : ['Servo contenteditable default paste is unimplemented; event/data arrive but content remains unchanged.'], contenteditable: editable.data, peerEvents, trace: app.path }, null, 2));
    console.log('Browser copy/cut/paste native gates passed');
  } else {
  await app.waitEvent(e => e.data.stage === 'clipboard-offered', 'GTK to Weber paste and copy', 20000);
  await focusPeer();
  const copied = await command('read'); assert.equal(copied.text, 'Weber에서 복사한 텍스트 😀\nThird line', JSON.stringify(copied));
  await freshPeerInput();await command('write', 'x'.repeat(8193)); await focusWeber();await keys.key(64);
  await app.waitEvent(e => e.data.stage === 'clipboard-limits', 'external oversize and native limits', 20000);
  await focusPeer();
  const boundary = await command('read'); assert.equal(boundary.text, '\n'.repeat(8192));
  await freshPeerInput();await command('write', 'recovered 한글 😀'); await focusWeber();await keys.key(64);
  await app.waitEvent(e => e.data.stage === 'clipboard-pass', 'clipboard recovery', 15000);
  await app.waitEvent(e => e.data.stage === 'clipboard-unfocused', 'background request rejection');
  const threads = async () => {
    const names = await readdir(`/proc/${app.child.pid}/task`), data = [];
    for (const id of names) {
      const text = await readFile(`/proc/${app.child.pid}/task/${id}/stat`, 'utf8').catch(() => '');
      if (text.includes('(WeberClipboard)')) { const fields = text.slice(text.lastIndexOf(')') + 2).split(' '); data.push({ id, ticks: Number(fields[11]) + Number(fields[12]) }); }
    }
    return data;
  };
  await delay(500); const before = await threads(); await delay(2000); const after = await threads(); assert.equal(before.length, 1);
  const idleTicks = after[0].ticks - before[0].ticks;
  await keys.key(66);const exit=await app.waitExit();assert.equal(exit.code,0,JSON.stringify(exit));
  await writeFile('artifacts/clipboard-native.json', JSON.stringify({ passed: true, build, binary, sdkVersion:fixture.sdkVersion, installedSdk:fixture.installed, display: process.env.WEBER_TEST_DISPLAY, scope: 'Independent GTK4 process and real Wayland clipboard, Unicode/multiline both directions via Notes buttons, 8192-byte escaped boundary, external oversize, native/SDK limits, bad capability, background denial, recovery and clean last-window shutdown. Input switching uses virtual keyboard in private compositor; no physical keyboard, browser clipboard shortcuts, Windows/macOS or AOT validation.', peerEvents, idleClipboardThread: { seconds: 2, ticks: idleTicks }, trace: app.path }, null, 2));
  console.log('Native Wayland clipboard gates passed; idle clipboard thread ticks:', idleTicks);
  }
} finally {
  await writeFile('artifacts/clipboard-peer-events.json', JSON.stringify(peerEvents, null, 2));
  if (keys) await keys.close(); if (app) await app.stop();
  if (!peerExited) { peer.stdin.end(JSON.stringify({ id: ++next, op: 'stop' }) + '\n'); const timer = setTimeout(() => peer.kill('SIGKILL'), 3000); try { await peerCompletion; } finally { clearTimeout(timer); } }
}

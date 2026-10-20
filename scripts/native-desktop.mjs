import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export const execute = promisify(execFile);
export { delay };
export async function requireSession() {
  if (!process.env.WAYLAND_DISPLAY) throw new Error('An active Wayland session is required');
  if (process.env.XDG_CURRENT_DESKTOP?.includes('GNOME')) {
    const result = await execute('gdbus', ['call', '--timeout', '5', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive']);
    if (result.stdout.includes('true')) throw new Error('GNOME session is locked; unlock before native presentation/input tests');
  }
}
export async function readEvents(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export async function waitFor(test, message, timeout = 15000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const result = await test(); if (result) return result;
    await delay(30);
  }
  throw new Error(`Timed out: ${message}`);
}
export async function launch({ binary = 'target/debug/weber-servo', engine = 'aot', mode, name, config = {}, benchmark = false, capture = false, application }) {
  await requireSession();
  await mkdir('artifacts', { recursive: true });
  const path = resolve(`artifacts/${name}.jsonl`);
  await writeFile(path, '');
  const log = openSync(resolve(`artifacts/${name}.log`), 'w');
  const env = { ...process.env, RUST_LOG: 'warn', WEBER_TELEMETRY: path, WEBER_DESKTOP_CONFIG: JSON.stringify({ mode, ...config }) };
  delete env.DISPLAY;
  if (benchmark) env.WEBER_BENCH = '1'; else delete env.WEBER_BENCH;
  if (capture) env.WEBER_SMOKE_CAPTURE = resolve(`artifacts/${name}.png`); else delete env.WEBER_SMOKE_CAPTURE;
  const args = application ? ['--app', resolve(application), ...(engine === 'web' ? ['--web'] : [])] : benchmark ? [`weber-app://desktop/bench-${engine}.html`] : engine === 'web' ? ['--web'] : [];
  const started = performance.now();
  const spawnUnixMs = Date.now();
  const child = spawn(resolve(binary), args, { cwd: '/tmp', env, stdio: ['ignore', log, log] });
  closeSync(log);
  let exit;
  const completion = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exit = { code, signal }; resolveExit(exit); }); });
  // Keep a rejection observed even if a readiness assertion fails first.
  completion.catch(() => {});
  const events = () => readEvents(path);
  const waitEvent = (predicate, message, timeout) => waitFor(async () => {
    const all = await events(); const failure = all.find(event => ['failure', 'error'].includes(event.data.stage));
    if (failure) throw new Error(JSON.stringify(failure));
    const result = all.find(predicate); if (result) return result;
    if (exit) throw new Error(`Desktop exited before ${message}: ${JSON.stringify(exit)}`);
    return null;
  }, message, timeout);
  return { child, path, events, waitEvent, completion, started, spawnUnixMs,
    async stop() { if (!exit) child.kill(); await completion; },
    async waitExit(timeout = 20000) { return waitFor(() => exit, 'desktop exit', timeout); },
  };
}
export class NativeKeys {
  constructor(child, ready, pending) { this.child = child; this.ready = ready; this.pending = pending; this.app = null; }
  static async open() {
    const child = spawn('/usr/bin/python3', [resolve('scripts/wayland-input.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = [];
    const ready = new Promise((resolveReady, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => { const value = JSON.parse(line); if (value.ready) resolveReady(value); else pending.shift()?.resolve(value); });
      child.once('error', reject); child.once('exit', code => { const error = new Error(`Native input helper exited: ${code}`); reject(error); for (const call of pending.splice(0)) call.reject(error); });
    });
    const keys = new NativeKeys(child, ready, pending); await ready; return keys;
  }
  async command(command) { return new Promise((resolveCommand, reject) => { this.pending.push({ resolve: resolveCommand, reject }); this.child.stdin.write(JSON.stringify(command) + '\n'); }); }
  async focused() {
    if (!this.app) throw new Error('No owned input-test window');
    const events = await this.app.events();
    const focus = events.filter(event => event.data.stage === 'window-focus').at(-1);
    if (!focus?.data.focused) throw new Error('Owned Weber window is not focused; refusing OS input');
  }
  async activate() {
    if (!this.app || this.app.child.exitCode !== null) throw new Error('No owned window to activate');
    const focused = async () => (await this.app.events()).filter(event => event.data.stage === 'window-focus').at(-1)?.data.focused;
    // Mapping and DOM readiness can precede compositor activation. Let natural
    // focus arrive before an Alt-Tab could switch away from the new window.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await focused()) return;
      if (this.app.child.exitCode !== null) throw new Error('Owned activation window exited');
      await delay(30);
    }
    if (process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME')) {
      // The private Shell can show Overview after the last startup sample closes.
      // Dismiss it only on our owned test display, then recheck actual focus.
      await this.command({ keycode: 1, pressed: true });
      await this.command({ keycode: 1, pressed: false });
      await delay(300);
      if (await focused()) return;
    }
    // The compositor owns Alt-Tab. No text/control keys go to another application.
    await this.command({ keycode: 56, pressed: true });
    try { await this.command({ keycode: 15, pressed: true }); await this.command({ keycode: 15, pressed: false }); }
    finally { await this.command({ keycode: 56, pressed: false }); }
    await waitFor(focused, 'Owned window activation', 5000);
  }

  async key(code, modifiers = []) {
    await this.focused();
    const down = [];
    try {
      for (const modifier of modifiers) { await this.command({ keycode: modifier, pressed: true }); down.push(modifier); await delay(30); }
      await this.command({ keycode: code, pressed: true }); down.push(code); await delay(25);
    } finally { for (const release of down.reverse()) await this.command({ keycode: release, pressed: false }); }
    await delay(45);
  }
  async close() {
    if (this.child.exitCode !== null) return;
    const exit = new Promise(resolveExit => this.child.once('exit', resolveExit));
    this.child.stdin.end(JSON.stringify({ stop: true }) + '\n'); await exit;
  }
}
// Process-tree proportional/resident memory, including private child processes.
export async function memory(pid) {
  const pids = [], queue = [pid];
  while (queue.length) {
    const current = queue.shift(); if (pids.includes(current)) continue;
    pids.push(current);
    const children = await readFile(`/proc/${current}/task/${current}/children`, 'utf8').catch(() => '');
    queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
  }
  const sums = { rssKiB: 0, pssKiB: 0, privateKiB: 0, pids };
  for (const current of pids) {
    const rollup = await readFile(`/proc/${current}/smaps_rollup`, 'utf8').catch(() => '');
    const amount = name => Number(rollup.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    sums.rssKiB += amount('Rss'); sums.pssKiB += amount('Pss');
    sums.privateKiB += amount('Private_Clean') + amount('Private_Dirty');
  }
  return sums;
}
export function distribution(values) {
  if (!values.length) throw new Error('Empty measurement distribution');
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = fraction => sorted[Math.ceil(fraction * sorted.length) - 1];
  return { n: values.length, min: sorted[0], p50: quantile(.5), p95: quantile(.95), max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
}

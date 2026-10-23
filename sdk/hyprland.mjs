// Optional backend-only integration. No shell process and no UI Node globals.
import { createConnection } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const text = value => typeof value === 'string' ? value.slice(0, 200) : '';
export function createHyprlandClient(options = {}) {
  const runtime = options.runtimeDir ?? process.env.XDG_RUNTIME_DIR;
  const instance = options.instance ?? process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const timeoutMs = options.timeoutMs ?? 2000;
  if (process.platform !== 'linux' || typeof runtime !== 'string' || !isAbsolute(runtime) || !/^[\w.-]{1,200}$/.test(instance ?? '')) throw new Error('A Linux Hyprland session is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) throw new RangeError('Hyprland timeout must be 10..10000ms');
  const directory = join(runtime, 'hypr', instance);
  let pending = 0;
  async function request(command, signal) {
    signal?.throwIfAborted();
    if (pending >= 16) throw new Error('Hyprland request limit reached');
    pending++;
    try {
      return await new Promise((resolve, reject) => {
        const socket = createConnection(join(directory, '.socket.sock'));
        const chunks = []; let bytes = 0, completed = false;
        const abort = () => socket.destroy(Object.assign(new Error('Hyprland request aborted'), { name: 'AbortError' }));
        const timer = setTimeout(() => socket.destroy(new Error('Hyprland request timed out')), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        socket.once('connect', () => socket.write(command));
        socket.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1048576) socket.destroy(new Error('Hyprland response exceeds 1 MiB'));
          else chunks.push(chunk);
        });
        socket.once('end', () => { completed = true; resolve(Buffer.concat(chunks).toString('utf8')); });
        socket.once('error', error => { completed = true; reject(error); });
        socket.once('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!completed) reject(new Error('Hyprland response closed prematurely')); });
      });
    } finally { pending--; }
  }
  async function snapshot({ signal } = {}) {
    const [monitors, workspaces, clients, active] = await Promise.all(['monitors', 'workspaces', 'clients', 'activewindow'].map(async name => JSON.parse(await request('j/' + name, signal))));
    if (![monitors, workspaces, clients].every(Array.isArray)) throw new Error('Invalid Hyprland snapshot');
    const result = {
      connected: true, error: null,
      monitors: monitors.slice(0, 8).map(m => ({ id: m.id, name: text(m.name), activeWorkspace: m.activeWorkspace?.id ?? 0, focused: Boolean(m.focused) })),
      workspaces: workspaces.slice(0, 32).map(w => ({ id: w.id, name: text(w.name), monitor: text(w.monitor), windows: w.windows ?? 0 })),
      clients: clients.filter(c => /^0x[0-9a-f]+$/i.test(c.address)).slice(0, 48).map(c => ({ address: c.address, title: text(c.title), class: text(c.class), workspace: c.workspace?.id ?? 0, pid: c.pid ?? 0 })),
      activeAddress: /^0x[0-9a-f]+$/i.test(active.address) ? active.address : '',
      truncated: monitors.length > 8 || workspaces.length > 32 || clients.length > 48,
    };
    // Leave room for the backend event envelope, including multibyte titles.
    // Count actual JSON bytes; a character count alone cannot bound IPC payloads.
    while (Buffer.byteLength(JSON.stringify(result)) > 24576 && result.clients.length) {
      result.clients.pop(); result.truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 24576) throw new Error('Hyprland snapshot metadata exceeds 24 KiB');
    return result;
  }
  async function dispatch(expression, signal) {
    const reply = await request('dispatch ' + expression, signal);
    if (reply.trim() !== 'ok') throw new Error('Hyprland rejected request: ' + reply.slice(0, 300));
    return true;
  }
  async function watch(emit, { signal } = {}) {
    if (!signal) throw new TypeError('Hyprland watch requires an AbortSignal for cleanup');
    let retry = 100;
    while (!signal.aborted) {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      const socket = createConnection(join(directory, '.socket2.sock'));
      const connectTimer = setTimeout(() => socket.destroy(new Error('Hyprland event connection timed out')), timeoutMs);
      let timer, refresh, dirty = false, buffer = '', failure;
      const abort = () => socket.destroy();
      signal.addEventListener('abort', abort, { once: true });
      const disconnected = new Promise(done => {
        socket.once('error', error => { failure = error; });
        socket.once('close', () => { controller.abort(); done(); });
      });
      const schedule = () => {
        dirty = true;
        if (timer || refresh || combined.aborted) return;
        timer = setTimeout(() => {
          timer = undefined; dirty = false;
          refresh = snapshot({ signal: combined }).then(value => { if (!combined.aborted) return emit(value); }).catch(error => { failure = error; socket.destroy(); }).finally(() => { refresh = undefined; if (dirty) schedule(); });
        }, 60);
      };
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 65536) { failure = new Error('Hyprland event buffer exceeded'); socket.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) { const event = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (event.includes('>>')) schedule(); }
      });
      socket.once('connect', () => { clearTimeout(connectTimer); retry = 100; schedule(); });
      try {
        await disconnected;
        clearTimeout(timer); await refresh;
        if (!signal.aborted) await emit({ connected: false, error: text(failure?.message ?? 'Hyprland connection closed'), monitors: [], workspaces: [], clients: [], activeAddress: '', truncated: false });
      } finally { clearTimeout(timer); clearTimeout(connectTimer); controller.abort(); signal.removeEventListener('abort', abort); socket.destroy(); }
      if (!signal.aborted) { await delay(retry, undefined, { signal }).catch(() => {}); retry = Math.min(3000, retry * 2); }
    }
  }
  return {
    snapshot, watch,
    focusWorkspace(id, { signal } = {}) {
      if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new TypeError('Workspace must be a positive 32-bit integer');
      return dispatch(`hl.dsp.focus({workspace='${id}'})`, signal);
    },
    focusWindow(address, { signal } = {}) {
      if (typeof address !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(address)) throw new TypeError('Invalid Hyprland window address');
      return dispatch(`hl.dsp.focus({window='address:${address}'})`, signal);
    },
  };
}

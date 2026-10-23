import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHyprlandClient } from '../sdk/hyprland.mjs';
import { waitFor, delay } from './native-desktop.mjs';
const runtimeDir = await mkdtemp(join(tmpdir(), 'weber-ipc-'));
const directory = join(runtimeDir, 'hypr', 'owned'); await mkdir(directory, { recursive: true });
let workspace = 1, requests = 0, stalled, largeTitles = false;
const sockets = new Set();
const reply = name => ({ monitors: [{ id: 0, name: 'test', focused: true, activeWorkspace: { id: workspace } }], workspaces: [{ id: workspace, name: String(workspace), windows: 0 }], clients: largeTitles ? Array.from({ length: 48 }, (_, i) => ({ address: '0x' + (i + 1).toString(16), title: '한'.repeat(200), class: '글'.repeat(200), workspace: { id: 1 }, pid: 1 })) : [], activewindow: {} }[name]);
const command = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  socket.once('data', bytes => {
    requests++; const input = bytes.toString();
    if (input.startsWith('dispatch ')) { workspace = 2; socket.end('ok'); return; }
    if (stalled) return;
    const text = JSON.stringify(reply(input.slice(2)));
    socket.write(text.slice(0, 3)); setTimeout(() => socket.end(text.slice(3)), 5);
  });
});
let eventSockets = new Set();
const makeEvents = () => createServer(socket => { eventSockets.add(socket); socket.on('close', () => eventSockets.delete(socket)); });
let events = makeEvents();
const listen = (server, path) => new Promise((done, reject) => { server.once('error', reject); server.listen(path, done); });
const close = server => new Promise(done => server.close(done));
const client = createHyprlandClient({ runtimeDir, instance: 'owned', timeoutMs: 150 });
const controller = new AbortController(), states = [];
let watching;
try {
  await listen(command, join(directory, '.socket.sock')); await listen(events, join(directory, '.socket2.sock'));
  assert.equal((await client.snapshot()).monitors[0].activeWorkspace, 1);
  assert.throws(() => client.focusWorkspace("2'});exit()"), /positive/);
  assert.throws(() => client.focusWindow('0x1;exit'), /Invalid/);
  watching = client.watch(value => { states.push(value); }, { signal: controller.signal });
  await waitFor(() => states.some(s => s.connected), 'initial watch snapshot');
  const idle = requests; await delay(250); assert.equal(requests, idle, 'no periodic snapshot polling');
  await client.focusWorkspace(2);
  for (const socket of eventSockets) { socket.write('worksp'); socket.write('acev2>>2,2\n'); }
  await waitFor(() => states.some(s => s.connected && s.monitors[0].activeWorkspace === 2), 'split event updates snapshot');
  for (const socket of eventSockets) socket.destroy(); await close(events);
  await waitFor(() => states.some(s => !s.connected), 'disconnection surfaced');
  events = makeEvents(); await listen(events, join(directory, '.socket2.sock'));
  await waitFor(() => states.at(-1)?.connected, 'event socket reconnects');
  largeTitles = true;
  const bounded = await client.snapshot();
  assert.ok(bounded.truncated && bounded.clients.length < 48 && Buffer.byteLength(JSON.stringify(bounded)) <= 24576, 'multibyte titles fit backend event budget');
  controller.abort(); await watching;
  await waitFor(() => eventSockets.size === 0, 'subscription closes socket');
  stalled = true;
  await assert.rejects(client.snapshot(), /timed out/);
  const cancel = new AbortController(); const request = client.snapshot({ signal: cancel.signal }); cancel.abort();
  await assert.rejects(request, /aborted/i);
  console.log('Hyprland client: segmented replies/events, validation, zero idle polling, reconnect, timeout and cancellation passed (mock sockets)');
} finally {
  controller.abort(); await watching?.catch(() => {});
  for (const socket of [...sockets, ...eventSockets]) socket.destroy();
  await Promise.all([close(command), close(events)]); await rm(runtimeDir, { recursive: true, force: true });
}

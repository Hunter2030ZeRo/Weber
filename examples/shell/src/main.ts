import { defineApp } from '@weber/runtime';
import { invoke, subscribe } from '@weber/sdk/backend';
import { closeWindow } from '@weber/sdk/window';
import type { HyprlandSnapshot } from '@weber/sdk/hyprland';
import './style.css';

defineApp({ title: 'Shell Launcher · Weber', mount(root) {
  const panel = !document.querySelector('meta[name="weber-native"]');
  root.className = panel ? 'panel' : 'launcher';
  root.innerHTML = `<header><button id="launcher">Windows</button><nav id="workspaces" aria-label="Workspaces"></nav><span id="status" role="status">Connecting…</span>${panel ? '<button id="stop-panel" title="Stop this panel">×</button>' : ''}</header>
    ${panel ? '' : '<main><h1>Windows</h1><label>Find a window <input id="search" autocomplete="off" /></label><p id="empty" hidden>No matching windows</p><div id="windows"></div><button id="close">Close launcher</button></main>'}`;
  let current: HyprlandSnapshot | undefined, disposed = false;
  const status = root.querySelector<HTMLElement>('#status')!;
  const search = root.querySelector<HTMLInputElement>('#search');
  const fail = (error: unknown) => { if (!disposed) status.textContent = String(error); };
  const call = (method: string, params: string | number | null = null) => { void invoke(method, params).catch(fail); };
  root.querySelector('#launcher')!.addEventListener('click', () => call('launcher'));
  root.querySelector('#stop-panel')?.addEventListener('click', () => { location.href = 'weber://close'; });
  root.querySelector('#close')?.addEventListener('click', () => closeWindow());
  const workspaces = root.querySelector('#workspaces')!;
  for (let id = 1; id <= 5; id++) {
    const button = document.createElement('button'); button.textContent = String(id); button.id = `workspace-${id}`;
    button.addEventListener('click', () => call('workspace', id)); workspaces.append(button);
  }
  const render = () => {
    if (!current || disposed) return;
    status.textContent = current.connected ? (current.clients.find(client => client.address === current!.activeAddress)?.title || 'Hyprland connected') : current.error || 'Disconnected';
    root.dataset.connected = String(current.connected);
    const active = current.monitors.find(monitor => monitor.focused)?.activeWorkspace;
    root.dataset.workspace = String(active ?? '');
    for (let id = 1; id <= 5; id++) root.querySelector(`#workspace-${id}`)!.setAttribute('aria-pressed', String(id === active));
    const windows = root.querySelector('#windows'); if (!windows) return;
    const query = search!.value.toLocaleLowerCase();
    const clients = current.clients.filter(client => (client.title + ' ' + client.class).toLocaleLowerCase().includes(query));
    const rows = clients.map(client => {
      const button = document.createElement('button'); button.dataset.address = client.address;
      button.textContent = `${client.title || client.class} · workspace ${client.workspace}`;
      button.addEventListener('click', () => { void invoke('focus', client.address).then(() => { if (!disposed) closeWindow(); }).catch(fail); });
      return button;
    });
    windows.replaceChildren(...rows);
    (root.querySelector('#empty') as HTMLElement).hidden = rows.length > 0;
  };
  search?.addEventListener('input', render);
  const stop = subscribe('watch', null, value => { current = value as unknown as HyprlandSnapshot; render(); }, { onError: fail });
  return () => { disposed = true; stop(); root.replaceChildren(); };
} });

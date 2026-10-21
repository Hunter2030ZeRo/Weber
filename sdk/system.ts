import { nativeRequest, onWindowsChanged } from './window';
export interface DisplayInfo { name: string | null; width: number; height: number; x: number; y: number; scaleFactor: number; refreshMilliHertz: number | null }
export interface SystemInfo {
  os: string; architecture: string; displays: readonly Readonly<DisplayInfo>[];
  capabilities: Readonly<{ minimize: boolean; restoreMinimized: boolean; visibility: boolean; absolutePosition: boolean; alwaysOnTop: boolean; decorations: boolean; drag: boolean; externalUrl: boolean; notifications: boolean }>;
}
function immutable(info: SystemInfo): Readonly<SystemInfo> {
  return Object.freeze({ ...info, displays: Object.freeze(info.displays.map(display => Object.freeze({ ...display }))), capabilities: Object.freeze({ ...info.capabilities }) });
}
/** Cached host/display snapshot. Window focus/size/scale/theme events refresh it. */
export function getSystemInfo(): Readonly<SystemInfo> { return immutable(nativeRequest({ op: 'system.info' }).info); }
/** Explicit refresh also discovers changes to outputs that have no Weber window.
 * Wayland output coordinates are compositor metadata, not window-position permission. */
export async function refreshSystemInfo(): Promise<Readonly<SystemInfo>> {
  const { serial } = nativeRequest({ op: 'system.refresh' }), deadline = performance.now() + 3000;
  for (;;) {
    const snapshot = nativeRequest({ op: 'system.info' });
    if (snapshot.completed >= serial) return immutable(snapshot.info);
    if (performance.now() >= deadline) throw new Error('System refresh timed out');
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}
/** Initial + changed cached snapshots, coalesced; no idle timer. Not a hotplug history. */
export function onSystemChanged(listener: (info: Readonly<SystemInfo>) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('System callback required');
  let previous = '';
  return onWindowsChanged(snapshot => { const key = JSON.stringify(snapshot.system); if (key === previous) return; previous = key; listener(immutable(snapshot.system)); });
}
export interface SystemOptions { signal?: AbortSignal }
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void; deadline: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;
function discard(id: number) { try { nativeRequest({ op: 'system.cancel', requestId: id }); } catch {} }
function schedule() { if (timer === undefined && pending.size) timer = setTimeout(poll, 16); }
function poll() {
  timer = undefined;
  for (const [id, call] of pending) {
    try {
      if (performance.now() >= call.deadline) { discard(id); throw new Error('System request timed out; an issued action may have completed'); }
      const result = nativeRequest({ op: 'system.poll', requestId: id });
      if (!result.pending) { pending.delete(id); call.cleanup(); call.resolve(result.value); }
    } catch (error) { pending.delete(id); call.cleanup(); call.reject(error); }
  }
  schedule();
}
function call<T>(request: Record<string, unknown>, { signal }: SystemOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => { try {
    if (signal?.aborted) throw new DOMException('System request cancelled', 'AbortError');
    const { id } = nativeRequest({ op: 'system.start', ...request });
    const abort = () => { if (!pending.delete(id)) return; discard(id); signal?.removeEventListener('abort', abort); reject(new DOMException('System request cancelled', 'AbortError')); };
    pending.set(id, { resolve: value => resolve(value as T), reject, cleanup: () => signal?.removeEventListener('abort', abort), deadline: performance.now() + 35000 });
    signal?.addEventListener('abort', abort, { once: true }); schedule();
  } catch (error) { reject(error); } });
}
/** Desktop-approved http/https/mailto handoff. true = portal success, null = user
 * cancelled. Does not prove a remote page loaded. Requires a focused window. */
export function openExternal(url: string, options: SystemOptions & { ask?: boolean } = {}): Promise<true | null> {
  if (typeof url !== 'string') return Promise.reject(new TypeError('URL must be a string'));
  return call({ action: 'open', url, ask: options.ask ?? false }, options);
}
export interface NotificationHandle { readonly id: number }
/** Plain text, no actions; server expiry requested at 10s. Handle retained at
 * most 30s, with pruning on subsequent service work. Window close/navigation
 * requests dismissal. The desktop may suppress presentation or ignore expiry. */
export function showNotification(title: string, body = '', options: SystemOptions = {}): Promise<NotificationHandle> {
  return call<{ id: number }>({ action: 'notify', title, body }, options).then(value => Object.freeze(value));
}
export function dismissNotification(notification: NotificationHandle): Promise<void> { return call({ action: 'dismiss', notificationId: notification.id }); }

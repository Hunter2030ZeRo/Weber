import type { SystemInfo, DisplayInfo } from './system';
export interface WindowInfo { id: number; state: 'opening' | 'ready' | 'failed'; title?: string; width?: number; height?: number; scaleFactor?: number; focused?: boolean; maximized?: boolean; fullscreen?: boolean; resizable?: boolean; decorations?: boolean; minimized?: boolean | null; theme?: 'dark' | 'light' | null; display?: Readonly<DisplayInfo> | null; error?: string }
export interface WindowOptions { title?: string; width?: number; height?: number; decorations?: boolean; resizable?: boolean }
declare global { var weberNativeTransport: undefined | ((request: string) => string); }
function request(value: Record<string, unknown>) {
  let reply: string;
  if (typeof globalThis.weberNativeTransport === 'function') reply = globalThis.weberNativeTransport(JSON.stringify(value));
  else {
    const call = (globalThis as unknown as { weberHostCall?: (input: string) => string }).weberHostCall;
    const capability = document.querySelector('meta[name="weber-native"]')?.getAttribute('content');
    if (!call || !capability) throw new Error('Native window API unavailable');
    reply = call(JSON.stringify({ action: 'native', capability, request: value }));
  }
  const response = JSON.parse(reply);
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? 'Native request failed'), { name: response?.error?.name ?? 'NativeError' });
  return response.result;
}
export { request as nativeRequest };
export function currentWindow(): WindowInfo { return request({ op: 'info' }); }
export function listWindows(): WindowInfo[] { return request({ op: 'list' }); }
/** Opens the same application in another native window. Resolution means created,
 * not first paint or focus. Linux activation is best effort: the compositor owns
 * focus policy; an unavailable token never prevents creating the window. */
export async function openWindow(options: WindowOptions = {}): Promise<WindowInfo> {
  const { id } = request({ op: 'open', options });
  const deadline = performance.now() + 5000;
  for (;;) {
    const info: WindowInfo = request({ op: 'info', id });
    if (info.state === 'ready') return info;
    if (info.state === 'failed') throw new Error(info.error ?? 'Window creation failed');
    if (performance.now() >= deadline) { closeWindow(id); throw new Error('Window creation timed out'); }
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}
/** Enqueues a close; other windows remain running. Closing the last window exits the app. */
export function closeWindow(id?: number): void { request({ op: 'close', id: id ?? currentWindow().id }); }
let closeHandler: (() => boolean | Promise<boolean>) | undefined, closeGeneration: number | undefined;
Object.assign(globalThis, { async weberCloseRequested(event: { generation: number; token: number }) {
  if (!closeHandler || event.generation !== closeGeneration) return;
  let allow = false;
  try { allow = await closeHandler() === true; }
  catch (error) { console.error('Close handler:', error); (globalThis as any).weberShowError?.(error); }
  if (event.generation === closeGeneration) request({ op: 'close.reply', ...event, allow });
} });
/** Intercept native and SDK close requests. Return true to close, false to keep
 * the window; async decisions are supported. Only one handler per window. */
export function onCloseRequested(handler: () => boolean | Promise<boolean>): () => void {
  if (typeof handler !== 'function') throw new TypeError('Close handler required');
  if (closeHandler) throw new Error('Close handler already registered');
  const generation = request({ op: 'close.watch' }).generation;
  closeHandler = handler; closeGeneration = generation;
  return () => { if (closeGeneration !== generation) return; closeHandler = undefined; closeGeneration = undefined; request({ op: 'close.unwatch', generation }); };
}
export function setWindowTitle(title: string, id?: number): void { request({ op: 'title', title, id: id ?? currentWindow().id }); }
/** Requests logical pixels. The compositor may constrain the result; observe snapshots for actual physical size. */
export function resizeWindow(width: number, height: number, id?: number): void { request({ op: 'resize', width, height, id: id ?? currentWindow().id }); }
export function setWindowMaximized(value: boolean, id?: number): void { request({ op: 'maximize', value, id: id ?? currentWindow().id }); }
/** Borderless fullscreen; this does not enter a browser element's fullscreen mode. */
export function setWindowFullscreen(value: boolean, id?: number): void { request({ op: 'fullscreen', value, id: id ?? currentWindow().id }); }
export function setWindowResizable(value: boolean, id?: number): void { request({ op: 'resizable', value, id: id ?? currentWindow().id }); }
export function setWindowDecorations(value: boolean, id?: number): void { request({ op: 'decorations', value, id: id ?? currentWindow().id }); }
/** Wayland minimize request; restoration and minimized-state queries are unavailable. */
export function minimizeWindow(id?: number): void { request({ op: 'minimize', id: id ?? currentWindow().id }); }
export function requestWindowAttention(id?: number): void { request({ op: 'attention', id: id ?? currentWindow().id }); }
/** Call from a native left-button pointerdown. Enqueues an interactive compositor request. */
export function beginWindowDrag(): void { request({ op: 'drag' }); }
export type ResizeDirection = 'north' | 'south' | 'east' | 'west' | 'north-east' | 'north-west' | 'south-east' | 'south-west';
export function beginWindowResize(direction: ResizeDirection): void { request({ op: 'drag-resize', direction }); }

export interface WindowSnapshot { readonly revision: number; readonly windows: readonly Readonly<WindowInfo>[]; readonly system: Readonly<SystemInfo> }
const listeners = new Map<number, { next(snapshot: WindowSnapshot): void; revision: number }>();
let nextListener = 1, generation: number | undefined, revision = -1;
let latestSnapshot: WindowSnapshot | undefined;
function notify(id: number, snapshot: WindowSnapshot) {
  const listener = listeners.get(id);
  if (!listener || listener.revision >= snapshot.revision) return;
  listener.revision = snapshot.revision;
  try { listener.next(snapshot); } catch (error) { console.error('Window state callback:', error); }
}
function deliver(event: { generation: number; snapshot: WindowSnapshot }) {
  if (event.generation !== generation || event.snapshot.revision <= revision) return;
  revision = event.snapshot.revision;
  const system = event.snapshot.system;
  const snapshot = Object.freeze({ revision, windows: Object.freeze(event.snapshot.windows.map(info => Object.freeze({ ...info, display: info.display ? Object.freeze({ ...info.display }) : info.display }))), system: Object.freeze({ ...system, displays: Object.freeze(system.displays.map(display => Object.freeze({ ...display }))), capabilities: Object.freeze({ ...system.capabilities }) }) });
  latestSnapshot = snapshot;
  for (const id of Array.from(listeners.keys())) {
    if (event.generation !== generation) break;
    notify(id, snapshot);
  }
}
Object.assign(globalThis, { weberWindowDeliver: deliver });
if (typeof globalThis.weberNativeTransport !== 'function') window.addEventListener('weber:window-state', event => deliver((event as CustomEvent).detail));
/** Initial + changed app-wide snapshots, coalesced to latest state. No idle polling.
 * Not an event history: an intermediate resize or briefly lived window may be omitted.
 * Unsubscribe in your component cleanup. Native close/navigation releases the watch.
 */
export function onWindowsChanged(listener: (snapshot: WindowSnapshot) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('Window state callback required');
  if (listeners.size >= 64) throw new RangeError('Window state listener limit reached');
  if (!listeners.size) { generation = request({ op: 'watch' }).generation; revision = -1; latestSnapshot = undefined; }
  const id = nextListener++; listeners.set(id, { next: listener, revision: -1 });
  const subscribed = generation;
  if (latestSnapshot) queueMicrotask(() => { if (subscribed === generation && latestSnapshot) notify(id, latestSnapshot); });
  return () => {
    if (!listeners.delete(id) || listeners.size) return;
    const previous = generation; generation = undefined;
    request({ op: 'unwatch', generation: previous });
  };
}

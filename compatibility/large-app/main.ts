import { defineApp } from '@weber/runtime';
import profile from './profile.json';

type Context = { signal: AbortSignal; defer(cleanup: () => void): void };
type Check = (context: Context) => Promise<void>;
const report = (data: object) => (window as unknown as { weberHostCall(input: string): string }).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const asset = (path: string) => new URL(path, location.href).href;
function message(target: MessagePort | Worker, signal: AbortSignal): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const clear = () => { target.removeEventListener('message', received); target.removeEventListener('messageerror', failed); target.removeEventListener('error', workerFailed); signal.removeEventListener('abort', aborted); };
    const received = (event: Event) => { clear(); resolve(event as MessageEvent); };
    const failed = () => { clear(); reject(new Error('Message deserialization failed')); };
    const workerFailed = (event: Event) => { event.preventDefault(); clear(); reject(new Error((event as ErrorEvent).message || 'Worker failed')); };
    const aborted = () => { clear(); reject(signal.reason); };
    target.addEventListener('message', received); target.addEventListener('messageerror', failed);
    target.addEventListener('error', workerFailed);
    signal.addEventListener('abort', aborted, { once: true });
    if (target instanceof MessagePort) target.start();
    if (signal.aborted) aborted();
  });
}
function worker(context: Context, module = false) {
  const instance = new Worker(asset(module ? '/module-worker.js' : '/classic-worker.js'), module ? { type: 'module' } : undefined);
  context.defer(() => instance.terminate()); return instance;
}
function channel(context: Context) {
  const value = new MessageChannel(); context.defer(() => { value.port1.close(); value.port2.close(); }); return value;
}
function request<T>(operation: IDBRequest<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    operation.onsuccess = () => { signal.removeEventListener('abort', aborted); resolve(operation.result); };
    operation.onerror = () => { signal.removeEventListener('abort', aborted); reject(operation.error); };
    if (signal.aborted) aborted();
  });
}
const checks: Record<string, Check> = {
  async 'message-channel'(context) {
    const ports = channel(context), received = message(ports.port1, context.signal);
    ports.port2.postMessage({ text: '한글 😀', nested: [1, true, null] });
    assert(JSON.stringify((await received).data) === JSON.stringify({ text: '한글 😀', nested: [1, true, null] }), 'Structured message changed');
  },
  async 'array-buffer-transfer'(context) {
    const ports = channel(context), buffer = new Uint8Array(32768); buffer[0] = 37; buffer[32767] = 91;
    const received = message(ports.port1, context.signal); ports.port2.postMessage(buffer.buffer, [buffer.buffer]);
    assert(buffer.byteLength === 0, 'Sender buffer was not detached');
    const result = new Uint8Array((await received).data);
    assert(result.length === 32768 && result[0] === 37 && result[32767] === 91, 'Transferred bytes changed');
  },
  async 'transferred-port-close'(context) {
    const ports = channel(context), transferred = structuredClone(ports.port2, { transfer: [ports.port2] });
    context.defer(() => { transferred.close(); transferred.close(); });
    // Closing the detached sender must neither panic nor close its new owner.
    ports.port2.close(); ports.port2.close(); ports.port2.start(); ports.port2.postMessage('ignored');
    const received = message(transferred, context.signal); ports.port1.postMessage('still-owned');
    assert((await received).data === 'still-owned', 'Closing the transferred sender affected the receiving port');
  },
  async 'classic-worker'(context) {
    const instance = worker(context), received = message(instance, context.signal);
    instance.postMessage('한글 😀'); assert((await received).data === '한글 😀', 'Worker echo changed');
  },
  async 'worker-message-port'(context) {
    const instance = worker(context), ports = channel(context), received = message(ports.port1, context.signal);
    instance.postMessage({ port: ports.port2 }, [ports.port2]); ports.port1.postMessage('worker-port');
    assert((await received).data === 'worker-port', 'Transferred worker port did not echo');
  },
  async 'module-worker'(context) {
    const instance = worker(context, true), received = message(instance, context.signal);
    instance.postMessage(null); assert((await received).data === 42, 'Worker did not execute its imported module');
  },
  async 'dynamic-import'() {
    const url = asset('/module-value.mjs');
    const module = await import(/* @vite-ignore */ url);
    assert(module.answer === 42, 'Dynamic module export missing');
  },
  async 'wasm-instantiate'() {
    const response = await fetch(asset('/empty.wasm')); assert(response.ok, 'Wasm asset missing');
    const result = await WebAssembly.instantiate(await response.arrayBuffer());
    assert(result.instance instanceof WebAssembly.Instance, 'Wasm instantiation failed');
  },
  async 'wasm-streaming'() {
    const result = await WebAssembly.instantiateStreaming(fetch(asset('/empty.wasm')));
    assert(result.instance instanceof WebAssembly.Instance, 'Streaming wasm instantiation failed');
  },
  async 'indexeddb-binary'(context) {
    const name = `weber-large-app-${Date.now()}-${Math.random()}`, opening = indexedDB.open(name, 1);
    let database: IDBDatabase | undefined;
    context.defer(() => { database?.close(); indexedDB.deleteDatabase(name); });
    opening.onupgradeneeded = () => opening.result.createObjectStore('files');
    opening.addEventListener('success', () => { if (context.signal.aborted) { opening.result.close(); indexedDB.deleteDatabase(name); } });
    database = await request(opening, context.signal);
    const transaction = database.transaction('files', 'readwrite'), stored = new Uint8Array([0, 37, 255]);
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { try { transaction.abort(); } catch {} reject(context.signal.reason); };
      context.signal.addEventListener('abort', aborted, { once: true });
      const clear = () => context.signal.removeEventListener('abort', aborted);
      transaction.oncomplete = () => { clear(); resolve(); };
      transaction.onabort = transaction.onerror = () => { clear(); reject(transaction.error ?? new Error('IndexedDB transaction failed')); };
      transaction.objectStore('files').put(stored.buffer, 'document');
    });
    const value = await request(database.transaction('files').objectStore('files').get('document'), context.signal);
    assert(JSON.stringify([...new Uint8Array(value)]) === '[0,37,255]', 'IndexedDB binary roundtrip changed');
  },
  async 'canvas-text'() {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); assert(context, 'Canvas 2D missing');
    context!.font = '16px monospace'; assert(context!.measureText('editor').width > 0, 'Text metrics missing');
    context!.fillStyle = '#ff0000'; context!.fillRect(0, 0, 4, 4);
    assert(context!.getImageData(1, 1, 1, 1).data[0] === 255, 'Canvas pixels missing');
  },
  async 'range-geometry'(context) {
    const element = document.createElement('div'); element.style.cssText = 'position:absolute;left:20px;top:20px;font:16px monospace;white-space:pre';
    element.textContent = 'editor 한글'; document.body.append(element); context.defer(() => element.remove());
    const range = document.createRange(); range.setStart(element.firstChild!, 1); range.setEnd(element.firstChild!, 5);
    const rect = range.getBoundingClientRect();
    assert(rect.width > 0 && rect.height > 0 && rect.x >= 20, `Text range has no live geometry: ${JSON.stringify({ range: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, element: element.getBoundingClientRect().toJSON(), fragments: range.getClientRects().length })}`);
  },
  async 'resize-observer'(context) {
    const element = document.createElement('div'); element.style.cssText = 'width:48px;height:10px'; document.body.append(element);
    context.defer(() => element.remove());
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(context.signal.reason);
      context.signal.addEventListener('abort', aborted, { once: true });
      const observer = new ResizeObserver(entries => {
        if (entries.some(entry => entry.contentRect.width === 96)) { context.signal.removeEventListener('abort', aborted); resolve(); }
        else element.style.width = '96px';
      });
      context.defer(() => { observer.disconnect(); context.signal.removeEventListener('abort', aborted); }); observer.observe(element);
    });
  },
};

defineApp({ title: 'Weber large-app compatibility', mount(root) {
  root.innerHTML = '<h1>Large-app browser primitives</h1><p>This is not a VS Code port.</p><pre id="results"></pre>';
  let disposed = false, active: AbortController | undefined;
  const results: { id: string; status: 'pass' | 'fail'; error?: string }[] = [];
  void (async () => {
    report({ stage: 'ready', title: document.title });
    for (const id of profile.required) {
      if (disposed) return;
      const controller = new AbortController(), cleanup: (() => void)[] = []; active = controller;
      const timer = setTimeout(() => controller.abort(new Error('Case timed out')), profile.timeoutMs);
      report({ stage: 'large-app-case-start', id });
      try {
        await Promise.race([
          Promise.resolve().then(() => checks[id]({ signal: controller.signal, defer: fn => cleanup.push(fn) })),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
        ]);
        results.push({ id, status: 'pass' });
      } catch (error) { results.push({ id, status: 'fail', error: String(error).slice(0, 500) }); }
      finally { clearTimeout(timer); for (const release of cleanup.reverse()) { try { release(); } catch {} } }
      if (disposed) return;
      root.querySelector('#results')!.textContent = results.map(result => `${result.status}: ${result.id}${result.error ? ` — ${result.error}` : ''}`).join('\n');
      report({ stage: 'large-app-case', ...results.at(-1) });
    }
    report({ stage: 'large-app-result', profile: profile.id, href: location.href, origin: location.origin, userAgent: navigator.userAgent, results });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!disposed) location.href = 'weber://close';
  })().catch(error => report({ stage: 'failure', message: String(error) }));
  return () => { disposed = true; active?.abort(new Error('Application disposed')); };
} });

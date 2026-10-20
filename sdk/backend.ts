export type BackendValue = null | boolean | number | string | BackendValue[] | { [key: string]: BackendValue };
export interface InvokeOptions { timeoutMs?: number }
declare global { var weberBackendTransport: undefined | ((request: string) => string); }

function encode(value: unknown): string {
  const result = JSON.stringify(value, (_, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Backend values must be finite JSON');
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)) throw new TypeError('Backend values must be JSON');
    return item;
  });
  if (result.length > 16000) throw new RangeError('Backend request exceeds client limit');
  return result;
}
function transport(request: Record<string, unknown>) {
  let response: string;
  if (typeof globalThis.weberBackendTransport === 'function') response = globalThis.weberBackendTransport(encode(request));
  else {
    const call = (globalThis as unknown as { weberHostCall?: (input: string) => string }).weberHostCall;
    const capability = document.querySelector('meta[name="weber-backend"]')?.getAttribute('content');
    if (!call || !capability) throw new Error('This application has no Bun backend connection');
    response = call(encode({ action: 'backend', capability, request }));
  }
  const result = JSON.parse(response);
  if (!result?.ok) throw Object.assign(new Error(result?.error?.message ?? 'Backend connection failed'), { name: result?.error?.name ?? 'BackendError' });
  return result;
}
const waiting = new Map<number, { resolve(value: BackendValue): void; reject(error: Error): void; deadline: number }>();
let scheduled = false;
function schedule() { if (!scheduled && waiting.size) { scheduled = true; setTimeout(poll, 8); } }
function poll() {
  scheduled = false;
  for (const [id, call] of waiting) {
    try {
      if (performance.now() >= call.deadline) {
        try { transport({ op: 'cancel', id }); } catch { /* Timeout is the primary error. */ }
        throw Object.assign(new Error('Backend invocation timed out'), { name: 'BackendTimeoutError' });
      }
      const response = transport({ op: 'poll', id });
      if (!response.pending) { waiting.delete(id); call.resolve(response.result); }
    } catch (error) { waiting.delete(id); call.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  schedule();
}
/** Calls an explicitly exported Bun backend method; this does not add Node globals to the UI. */
export function invoke<T extends BackendValue = BackendValue>(method: string, params: BackendValue = null, options: InvokeOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const timeoutMs = options.timeoutMs ?? 30000;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError('Backend timeout must be 1..60000ms');
      const { id } = transport({ op: 'call', method, params });
      waiting.set(id, { resolve: value => resolve(value as T), reject, deadline: performance.now() + timeoutMs }); schedule();
    } catch (error) { reject(error); }
  });
}

export interface SubscriptionOptions { onError?(error: Error): void; onEnd?(): void }
const subscriptions = new Map<number, { next(value: BackendValue): void; options: SubscriptionOptions }>();
function deliver(events: Array<{ id: number; kind: string; value?: BackendValue; ok?: boolean; error?: { name?: string; message?: string } }>) {
  for (const event of events) {
    const subscription = subscriptions.get(event.id);
    if (!subscription) continue;
    try {
      if (event.kind === 'event') subscription.next(event.value ?? null);
      else {
        subscriptions.delete(event.id);
        if (event.ok === false) subscription.options.onError?.(Object.assign(new Error(event.error?.message ?? 'Backend subscription failed'), { name: event.error?.name ?? 'BackendError' }));
        else subscription.options.onEnd?.();
      }
    } catch (error) { console.error('Backend subscription callback:', error); }
  }
}
Object.assign(globalThis, { weberBackendDeliver: deliver });
if (typeof globalThis.weberBackendTransport !== 'function') window.addEventListener('weber:backend-events', event => deliver((event as CustomEvent).detail));
/** Starts a backend method with { signal, emit }; native wakeups deliver events without an idle polling timer. */
export function subscribe<T extends BackendValue = BackendValue>(method: string, params: BackendValue, next: (value: T) => void, options: SubscriptionOptions = {}): () => void {
  if (typeof next !== 'function') throw new TypeError('Subscription callback required');
  const { id } = transport({ op: 'subscribe', method, params });
  subscriptions.set(id, { next: value => next(value as T), options });
  return () => { if (subscriptions.delete(id)) transport({ op: 'cancel', id }); };
}

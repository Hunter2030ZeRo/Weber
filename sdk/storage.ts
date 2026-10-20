import { nativeRequest } from './window';
export type StorageValue = null | boolean | number | string | StorageValue[] | { [key: string]: StorageValue };
export type StorageArea = 'config' | 'data';
export interface AppPaths { config: string; data: string; cache: string }
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; deadline: number }>();
let scheduled = false;
function schedule() { if (!scheduled && pending.size) { scheduled = true; setTimeout(poll, 8); } }
function poll() {
  scheduled = false;
  for (const [requestId, call] of pending) {
    try {
      if (performance.now() >= call.deadline) {
        try { nativeRequest({ op: 'storage.cancel', requestId }); } catch { /* Preserve the timeout. */ }
        throw new Error('Storage request timed out; an issued write may still complete');
      }
      const reply = nativeRequest({ op: 'storage.poll', requestId });
      if (!reply.pending) { pending.delete(requestId); call.resolve(reply.value); }
    } catch (error) { pending.delete(requestId); call.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  schedule();
}
function call<T>(action: string, area?: StorageArea, key?: string, value?: StorageValue): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const request = { op: 'storage.start', action, area, key, value };
      if (action === 'set') {
        const serialized = JSON.stringify(value, (_, item) => {
        if (typeof item === 'undefined') throw new TypeError('Storage requires JSON values');
        if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Storage requires finite JSON values');
        if (['bigint', 'symbol', 'function'].includes(typeof item)) throw new TypeError('Storage requires JSON values');
        return item;
        });
        if (new TextEncoder().encode(serialized).length > 1048576) throw new RangeError('Storage value exceeds 1048576 JSON bytes');
      }
      const { id } = nativeRequest(request);
      pending.set(id, { resolve: result => resolve(result as T), reject, deadline: performance.now() + 30000 });
      schedule();
    } catch (error) { reject(error); }
  });
}
/** Paths follow the OS app directories and are scoped to manifest id. No directories are created by this query. */
export function getAppPaths(): Promise<AppPaths> { return call('paths'); }
/** Missing keys return null. Values are JSON, at most 1 MiB encoded; 128 keys and 16 MiB per area. */
export function getValue<T extends StorageValue = StorageValue>(key: string, area: StorageArea = 'config'): Promise<T | null> { return call('get', area, key); }
/** Atomic file replacement on the worker thread. App windows share one ordered queue. */
export function setValue(key: string, value: StorageValue, area: StorageArea = 'config'): Promise<void> { return call('set', area, key, value); }
export function removeValue(key: string, area: StorageArea = 'config'): Promise<boolean> { return call('remove', area, key); }
export function listKeys(area: StorageArea = 'config'): Promise<string[]> { return call('keys', area); }

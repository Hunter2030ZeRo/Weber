import { nativeRequest } from './window';

const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; deadline: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() { if (timer === undefined && pending.size) timer = setTimeout(poll, 8); }
function poll() {
  timer = undefined;
  for (const [requestId, call] of pending) {
    try {
      if (performance.now() >= call.deadline) {
        try { nativeRequest({ op: 'clipboard.cancel', requestId }); } catch { /* Preserve the timeout. */ }
        throw new Error('Clipboard request timed out; an issued write may still complete');
      }
      const result = nativeRequest({ op: 'clipboard.poll', requestId });
      if (!result.pending) { pending.delete(requestId); call.resolve(result.value); }
    } catch (error) { pending.delete(requestId); call.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  schedule();
}
function call<T>(action: 'read' | 'write', text?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      if (action === 'write') {
        if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string');
        if (text.includes('\0')) throw new TypeError('Clipboard text must not contain NUL');
        if (new TextEncoder().encode(text).length > 262144) throw new RangeError('Clipboard text exceeds 262144 UTF-8 bytes');
      }
      const { id } = nativeRequest({ op: 'clipboard.start', action, text });
      pending.set(id, { resolve: value => resolve(value as T), reject, deadline: performance.now() + 10000 });
      schedule();
    } catch (error) { reject(error instanceof Error && error.message === 'Unknown native operation' ? new Error('Clipboard API unavailable; update the native runtime to clipboardProtocol 1') : error); }
  });
}
/** Read system clipboard text. The calling app window must have keyboard focus. */
export function readText(): Promise<string> { return call('read'); }
/** Offer up to 256 KiB of UTF-8 text; resolves when submitted, not when pasted.
 * Wayland clipboard contents are served while this app remains running. */
export function writeText(text: string): Promise<void> { return call('write', text); }

import { nativeRequest } from './window';
export interface TextFile { name: string; text: string }
export interface SavedFile { name: string }
export interface FileOptions { signal?: AbortSignal }
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; deadline: number; cleanup(): void }>();
let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() { if (timer === undefined && pending.size) timer = setTimeout(poll, 16); }
function discard(id: number) { try { nativeRequest({ op: 'files.cancel', requestId: id }); } catch { /* Preserve original failure. */ } }
function poll() {
  timer = undefined;
  for (const [id, call] of pending) {
    try {
      if (performance.now() >= call.deadline) { discard(id); throw new Error('File request timed out; an issued save may have completed'); }
      const result = nativeRequest({ op: 'files.poll', requestId: id });
      if (!result.pending) { pending.delete(id); call.cleanup(); call.resolve(result.value); }
    } catch (error) { pending.delete(id); call.cleanup(); call.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  schedule();
}
function call<T>(request: Record<string, unknown>, { signal }: FileOptions): Promise<T | null> {
  return new Promise((resolve, reject) => {
    try {
      if (signal?.aborted) throw new DOMException('File request cancelled', 'AbortError');
      const { id } = nativeRequest({ op: 'files.start', ...request });
      const abort = () => { const call = pending.get(id); if (!call) return; pending.delete(id); discard(id); call.cleanup(); reject(new DOMException('File request cancelled', 'AbortError')); };
      pending.set(id, { resolve: value => resolve(value as T | null), reject, deadline: performance.now() + 125000, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      schedule();
    } catch (error) { reject(error instanceof Error && error.message === 'Unknown native operation' ? new Error('File API unavailable; update the native runtime to fileDialogProtocol 1') : error); }
  });
}
/** Ask the desktop to select one UTF-8 file (up to 256 KiB). Cancel returns null. */
export function openTextFile(options: FileOptions = {}): Promise<TextFile | null> { return call({ action: 'open' }, options); }
/** Select a destination and atomically replace it. No Node/Bun dependency.
 * Cancel returns null. Once replacement is issued, cancellation cannot undo it. */
export function saveTextFile(text: string, name = 'note.txt', options: FileOptions = {}): Promise<SavedFile | null> {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 262144) return Promise.reject(new RangeError('File text must be a string of at most 262144 UTF-8 bytes'));
  if (typeof name !== 'string' || !name.length || new TextEncoder().encode(name).length > 255 || /[/\\\0]/.test(name) || name === '.' || name === '..') return Promise.reject(new TypeError('Invalid suggested file name'));
  return call({ action: 'save', text, name }, options);
}

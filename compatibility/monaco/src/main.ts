import { defineApp } from '@weber/runtime';
export const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
window.addEventListener('error', event => report({ stage: 'monaco-error', message: event.message, stack: event.error?.stack }));
window.addEventListener('unhandledrejection', event => report({ stage: 'monaco-error', message: String(event.reason), stack: event.reason?.stack }));
defineApp({ title: 'Weber · actual Monaco 0.57.0', mount(root) {
  root.textContent = 'Loading Monaco 0.57.0…';
  let dispose: (() => void) | undefined, disposed = false;
  void import('./editor').then(async module => {
    if (!disposed) { const result = await module.run(root); if (disposed) result(); else dispose = result; }
  }).catch(error => report({ stage: 'monaco-fatal', message: String(error), stack: error?.stack }));
  return () => { disposed = true; dispose?.(); };
} });

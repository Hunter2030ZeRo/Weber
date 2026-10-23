// Acceptance observer, copied only into generated test projects.
import { currentWindow, setWindowTitle, closeWindow } from '@weber/sdk/window';
import { setValue, getValue, removeValue } from '@weber/sdk/storage';
const page = Math.random().toString(36);
let remounts = 0, trustedInputs = 0, compositions = 0, sdk = false, previous = '';
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
window.addEventListener('error', event => report({ stage: 'failure', message: event.message }));
window.addEventListener('unhandledrejection', event => report({ stage: 'failure', message: String(event.reason) }));
document.addEventListener('input', event => { if (event.isTrusted) trustedInputs++; }, true);
document.addEventListener('compositionend', event => { if (event.isTrusted) compositions++; }, true);
window.addEventListener('keydown', event => {
  void (async () => {
    if (event.key === 'F6') document.querySelector<HTMLElement>('#name, #note')?.focus();
    if (event.key === 'F7') document.querySelector<HTMLElement>('#counter, #add')?.focus();
    if (event.key === 'F8') {
      const app = (globalThis as any).WeberUserApp;
      // Also cancel a new mount immediately, before async framework setup runs.
      for (let attempt = 0; attempt < 2; attempt++) {
        app.unmount(); app.mount(document.getElementById('aot-dom-root'));
      }
      remounts++;
    }
    if (event.key === 'F9') {
      const window = currentWindow();
      setWindowTitle('Framework native API verified', window.id);
      await setValue('framework-probe', { text: '한글', window: window.id });
      const stored = await getValue<{ text: string; window: number }>('framework-probe');
      if (stored?.text !== '한글' || stored.window !== window.id) throw new Error('Native storage roundtrip failed');
      await removeValue('framework-probe'); sdk = true;
    }
    if (event.key === 'F10') closeWindow();
  })().catch(error => report({ stage: 'failure', message: String(error) }));
});
setInterval(() => {
  const button = document.querySelector('#counter, #add');
  const input = document.querySelector<HTMLInputElement>('#name, #note');
  if (!button || !input) return;
  const state = { page, count: button.textContent, value: input.value,
    greeting: document.querySelector('#greeting')?.textContent,
    notes: Array.from(document.querySelectorAll('#notes li')).map(item => item.textContent),
    width: (document.getElementById('indicator') as HTMLElement | null)?.style.width,
    heading: document.querySelector('h1')?.textContent, color: getComputedStyle(button).color,
    buttons: document.querySelectorAll('#counter, #add').length,
    remounts, trustedInputs, compositions, sdk };
  const serialized = JSON.stringify(state);
  if (serialized !== previous) { previous = serialized; report({ stage: 'framework-state', ...state }); }
}, 150);

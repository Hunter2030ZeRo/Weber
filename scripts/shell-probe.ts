// Test observer only; not shipped in the shell template.
let clicks = 0, inputs = 0, compositions = 0, previous = '';
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
document.addEventListener('click', event => { if (event.isTrusted) clicks++; }, true);
document.addEventListener('input', event => { if (event.isTrusted) inputs++; }, true);
document.addEventListener('compositionend', event => { if (event.isTrusted) compositions++; }, true);
window.addEventListener('error', event => report({ stage: 'failure', message: event.message }));
window.addEventListener('unhandledrejection', event => report({ stage: 'failure', message: String(event.reason) }));
window.addEventListener('keydown', event => { if (event.key === 'F6') document.getElementById('search')?.focus(); });
setInterval(() => {
  const root = document.getElementById('aot-dom-root'); if (!root?.firstChild) return;
  const rect = (id: string) => { const r = document.getElementById(id)?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; };
  const state = { mode: root.className, connected: root.dataset.connected, workspace: root.dataset.workspace,
    query: (document.getElementById('search') as HTMLInputElement | null)?.value,
    windows: Array.from(document.querySelectorAll<HTMLButtonElement>('#windows button')).map(button => ({ address: button.dataset.address, title: button.textContent })),
    status: document.getElementById('status')?.textContent, clicks, inputs, compositions,
    launcher: rect('launcher'), stop: rect('stop-panel'), workspace2: rect('workspace-2'), height: innerHeight };
  const value = JSON.stringify(state); if (value !== previous) { previous = value; report({ stage: 'shell-state', ...state }); }
}, 150);

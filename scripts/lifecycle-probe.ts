import { defineApp } from '@weber/runtime';
import { currentWindow, openWindow, closeWindow, listWindows, setWindowTitle, nativeRequest } from '@weber/sdk/window';
import { getValue, setValue, getAppPaths } from '@weber/sdk/storage';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
async function until(test: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) { if (test()) return; await wait(20); }
  throw new Error('Timed out: ' + label);
}
const cycleCount = 50;
async function hold(phase: string, cycles: number, ms: number) {
  report({ stage: 'lifecycle-phase', phase, cycles });
  await wait(ms);
  report({ stage: 'lifecycle-phase-end', phase, cycles });
}
const boundary = '\n'.repeat(524287); // Exactly 1 MiB once JSON encoded, including quotes.
async function run(root: HTMLElement) {
  root.innerHTML = '<h1>Weber document and lifecycle acceptance</h1><input id="typing" value="한글 😀"><div id="rows"></div>';
  const rows = document.getElementById('rows')!;
  for (let i = 0; i < 80; i++) { const row = document.createElement('div'); row.textContent = `Row ${i}: text and layout`; rows.append(row); }
  const self = currentWindow().id;
  if (self !== 1) {
    const other = await getValue<number>('parent-request');
    let denied = false; try { nativeRequest({ op: 'storage.poll', requestId: other }); } catch { denied = true; }
    check(denied, 'Child cannot consume parent storage result');
    for (let i = 0; i < 31; i++) nativeRequest({ op: 'storage.start', action: 'paths' });
    report({ stage: 'lifecycle-child', id: self, abandoned: 31 });
    setWindowTitle('queued-' + self);
    return;
  }
  if (await getValue('run-complete') === true) {
    check(await getValue('boundary', 'data') === boundary, 'Large escaped JSON persists after restart');
    report({ stage: 'lifecycle-restored', passed: true }); closeWindow(); return;
  }
  await setValue('boundary', boundary, 'data');
  check(await getValue('boundary', 'data') === boundary, '1 MiB escaped JSON roundtrip');
  const unicode = '한글 😀\n'.repeat(10000);
  await setValue('unicode', unicode, 'data');
  check(await getValue('unicode', 'data') === unicode, 'Unicode document roundtrip beyond old value limit');
  let rejected = 0;
  try { await setValue('too-large', boundary + '\n', 'data'); } catch { rejected++; }
  try { nativeRequest({ op: 'storage.start', action: 'set', area: 'data', key: 'too-large', value: boundary + '\n' }); } catch { rejected++; }
  check(rejected === 2, 'Both SDK and native validate encoded byte limit');
  check(await getValue('boundary', 'data') === boundary, 'Rejected write preserves prior document');
  const request = nativeRequest({ op: 'storage.start', action: 'paths' }).id;
  await setValue('parent-request', request);
  await hold('baseline', 0, 5000);
  const times: number[] = [];
  for (let cycle = 1; cycle <= cycleCount; cycle++) {
    const started = performance.now();
    const child = await openWindow({ title: 'Cycle ' + cycle, width: 480, height: 320 });
    await until(() => listWindows().some(w => w.id === child.id && w.title === 'queued-' + child.id), 'child request setup');
    closeWindow(child.id);
    await until(() => listWindows().length === 1, 'child disposal');
    // The child's abandoned results must not consume app-wide pending slots.
    await Promise.all(Array.from({ length: 31 }, () => getAppPaths()));
    times.push(performance.now() - started);
    if (cycle % 10 === 0) await hold('cycle-' + cycle, cycle, 2000);
  }
  const reply = nativeRequest({ op: 'storage.poll', requestId: request });
  check(reply.pending === false, 'Parent result survives other window disposal');
  await setValue('run-complete', true);
  await hold('settled', cycleCount, 5000);
  report({ stage: 'lifecycle-pass', passed: true, cycles: cycleCount, abandonedRequests: cycleCount * 31, times, boundaryJsonBytes: 1048576, unicodeUtf8Bytes: new TextEncoder().encode(unicode).length });
  closeWindow();
}
defineApp({ mount(root) { void run(root).catch(error => report({ stage: 'failure', message: String(error), stack: error?.stack })); } });

import { defineApp } from '@weber/runtime';
import { closeWindow } from '@weber/sdk/window';
import { getValue, setValue } from '@weber/sdk/storage';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
async function run(root: HTMLElement) {
  root.innerHTML = '<h1>Weber native document transfer</h1><p>Same app and durable storage on both hosts.</p>';
  const cases = [['small', '한글 😀'], ['ascii', 'x'.repeat(1048574)], ['escaped', '\n'.repeat(524287)]] as const;
  report({ stage: 'ready' });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (const [phase, value] of cases) {
    // Warm both JS and the storage worker before counting operations.
    await setValue('document', value);
    if (await getValue('document') !== value) throw new Error('Warmup mismatch');
    report({ stage: 'transfer-phase', phase }); await wait(1000);
    const times: number[] = [];
    for (let i = 0; i < 32; i++) {
      const start = performance.now();
      await setValue('document', value);
      if (await getValue('document') !== value) throw new Error('Document mismatch');
      times.push(performance.now() - start);
    }
    report({ stage: 'transfer-phase-end', phase, pairs: times.length, jsonBytes: new TextEncoder().encode(JSON.stringify(value)).length, times });
    await wait(1000);
  }
  report({ stage: 'transfer-pass', passed: true }); closeWindow();
}
defineApp({ mount(root) { void run(root).catch(error => report({ stage: 'failure', message: String(error), stack: error?.stack })); } });

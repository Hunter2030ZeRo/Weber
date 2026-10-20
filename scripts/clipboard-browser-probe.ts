// Test-only observer/setup. Clipboard actions are native keyboard shortcuts;
// this fixture never calls the SDK clipboard API or dispatches synthetic events.
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const sample = 'GTK에서 복사한 텍스트 😀\nSecond line';
const cutText = 'Single line 한글 😀';
const customText = 'Custom copy 한글 😀';
const editableText = 'Editable 한글 😀';
const events: { type: string; trusted: boolean; text?: string; inputType?: string }[] = [];
let overrideCopy = false, blockPaste = false, phase = 0, busy = false;
for (const type of ['copy', 'cut', 'paste']) document.addEventListener(type, raw => {
  const event = raw as ClipboardEvent;
  events.push({ type, trusted: event.isTrusted, text: event.clipboardData?.getData('text/plain') });
  if (type === 'copy' && overrideCopy) { event.preventDefault(); event.clipboardData!.setData('text/plain', customText); }
  if (type === 'paste' && blockPaste) event.preventDefault();
  report({ stage: 'browser-clipboard-event', type, trusted: event.isTrusted });
});
document.addEventListener('input', raw => {
  const event = raw as InputEvent;
  events.push({ type: 'input', trusted: event.isTrusted, inputType: event.inputType });
  report({ stage: 'browser-input', inputType: event.inputType });
});
let single: HTMLInputElement, editable: HTMLDivElement;
async function advance() {
  const note = document.getElementById('note') as HTMLTextAreaElement;
  if (phase === 0) {
    for (let i = 0; i < 200 && document.getElementById('status')?.textContent !== 'Loaded'; i++) await pause(20);
    note.value = ''; note.focus();
    single = document.createElement('input'); single.id = 'browser-single'; document.body.append(single);
    editable = document.createElement('div'); editable.contentEditable = 'true'; editable.id = 'browser-editable'; document.body.append(editable);
  } else if (phase === 1) {
    check(note.value === sample, 'Native textarea paste value: ' + note.value);
    check(events.some(e => e.type === 'paste' && e.trusted && e.text === sample), 'Trusted paste event/data');
  } else if (phase === 2) {
    check(events.some(e => e.type === 'copy' && e.trusted), 'Trusted copy event');
    single.value = cutText; single.focus();
  } else if (phase === 3) {
    check(single.value === '', 'Native input cut removes selection: ' + single.value);
    check(events.some(e => e.type === 'cut' && e.trusted), 'Trusted cut event');
    overrideCopy = true; single.value = 'default selection'; single.focus();
  } else if (phase === 4) {
    overrideCopy = false; blockPaste = true; single.value = 'Keep this value'; single.focus();
  } else if (phase === 5) {
    check(single.value === 'Keep this value', 'preventDefault cancels paste');
    blockPaste = false; single.value = ''; single.focus();
  } else if (phase === 6) {
    check(single.value === customText, 'Native input paste: ' + single.value);
    editable.focus();
    const range = document.createRange(); range.selectNodeContents(editable); range.collapse(false);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  } else if (phase === 7) {
    // Report the engine gap honestly; it is not a supported-case pass.
    report({ stage: 'browser-contenteditable', supported: editable.textContent === editableText, actual: editable.textContent, expected: editableText });
    single.value = 'Read only'; single.readOnly = true; single.focus();
  } else if (phase === 8) {
    check(single.value === 'Read only', 'Readonly cut/paste preserve value: ' + single.value);
    check(events.some(e => e.type === 'input' && e.inputType === 'insertFromPaste'), 'Paste input event');
    check(events.some(e => e.type === 'input' && e.inputType === 'deleteByCut'), 'Cut input event');
    single.readOnly = false; single.value = '한'.repeat(2731); single.focus();
  } else if (phase === 9) {
    check(single.value === '한'.repeat(2731), 'Oversized default cut preserves the original text');
    single.value = 'Cut recovered 한글 😀'; single.focus();
  } else if (phase === 10) {
    check(single.value === '', 'Default cut recovers after rejected oversized cut');
  }
  report({ stage: 'browser-phase', phase: phase++, passed: true, ...(phase === 11 ? { events, navigatorClipboardExposed: !!navigator.clipboard } : {}) });
}
window.addEventListener('keydown', event => {
  if (event.key === 'F8') void import('@weber/sdk/window').then(({ closeWindow }) => { closeWindow(); setTimeout(() => document.getElementById('discard')?.click(), 100); });
  if (event.key !== 'F6' || busy) return;
  busy = true;
  void advance().catch(error => report({ stage: 'failure', message: String(error), stack: error?.stack })).finally(() => { busy = false; });
});

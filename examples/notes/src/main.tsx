import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { getValue, setValue } from '@weber/sdk/storage';
import { openWindow, onCloseRequested } from '@weber/sdk/window';
import { readText, writeText } from '@weber/sdk/clipboard';
import { openTextFile, saveTextFile } from '@weber/sdk/files';
import './style.css';
function Notes() {
  const [note, setNote] = createSignal('');
  const [status, setStatus] = createSignal('Loading…');
  const [busy, setBusy] = createSignal(true);
  const [saved, setSaved] = createSignal('');
  const [fileName, setFileName] = createSignal('note.txt');
  const [question, setQuestion] = createSignal('');
  const locked = () => busy() || !!question();
  const dirty = () => note() !== saved();
  let confirmation: Promise<boolean> | undefined, decide: ((value: boolean) => void) | undefined;
  const confirmDiscard = (message: string): Promise<boolean> => {
    if (!dirty()) return Promise.resolve(true);
    if (confirmation) return confirmation;
    setQuestion(message);
    queueMicrotask(() => document.getElementById('keep-editing')?.focus());
    confirmation = new Promise(resolve => { decide = value => { setQuestion(''); decide = undefined; confirmation = undefined; resolve(value); queueMicrotask(() => document.getElementById('note')?.focus()); }; });
    return confirmation;
  };
  const load = async () => {
    setBusy(true);
    try { const value = await getValue<string>('note', 'data') ?? ''; setNote(value); setSaved(value); setStatus('Loaded'); }
    catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { await setValue('note', note(), 'data'); setSaved(note()); setStatus('Saved'); }
    catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  const clipboard = async (action: 'copy' | 'paste') => {
    if (action === 'paste' && !await confirmDiscard('Replace your unsaved note with clipboard text?')) return;
    setBusy(true);
    try {
      if (action === 'copy') { await writeText(note()); setStatus('Copied'); }
      else { setNote(await readText()); setStatus('Pasted'); }
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  const file = async (action: 'open' | 'save') => {
    if (action === 'open' && !await confirmDiscard('Open a file and discard your unsaved changes?')) return;
    setBusy(true);
    try {
      if (action === 'open') {
        const result = await openTextFile();
        if (result) { setNote(result.text); setSaved(result.text); setFileName(result.name); setStatus('File opened'); }
        else setStatus('Open cancelled');
      } else {
        const result = await saveTextFile(note(), fileName());
        if (result) { setSaved(note()); setFileName(result.name); setStatus('File saved'); }
        else setStatus('Save cancelled');
      }
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  onMount(() => {
    void load();
    const stop = onCloseRequested(() => {
      if (busy()) { setStatus('Finish the current operation before closing.'); return false; }
      return confirmDiscard('Close this window and discard your unsaved changes?');
    });
    onCleanup(() => { decide?.(false); stop(); });
  });
  return <main><h1>Notes</h1><p>Save a note here, or open and save text files.</p><p id="file-name">{fileName()}</p>
    <textarea id="note" aria-label="Note" disabled={locked()} value={note()} onInput={event => setNote(event.currentTarget.value)} />
    <div><button id="save" disabled={locked()} onClick={() => { void save(); }}>Save</button>
    <button id="reload" disabled={locked()} onClick={() => { void confirmDiscard('Reload and discard your unsaved changes?').then(allow => { if (allow) void load(); }); }}>Reload</button>
    <button id="copy" disabled={locked()} onClick={() => { void clipboard('copy'); }}>Copy note</button>
    <button id="paste" disabled={locked()} onClick={() => { void clipboard('paste'); }}>Paste</button>
    <button id="open-file" disabled={locked()} onClick={() => { void file('open'); }}>Open file…</button>
    <button id="save-file" disabled={locked()} onClick={() => { void file('save'); }}>Save file…</button>
    <button id="open" disabled={locked()} onClick={() => { void openWindow({ title: 'Notes', width: 640, height: 480 }).catch(error => setStatus(String(error))); }}>New window</button></div>
    <output id="status" aria-live="polite">{status()}</output><p id="dirty">{dirty() ? 'Unsaved changes' : 'No unsaved changes'}</p>
    <Show when={question()}><section role="dialog" aria-modal="true" aria-label="Unsaved changes" id="discard-dialog"><p>{question()}</p>
      <button id="keep-editing" onClick={() => decide?.(false)}>Keep editing</button>
      <button id="discard" onClick={() => decide?.(true)}>Discard changes</button>
    </section></Show></main>;
}
defineSolidApp(Notes);

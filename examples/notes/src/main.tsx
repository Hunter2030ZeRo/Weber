import { createSignal, onMount } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { getValue, setValue } from '@weber/sdk/storage';
import { openWindow } from '@weber/sdk/window';
import { readText, writeText } from '@weber/sdk/clipboard';
import './style.css';
function Notes() {
  const [note, setNote] = createSignal('');
  const [status, setStatus] = createSignal('Loading…');
  const [busy, setBusy] = createSignal(true);
  const load = async () => {
    setBusy(true);
    try { setNote(await getValue<string>('note', 'data') ?? ''); setStatus('Loaded'); }
    catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { await setValue('note', note(), 'data'); setStatus('Saved'); }
    catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  const clipboard = async (action: 'copy' | 'paste') => {
    setBusy(true);
    try {
      if (action === 'copy') { await writeText(note()); setStatus('Copied'); }
      else { setNote(await readText()); setStatus('Pasted'); }
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  onMount(() => { void load(); });
  return <main><h1>Notes</h1><p>Your note stays here after closing the app.</p>
    <textarea id="note" aria-label="Note" disabled={busy()} value={note()} onInput={event => setNote(event.currentTarget.value)} />
    <div><button id="save" disabled={busy()} onClick={() => { void save(); }}>Save</button>
    <button id="reload" disabled={busy()} onClick={() => { void load(); }}>Reload</button>
    <button id="copy" disabled={busy()} onClick={() => { void clipboard('copy'); }}>Copy note</button>
    <button id="paste" disabled={busy()} onClick={() => { void clipboard('paste'); }}>Paste</button>
    <button id="open" onClick={() => { void openWindow({ title: 'Notes', width: 640, height: 480 }).catch(error => setStatus(String(error))); }}>New window</button></div>
    <output id="status" aria-live="polite">{status()}</output></main>;
}
defineSolidApp(Notes);

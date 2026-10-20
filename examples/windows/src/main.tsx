import { createSignal, onCleanup, onMount } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { subscribe } from '@weber/sdk/backend';
import { currentWindow, openWindow, closeWindow, onWindowsChanged, resizeWindow, setWindowMaximized, setWindowFullscreen } from '@weber/sdk/window';
import './style.css';
function App() {
  const id = currentWindow().id;
  const [time, setTime] = createSignal('Connecting…');
  const [error, setError] = createSignal('');
  const [state, setState] = createSignal(currentWindow());
  let stop: (() => void) | undefined;
  let stopWindows: (() => void) | undefined;
  onMount(() => {
    stop = subscribe<{time:string}>('clock', null, value => setTime(value.time), { onError: error => setError(error.message) });
    stopWindows = onWindowsChanged(snapshot => { const info = snapshot.windows.find(window => window.id === id); if (info) setState(info); });
  });
  onCleanup(() => { stop?.(); stopWindows?.(); });
  return <main><h1>Window {id}</h1><p>{time()}</p>
    <button onClick={() => { void openWindow({ title: 'Another Weber window', width: 640, height: 480 }).catch(error => setError(String(error))); }}>Open window</button>
    <button onClick={() => resizeWindow(640, 480)}>Resize to 640 × 480</button>
    <button onClick={() => setWindowMaximized(!state().maximized)}>Toggle maximize</button>
    <button onClick={() => setWindowFullscreen(!state().fullscreen)}>Toggle fullscreen</button>
    <p>{state().width} × {state().height}, scale {state().scaleFactor}</p>
    <button onClick={() => closeWindow()}>Close this window</button><p role="alert">{error()}</p></main>;
}
defineSolidApp(App);

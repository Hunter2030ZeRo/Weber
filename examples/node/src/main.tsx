import { createSignal } from 'solid-js';
import { defineSolidApp } from '@weber/solid';
import { invoke } from '@weber/sdk/backend';
import './style.css';

export default function NodeApp() {
  const [text, setText] = createSignal('Hello from Weber · 가나다');
  const [result, setResult] = createSignal('Ready');
  const run = () => {
    setResult('Working…');
    invoke('roundTrip', { text: text() }).then(value => setResult(JSON.stringify(value)), error => setResult(String(error)));
  };
  return <main><h1>Node-compatible backend</h1><input value={text()} onInput={event => setText(event.currentTarget.value)} />
    <button id="run" onClick={run}>Run file + crypto task</button><pre id="result">{result()}</pre></main>;
}
defineSolidApp(NodeApp, { title: 'Bun backend · Weber' });

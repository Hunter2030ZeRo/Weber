import { For, Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";

// This exact TSX component is built for both Vite/Servo and Static Hermes AOT.
export function CompatibilityApp() {
  const [count, setCount] = createSignal(0);
  const [text, setText] = createSignal("initial");
  const [rows, setRows] = createSignal([1, 2, 3]);
  const [checked, setChecked] = createSignal(false);
  const [timer, setTimer] = createSignal("pending");
  const [ticks, setTicks] = createSignal(0);
  const [frames, setFrames] = createSignal(0);
  const [stamp, setStamp] = createSignal(0);
  const [animating, setAnimating] = createSignal(true);
  const [microtask, setMicrotask] = createSignal("pending");
  onMount(() => {
    const canceled = window.setTimeout(() => setTimer("canceled-fired"), 0); window.clearTimeout(canceled);
    const timeout = window.setTimeout(function(this: Window, a: string, b: string) { setTimer(this === window ? a + b : "wrong-this"); }, 15, "timer", " ready");
    const interval = window.setInterval(() => setTicks(value => { const next = value + 1; if (next === 3) clearInterval(interval); return next; }), 10);
    onCleanup(() => { clearTimeout(timeout); clearInterval(interval); });
  });
  createEffect(() => {
    if (!animating()) return;
    let frame = 0;
    const animate = (time: number) => { setFrames(value => value + 1); setStamp(time); frame = requestAnimationFrame(animate); };
    frame = requestAnimationFrame(animate);
    onCleanup(() => cancelAnimationFrame(frame));
  });
  return <section id="solid-app" data-runtime="shared-solid-tsx">
    <h2>SolidJS application</h2>
    <button id="solid-counter" onClick={() => setCount(value => value + 1)}>Count: {count()}</button>
    <output id="solid-count">{count()}</output>
    <input id="solid-input" value={text()} onInput={event => setText(event.currentTarget.value)} />
    <output id="solid-text">{text()}</output>
    <button id="solid-reorder" onClick={() => setRows([3, 1, 4])}>Reorder</button>
    <ul id="solid-list"><For each={rows()}>{row => <li data-row={row}>{row}</li>}</For></ul>
    <Show when={count() > 0}><p id="solid-conditional">Visible after click</p></Show>
    <input id="solid-checkbox" type="checkbox" checked={checked()} onClick={event => {
      // Reject the browser's checkbox default action until the counter is odd.
      if (count() % 2 === 0) event.preventDefault();
      else setChecked(event.currentTarget.checked);
    }} />
    <a id="solid-link" href="#solid-allowed" onClick={event => { if (count() % 2 === 0) event.preventDefault(); }}>Conditional navigation</a>
    <button id="solid-stop" onClick={event => event.stopPropagation()}>Stop propagation</button>
    <p>Timer: <output id="solid-timer">{timer()}</output> · Interval: <output id="solid-ticks">{ticks()}</output></p>
    <p>Frames: <output id="solid-frames">{frames()}</output> · Timestamp: <output id="solid-stamp">{stamp()}</output></p>
    <output id="solid-origin">{performance.timeOrigin}</output>
    <div id="solid-orb" style={{ width: "24px", height: "24px", "background-color": "tomato", transform: `translateX(${frames() % 80}px)` }} />
    <button id="solid-motion" onClick={() => setAnimating(value => !value)}>{animating() ? "Pause AOT motion" : "Resume AOT motion"}</button>
    <button id="solid-microtask" onClick={() => { setMicrotask("handler"); queueMicrotask(() => setMicrotask("microtask")); }}>Queue microtask</button>
    <output id="solid-microtask-state">{microtask()}</output>
  </section>;
}

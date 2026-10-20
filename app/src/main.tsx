import { createEffect, createSignal, For, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import "./style.css";
import { runDomTest } from "./dom-test";
import { runBrowserTest } from "./browser-test";
import { CompatibilityApp } from "./compatibility-app";
import { runSolidTest } from "./solid-test";

function App() {
  const [clicks, setClicks] = createSignal(0);
  const [text, setText] = createSignal("");
  const [scroll, setScroll] = createSignal(0);
  const [frames, setFrames] = createSignal(0);
  const [moving, setMoving] = createSignal(true);
  const [elapsed, setElapsed] = createSignal(0);
  const [aotCount, setAotCount] = createSignal(0);
  const aotTest = new URLSearchParams(location.search).has("aotTest");
  const handleAot = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "number") return;
    setAotCount(event.detail);
    if (aotTest) {
      if (event.detail < 3) location.href = "weber://increment";
      else { setMoving(false); location.href = "weber://close"; }
    }
  };
  window.addEventListener("weber:aot", handleAot);
  onCleanup(() => window.removeEventListener("weber:aot", handleAot));
  if (aotTest) setTimeout(() => document.getElementById("aot-counter")?.click(), 500);
  let count = 0;

  createEffect(() => {
    if (!moving()) return;
    const start = performance.now();
    let request = 0;
    const tick = (now: number) => {
      count += 1;
      if (count % 30 === 0) {
        setFrames(count);
        setElapsed(Math.round(now - start));
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(request));
  });
  createEffect(() => {
    document.title = `Weber | aot=${aotCount()} | clicks=${clicks()} | text=${text()} | scroll=${scroll()} | frames=${frames()} | moving=${moving()}`;
  });

  return <main>
    <header><span class="eyebrow">WEBER / FIRST LIGHT</span><span class="engine">Servo + SpiderMonkey</span></header>
    <h1>A native window.<br />A web application.</h1>
    <p class="intro">SolidJS signals, real DOM events, CSS motion. One small surface to test the engine.</p>
    <section class="controls">
      <article><h2>01 / Click</h2><button id="counter" onClick={() => setClicks(n => n + 1)}>Count: {clicks()}</button><p>Click or focus and press Enter.</p></article>
      <article><h2>02 / Type</h2><label for="message">Your message</label><input id="message" value={text()} onInput={e => setText(e.currentTarget.value)} placeholder="Type here" /><output id="echo">{text() || "Waiting for input"}</output></article>
    </section>
    <section class="motion"><div><h2>03 / Animate</h2><p><span id="frames">{frames()}</span> animation frames / {elapsed()} ms</p><button id="motion-toggle" onClick={() => setMoving(value => !value)}>{moving() ? "Pause motion" : "Resume motion"}</button></div><div class="track"><div id="orb" class="orb" style={{ "animation-play-state": moving() ? "running" : "paused" }} /></div></section>
    <section><h2>04 / Scroll <span id="scroll-value">{scroll()} px</span></h2><div id="scrollbox" tabindex="0" onScroll={e => setScroll(Math.round(e.currentTarget.scrollTop))}><For each={Array.from({ length: 40 }, (_, index) => index + 1)}>{row => <div class="row"><span>Row {String(row).padStart(2, "0")}</span><span>Native wheel → Servo → DOM</span></div>}</For></div></section>
    <section><h2>05 / Static Hermes native AOT</h2><a id="aot-counter" href="weber://increment">AOT count: {aotCount()}</a><p>DOM event → native AOT logic → Servo DOM. Experimental two-engine bridge.</p></section>
    <section><h2>06 / AOT DOM binding</h2><a href="weber://dom-start">Handle API</a> · <a href="weber://dom-browser">Browser API</a> · <a href="weber://dom-solid">Solid AOT app</a> · <a href="weber://dom-dispose">Dispose document</a><div id="aot-dom-root" /></section>
    <footer>Wayland · Servo DOM / SpiderMonkey · Static Hermes native AOT logic</footer>
  </main>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root");
render(() => new URLSearchParams(location.search).has("solidWeb") ? <CompatibilityApp /> : <App />, root);
if (["domTest", "browserTest", "solidTest"].some(key => new URLSearchParams(location.search).has(key))) {
  setTimeout(() => {
    document.getElementById("motion-toggle")?.click();
    (new URLSearchParams(location.search).has("solidTest") ? runSolidTest() : new URLSearchParams(location.search).has("browserTest") ? runBrowserTest() : runDomTest()).catch(error => {
      document.title = `Weber DOM binding FAIL: ${String(error)}`;
      location.href = "weber://close";
    });
  }, 500);
}

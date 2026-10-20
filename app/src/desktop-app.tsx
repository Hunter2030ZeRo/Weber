import { For, Show, createEffect, createSignal } from "solid-js";
import { CompatibilityApp } from "./compatibility-app";

// Identical shell and app component in the AOT and SpiderMonkey builds.
export function DesktopApp() {
  const [workspace, setWorkspace] = createSignal(true);
  const [scroll, setScroll] = createSignal(0);
  const [composing, setComposing] = createSignal(false);
  createEffect(() => { document.title = workspace() ? "Weber · 작업 공간" : "Weber · 안내"; });
  return <main id="desktop-shell">
    <header><h1>Weber</h1><nav aria-label="탐색">
      <button id="desktop-workspace" onClick={() => setWorkspace(true)}>작업 공간</button>
      <button id="desktop-about" onClick={() => setWorkspace(false)}>안내</button>
    </nav></header>
    <Show when={workspace()} fallback={<section id="desktop-about-panel"><h2>내 작업 공간</h2><p>입력하고, 목록을 바꾸고, 움직임을 확인할 수 있습니다.</p></section>}>
      <div onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}>
        <CompatibilityApp />
        <output id="desktop-composition">{composing() ? "입력 중" : ""}</output>
      </div>
      <section><h2>목록 <output id="desktop-scroll-position">{scroll()}</output></h2>
        <div id="desktop-scroll" tabindex="0" onScroll={event => setScroll(Math.round(event.currentTarget.scrollTop))}>
          <For each={Array.from({ length: 40 }, (_, index) => index + 1)}>{row => <p>항목 {row}</p>}</For>
        </div>
      </section>
    </Show>
  </main>;
}

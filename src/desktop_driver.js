// Test/measurement glue only. All visible UI/state in AOT mode is compiled TSX.
(() => {
  const config = window.__weberDesktopConfig ?? {};
  const aot = !location.pathname.includes("web");
  const report = data => { window.weberHostCall(JSON.stringify({ action: "telemetry", data: { ...data, engine: aot ? "hermes-aot" : "spidermonkey" } })); };
  report({ stage: "driver-start" });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const snapshot = () => ({ title: document.title, count: document.getElementById("solid-count")?.textContent, text: document.getElementById("solid-text")?.textContent,
    input: document.getElementById("solid-input")?.value, scroll: document.getElementById("desktop-scroll")?.scrollTop,
    layout: ["desktop-shell", "solid-counter", "solid-input", "desktop-scroll"].map(id => { const bounds = document.getElementById(id)?.getBoundingClientRect(); return { id, x: bounds?.x, y: bounds?.y, width: bounds?.width, height: bounds?.height }; }),
    rows: document.getElementById("solid-list")?.textContent, composition: document.getElementById("desktop-composition")?.textContent,
    nodes: document.getElementById("aot-dom-root").querySelectorAll("*").length });
  window.addEventListener("error", event => report({ stage: "error", message: event.message }));
  for (const type of ["input", "click", "keydown", "compositionstart", "compositionupdate", "compositionend", "focusin", "scroll"]) {
    document.addEventListener(type, event => {
      if (!config.mode || config.mode === "smoke") return;
      if (type === "scroll" && event.target?.id !== "desktop-scroll") return;
      const data = { stage: ["input", "click"].includes(type) ? "input-update" : "dom-input", type, target: event.target?.id, trusted: event.isTrusted,
        key: event.key, code: event.code, data: event.data, isComposing: event.isComposing,
        shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey };
      // Native dispatch performs a microtask checkpoint between listeners.
      // Observe after the whole propagation/default-action task, in both engines.
      setTimeout(() => report({ ...data, snapshot: snapshot() }), 0);
    }, true);
  }
  (async () => {
    try {
      await Promise.race([frames(), delay(10000).then(() => { throw new Error("Initial animation frames timed out"); })]);
      check(document.getElementById("desktop-shell") && document.getElementById("solid-counter"), "Complete desktop failed to mount");
      report({ stage: "ready", snapshot: snapshot(), runtime: aot ? window.__weberDom.request("desktop-status").data : null });
      if (config.mode === "input" || config.mode === "benchmark") {
        document.getElementById(config.mode === "input" ? "solid-input" : "solid-counter").focus();
        report({ stage: "focused", active: document.activeElement?.id });
      }
      if (config.mode === "binding-contracts") {
        if (aot) window.__weberDom.call("binding-prepare"); else window.weberBindingPrepare();
        document.getElementById("binding-probe").firstChild.data = "native 한글 😀\ud800";
        document.getElementById("binding-input").value = "native 입력 😀";
        document.getElementById("binding-checkbox").checked = true;
        const parse = JSON.parse, stringify = JSON.stringify; let result;
        JSON.parse = JSON.stringify = () => { throw new Error("JSON used by native adapter"); };
        try { result = aot ? window.__weberDom.request("binding-contracts").data : window.weberBindingContracts(); }
        finally { JSON.parse = parse; JSON.stringify = stringify; }
        if (aot) {
          for (const bytes of [new Uint8Array(), new Uint8Array([87, 66, 82, 2, 0]), new Uint8Array([87, 66, 82, 1, 0, 0])]) check(window.weberHostBytes(bytes, () => null) === null, "Malformed host packet accepted");
          check(window.__weberDom.request("desktop-status").data.listenerErrors.length === 0, "Host did not recover after malformed requests");
          result.malformedRejected = 3;
        }
        report({ stage: "binding-contracts", ...result }); await delay(100); location.href = "weber://close";
      } else if (config.mode === "style-contracts") {
        const result = aot ? window.__weberDom.request("style-contracts").data : window.weberStyleContracts();
        report({ stage: "style-contracts", ...result, runtime: aot ? window.__weberDom.request("desktop-status").data : null });
        await delay(100); location.href = "weber://close";
      } else if (config.mode === "smoke") {
        const before = aot ? window.__weberDom.request("collect").data : null;
        document.getElementById("desktop-about").click(); check(document.getElementById("desktop-about-panel") && !document.getElementById("solid-app"), "Shell navigation");
        document.getElementById("desktop-workspace").click(); check(document.getElementById("solid-count").textContent === "0", "Shell remount");
        document.getElementById("solid-counter").click(); check(document.getElementById("solid-count").textContent === "1", "Application counter");
        const input = document.getElementById("solid-input"); input.value = "standalone 한글"; input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "한글", inputType: "insertText" }));
        check(document.getElementById("solid-text").textContent === input.value, "Application Unicode signal");
        document.getElementById("desktop-scroll").scrollTop = 45;
        for (let attempt = 0; attempt < 20 && document.getElementById("desktop-scroll-position").textContent !== "45"; attempt++) await delay(25);
        check(document.getElementById("desktop-scroll-position").textContent === "45", "Native scroll callback");
        await frames();
        const runtime = aot ? window.__weberDom.request("collect").data : null;
        report({ stage: "smoke", passed: true, snapshot: snapshot(), runtime, before }); await delay(100); location.href = "weber://close";
      } else if (config.mode === "stress") {
        check(navigator.servo && typeof navigator.servo.garbageCollectAllContexts === "function", "Benchmark-only Servo GC capability missing");
        const invoke = (command, count) => aot ? window.__weberDom.request("desktop-command", { command, count }) : window.WeberDesktopWeb[command](count);
        const collect = async () => {
          const runtime = aot ? window.__weberDom.request("collect").data : null;
          navigator.servo.garbageCollectAllContexts(); await frames(); return runtime;
        };
        document.getElementById("solid-motion").click();
        const checkpoints = [];
        for (let index = 0; index < 35; index++) {
          invoke("mutate", 500); const runtime = await collect();
          const point = { phase: index < 5 ? "warmup" : "mutation", index, runtime, native: aot ? window.__weberDom.snapshot() : null, snapshot: snapshot() };
          checkpoints.push(point); report({ stage: "stress-checkpoint", ...point }); await delay(75);
        }
        const baseline = checkpoints[4];
        invoke("retain"); await collect(); invoke("reinsert");
        const retained = document.getElementById("desktop-retained"); check(retained?.textContent === "preserved", "Retained node reinsertion"); retained.click(); check(retained.textContent === "reused", "Retained node listener");
        invoke("releaseRetained"); await collect();
        for (let index = 0; index < 20; index++) {
          if (aot) window.__weberDom.call("dispose"); else window.WeberDesktopWeb.unmount();
          check(document.getElementById("aot-dom-root").firstChild === null, "Desktop disposal");
          await delay(50);
          check(document.getElementById("aot-dom-root").firstChild === null, "Disposed callbacks mutated the native root");
          if (aot) { const disposed = window.__weberDom.snapshot(); check(disposed.nodes === 1 && disposed.tasks === 0 && disposed.listeners.length === 0 && disposed.requests === 0 && disposed.resizeObservers === 0, "Native ownership after disposal"); window.__weberDom.call("desktop"); }
          else window.WeberDesktopWeb.mount();
          document.getElementById("solid-motion").click(); await delay(50);
          const runtime = await collect();
          const point = { phase: "remount", index, runtime, native: aot ? window.__weberDom.snapshot() : null, snapshot: snapshot() };
          checkpoints.push(point); report({ stage: "stress-checkpoint", ...point });
        }
        if (aot) for (const point of checkpoints.filter(point => point.phase !== "warmup")) {
          check(point.runtime.listenerErrors.length === 0, "Stress listener errors");
          check(point.runtime.dom.nodes <= baseline.runtime.dom.nodes + 16 && point.runtime.wrappers <= baseline.runtime.wrappers + 16, "Unbounded AOT DOM ownership growth");
          check(point.native.nodes <= baseline.native.nodes + 16, "Unbounded Servo handle growth");
        }
        report({ stage: "stress-complete", passed: true, baseline, final: checkpoints.at(-1), iterations: { mutation: 35, nodesPerIteration: 500, remount: 20 } }); await delay(100); location.href = "weber://close";
      } else if (config.timeoutMs) { await delay(config.timeoutMs); report({ stage: "final", snapshot: snapshot() }); await delay(100); location.href = "weber://close"; }
    } catch (error) { report({ stage: "failure", message: String(error), snapshot: snapshot() }); await delay(100); location.href = "weber://close"; }
  })();
})();

// App-specific code is a native SHUnit in AOT mode. This adapter owns only the
// browser/native boundary and optional test observation.
(async () => {
  const aot = !location.pathname.includes("web");
  const config = window.__weberApplication;
  const report = data => window.weberHostCall(JSON.stringify({ action: "telemetry", data: { ...data, app: config.id, engine: aot ? "hermes-aot" : "spidermonkey" } }));
  try {
    if (aot) window.__weberDom.call("application");
    else window.WeberUserApp.mount(document.getElementById("aot-dom-root"));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    report({ stage: "ready", title: document.title });
    if (config.test) {
      const result = aot ? window.__weberDom.request("application-test").data : window.WeberUserApp.test();
      if (aot) window.__weberDom.call("application-remount");
      else { window.WeberUserApp.unmount(); window.WeberUserApp.mount(document.getElementById("aot-dom-root")); }
      const remounted = aot ? window.__weberDom.request("application-test").data : window.WeberUserApp.test();
      if (JSON.stringify(result) !== JSON.stringify(remounted)) throw new Error("Application remount changed test result");
      const runtime = aot ? window.__weberDom.request("desktop-status").data : null;
      report({ stage: "application-test", ...result, remount: true, runtime });
      await new Promise(resolve => setTimeout(resolve, 100)); location.href = "weber://close";
    }
  } catch (error) {
    window.weberShowError?.(error);
    if (config.test) { report({ stage: "failure", message: String(error) }); location.href = "weber://close"; }
  }
})();

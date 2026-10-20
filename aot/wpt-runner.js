// The original testharness selects its official shell environment before this
// helper installs document. The source tests and assertions are not modified.
globalThis.self = globalThis;
globalThis.weberWptPrepare = (file, profileHash, fixture) => {
  setup({ output: false, explicit_done: true });
  const report = globalThis.weberWptReport = { file, profileHash, engine: "static-hermes-native-aot", complete: false, tests: [], harness: null };
  add_result_callback(test => report.tests.push({ name: test.name, status: test.status, message: test.message }));
  add_completion_callback((tests, status) => { report.complete = true; report.harness = { status: status.status, message: status.message }; });
  const document = globalThis.WeberBrowserDOM.installGlobals();
  if (fixture) {
    // HTML parser semantics, not source execution. Script nodes are extracted at
    // build time and initialized separately as native units in source order.
    const tree = globalThis.WeberPlatform.html.parse(fixture);
    const html = tree.childNodes.find(node => node.tagName === "html");
    for (const section of html.childNodes) if (section.tagName === "head" || section.tagName === "body") {
      document[section.tagName].innerHTML = globalThis.WeberPlatform.html.serialize(section);
    }
    for (const node of document.querySelectorAll("[id]")) {
      const id = node.id;
      if (id && !(id in globalThis)) Object.defineProperty(globalThis, id, { configurable: true, get: () => document.getElementById(id) });
    }
  }
};
globalThis.weberWptFinish = () => done();
globalThis.weberWptData = () => {
  if (globalThis.weberProfileReport) globalThis.weberProfileReport.registries = { resizeObservers: globalThis.WeberResize.activeCount, fetch: globalThis.WeberFetch.pendingCount };
  return globalThis.weberBindingReport ?? globalThis.weberApplicationReport ?? globalThis.weberStyleReport ?? globalThis.weberProfileReport ?? globalThis.weberWptReport ?? globalThis.weberDesktopReport ?? null;
};

globalThis.weberWptStatus = () => JSON.stringify(globalThis.weberWptData());

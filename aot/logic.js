// Compiled by shermes to native object code; no source evaluation at runtime.
let count = 0;
globalThis.weberIncrement = function(delta) {
  const next = count + delta;
  if (!Number.isSafeInteger(next)) throw new RangeError("counter overflow");
  count = next;
  return count;
};

globalThis.weberDomStart = function() {
  const dom = globalThis.WeberDOM;
  const root = dom.begin();
  const panel = dom.createElement("section");
  dom.setAttribute(panel, "id", "hermes-panel");
  dom.appendChild(root, panel);
  const output = dom.createElement("output");
  dom.setAttribute(output, "id", "hermes-output");
  dom.setText(output, "Created by native AOT");
  dom.appendChild(panel, output);
  const button = dom.createElement("button");
  dom.setAttribute(button, "id", "hermes-button");
  dom.setText(button, "AOT click: 0");
  dom.appendChild(panel, button);
  let clicks = 0;
  dom.on(button, "click", () => {
    clicks += 1;
    dom.setText(button, "AOT click: " + clicks);
    dom.setText(output, "Hermes callback: " + clicks);
  });
  const input = dom.createElement("input");
  dom.setAttribute(input, "id", "hermes-input");
  dom.setAttribute(input, "placeholder", "Input delivered to Hermes");
  dom.appendChild(panel, input);
  dom.on(input, "input", value => dom.setText(output, value));
  const remove = dom.createElement("button");
  dom.setAttribute(remove, "id", "hermes-remove");
  dom.setText(remove, "Remove AOT subtree");
  dom.appendChild(root, remove);
  dom.on(remove, "click", () => { dom.remove(panel); dom.setText(remove, "Subtree removed"); });
  return;
};
globalThis.weberDomEvent = function(raw) {
  globalThis.WeberDOM.dispatch(raw);
  return;
};
globalThis.weberDomDispose = function() {
  globalThis.WeberUserApp?.unmount();
  globalThis.WeberDesktop?.unmount();
  globalThis.WeberSolid?.unmount();
  globalThis.WeberDOM.dispose();
  return;
};
globalThis.weberBrowserStart = function() {
  globalThis.WeberSolid?.unmount();
  const { Event } = globalThis.WeberBrowserDOM;
  const document = globalThis.WeberBrowserDOM.installGlobals();
  const panel = document.createElement("section"); panel.id = "browser-panel";
  const button = document.createElement("button"); button.id = "browser-button";
  button.textContent = "Browser API: 0";
  const output = document.createElement("output"); output.id = "browser-output";
  output.textContent = "AOT browser DOM ready";
  const input = document.createElement("input"); input.id = "browser-input";
  panel.style.marginLeft = "8px";
  const observer = new MutationObserver(() => output.setAttribute("title", "observed"));
  observer.observe(panel, { attributes: true, attributeFilter: ["class"] });
  panel.classList.add("browser-ready");
  input.value = "AOT initial value";
  let count = 0;
  button.addEventListener("click", function(event) {
    if (event.target !== button || event.currentTarget !== button || this !== button) throw new Error("Event identity mismatch");
    count += 1; button.textContent = "Browser API: " + count;
    if (document.querySelector("#browser-button") !== button) throw new Error("Selector identity mismatch");
    output.textContent = "Callback " + count;
    if (document.listenerErrors.length) throw new Error("Listener error");
  });
  input.addEventListener("input", event => { output.textContent = event.target.value; });
  panel.appendChild(button); panel.appendChild(input); panel.appendChild(output);
  document.body.appendChild(panel);
  const parsed = document.createElement("div"); parsed.id = "browser-parsed"; parsed.setAttribute("hidden", "");
  parsed.innerHTML = '<table><tr><td data-value="parsed">&lt;literal&gt;</td></tr></table><svg viewBox="0 0 10 10"><circle r="2"></circle></svg><script>globalThis.__weberParsedScriptRan = true;</script>';
  document.body.appendChild(parsed);
  // AOT dispatch is synchronous and follows the same path as the native event bridge.
  button.dispatchEvent(new Event("mounted"));
  return;
};
globalThis.weberDomFlush = () => globalThis.WeberDOM.flush();
globalThis.weberPrepareApplication = clock => {
  globalThis.WeberScheduler.bindClock(clock);
  globalThis.WeberDesktop.unmount(); globalThis.WeberSolid.unmount();
  globalThis.WeberBrowserDOM.installGlobals();
};
globalThis.weberHostCall = raw => {
  const request = typeof raw === "string" ? JSON.parse(raw) : raw; let decision;
  // Application preparation already anchored this request's clock before
  // module evaluation. Rebinding its old timestamp would rewind that interval.
  if (request.action !== "application") globalThis.WeberScheduler.bindClock(request.clock);
  switch (request.action) {
    case "backend-events": globalThis.weberBackendDeliver?.(request.event); break;
    case "window-state": globalThis.weberWindowDeliver?.(request.event); break;
    case "event": decision = globalThis.WeberDOM.dispatch(request.event); break;
    case "task": globalThis.WeberScheduler.run(request.event); break;
    case "resize": globalThis.WeberResize.run(request.event); break;
    case "fetch": globalThis.WeberFetch.run(request.event); break;
    case "profile-start": globalThis.weberProfileStart(); break;
    case "profile-arm-disposal": globalThis.weberProfileArmDisposal(); break;
    case "profile-status": break;
    case "binding-prepare": globalThis.weberBindingPrepare(); break;
    case "binding-contracts": globalThis.weberBindingReport = globalThis.weberBindingContracts(); break;
    case "style-contracts": globalThis.weberStyleReport = globalThis.weberStyleContracts(); break;
    case "application":
      globalThis.WeberUserApp.mount(document.body); break;
    case "application-test": globalThis.weberApplicationReport = globalThis.WeberUserApp.test(); break;
    case "application-remount": globalThis.WeberUserApp.unmount(); globalThis.WeberUserApp.mount(document.body); break;
    case "desktop":
      globalThis.WeberDesktop.unmount(); globalThis.WeberSolid.unmount();
      globalThis.WeberBrowserDOM.installGlobals(); globalThis.WeberDesktop.mount(); break;
    case "collect": globalThis.document?._nodes.sweep();
    // Collection and inspection return actual native ownership/heap counters.
    case "desktop-status":
      globalThis.weberBindingReport = null;
      globalThis.weberStyleReport = null;
      globalThis.weberApplicationReport = null;
      globalThis.weberDesktopReport = { dom: globalThis.WeberDOM.stats(), wrappers: globalThis.document?._nodes.size ?? 0,
        heap: globalThis.weberHeapInfo(), platform: globalThis.WeberPlatform.loaded, listenerErrors: globalThis.document?.listenerErrors ?? [] }; break;
    case "desktop-command": {
      const { command, count } = request.event;
      if (!["mutate", "retain", "reinsert", "releaseRetained"].includes(command)) throw new Error("Unknown desktop workload");
      globalThis.WeberDesktop[command](count); break;
    }
    case "checkpoint": case "wpt-start": case "wpt-status": break;
    case "browser": globalThis.weberBrowserStart(); break;
    case "solid":
      globalThis.WeberSolid.unmount();
      globalThis.WeberBrowserDOM.installGlobals();
      globalThis.WeberSolid.mount(); break;
    case "dispose": globalThis.WeberSolid.unmount(); globalThis.weberDomDispose(); break;
    default: throw new Error("Unsupported synchronous action");
  }
  const result = decision ?? { defaultPrevented: false, stopPropagation: false, stopImmediatePropagation: false };
  return typeof raw === "string" ? JSON.stringify(result) : result;
};
globalThis.weberBrowserContracts = () => {
  const document = globalThis.WeberBrowserDOM.installGlobals();
  const cases = globalThis.runBrowserContracts(document, globalThis.Event, globalThis.MutationObserver);
  globalThis.weberObserverCheckpointPassed = false;
  globalThis.runObserverCheckpoint(document, MutationObserver, passed => { globalThis.weberObserverCheckpointPassed = passed; });
  if (globalThis.weberObserverCheckpointPassed) throw new Error("Observer delivered synchronously");
  return JSON.stringify({ passed: true, cases, listenerErrors: document.listenerErrors });
};

globalThis.weberHostReplyBytes = (decision, data) => globalThis.WeberWire.encode({ decision, commands: globalThis.WeberDOM.takeCommands(), data }).buffer;

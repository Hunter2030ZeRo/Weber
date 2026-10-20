globalThis.weberProfileStart = () => {
  const document = globalThis.WeberBrowserDOM.installGlobals();
  const report = globalThis.weberProfileReport = { scenarios: {}, listenerErrors: document.listenerErrors };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const run = (name, callback) => {
    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        report.scenarios[name] = { status: "PENDING" };
        result.then(() => { report.scenarios[name] = { status: "PASS" }; }, error => { report.scenarios[name] = { status: "FAIL", error: String(error) }; });
      } else report.scenarios[name] = { status: "PASS" };
    }
    catch (error) { report.scenarios[name] = { status: "FAIL", error: String(error) }; }
  };
  run("namespaces-and-dataset", () => {
    const node = document.createElement("div"); node.id = "weber-profile-attributes"; document.body.append(node);
    node.setAttributeNS("urn:weber:first", "x", "first"); node.setAttributeNS("urn:weber:second", "x", "second");
    node.setAttribute("x", "changed"); check(node.attributes.length === 3 && node.getAttributeNS("urn:weber:first", "x") === "changed", "Qualified-name update preserves namespace");
    const attr = node.getAttributeNodeNS("urn:weber:second", "x"); attr.value = "attribute-object";
    node.removeAttributeNS("urn:weber:first", "x"); check(attr.ownerElement === node && node.getAttribute("x") === "attribute-object", "Namespaced removal and identity");
    node.dataset.userName = "Ada"; node.setAttribute("data-number", "12");
    check(node.dataset.number === "12" && Object.keys(node.dataset).includes("userName"), "Live dataset");
    delete node.dataset.number; check(!node.hasAttribute("data-number"), "Dataset deletion");
    const observer = new MutationObserver(() => {}); observer.observe(node, { attributes: true, attributeOldValue: true });
    attr.value = "final"; const records = observer.takeRecords(); observer.disconnect();
    check(records.length === 1 && records[0].attributeNamespace === "urn:weber:second" && records[0].oldValue === "attribute-object", "Namespaced mutation record");
  });
  run("abort-listener-lifecycle", () => {
    const target = new EventTarget(), controller = new AbortController(); let calls = 0;
    target.addEventListener("x", () => controller.abort("reason"), { signal: controller.signal });
    target.addEventListener("x", () => calls++, { signal: controller.signal }); target.dispatchEvent(new Event("x"));
    check(calls === 0 && controller.signal.reason === "reason", "Abort while dispatching");
    let reason; try { controller.signal.throwIfAborted(); } catch (error) { reason = error; }
    check(reason === "reason" && controller.signal._algorithms.size === 0, "Abort reason and cleanup");
    const other = new AbortController(), callback = () => calls++;
    target.addEventListener("x", callback, { signal: other.signal }); target.removeEventListener("x", callback);
    check(other.signal._algorithms.size === 0, "Manual listener removal releases abort hook");
  });
  run("computed-style-and-client-rects", () => {
    const box = document.createElement("div"); box.id = "weber-profile-rect";
    box.style.cssText = "position:fixed;left:10px;top:20px;width:120px;height:30px;padding:5px;border:2px solid black;transform:translateX(7px);color:rgb(17,34,51)"; document.body.append(box);
    const rect = box.getBoundingClientRect(), style = getComputedStyle(box);
    check(rect.left === 17 && rect.top === 20 && rect.width === 134 && rect.height === 44, "Actual rendered rectangle including transform and border");
    check(style.color === "rgb(17, 34, 51)" && box.getClientRects().length === 1, "Computed color and fragment rectangle");
    box.style.width = "130px";
    check(style.width === "130px" && box.getBoundingClientRect().width === 144, "Live style read flushes pending writes");
  });
  run("scroll-and-viewport", () => {
    const box = document.createElement("div"), child = document.createElement("div"); box.id = "weber-profile-scroll";
    box.style.cssText = "width:80px;height:40px;overflow:auto"; child.style.cssText = "width:200px;height:200px"; box.append(child); document.body.append(box);
    box.scrollTop = 30; box.scrollLeft = 20; box.scrollBy(3, 5);
    check(box.scrollTop === 35 && box.scrollLeft === 23 && box.scrollWidth >= 200 && box.clientHeight > 0, "Actual element scrolling");
    check(innerWidth > 0 && innerHeight > 0 && devicePixelRatio > 0 && scrollX === pageXOffset && scrollY === pageYOffset, "Actual viewport aliases");
  });
  run("focus-and-active-element", () => {
    const input = document.createElement("input"); input.id = "weber-profile-input"; document.body.append(input);
    input.focus({ preventScroll: true }); check(document.activeElement === input, "Native focus identity");
    input.blur(); check(document.activeElement === document.body, "Blur restores body");
  });
  run("typed-ui-events", () => {
    const mouse = new MouseEvent("click", { clientX: 23, ctrlKey: true });
    check(mouse instanceof UIEvent && mouse instanceof Event && mouse.x === 23 && mouse.getModifierState("Control"), "Typed constructor and modifiers");
    const button = document.createElement("button"); button.id = "weber-profile-button"; button.textContent = "typed events"; document.body.append(button);
    const input = document.getElementById("weber-profile-input") ?? document.createElement("input"); input.id = "weber-profile-input"; if (!input.parentNode) document.body.append(input);
    let seen = 0;
    const handle = (type, validate) => event => {
      if (report.scenarios["typed-ui-events"].status === "FAIL") return;
      try { validate(event); seen |= type; event.preventDefault(); report.scenarios["typed-ui-events"] = { status: seen === 7 ? "PASS" : "PENDING", seen }; }
      catch (error) { report.scenarios["typed-ui-events"] = { status: "FAIL", error: String(error) }; }
    };
    button.addEventListener("click", handle(1, event => check(event instanceof MouseEvent && event.clientX === 23 && event.button === 1 && event.buttons === 4 && event.ctrlKey, "Native mouse fields")));
    input.addEventListener("keydown", handle(2, event => check(event instanceof KeyboardEvent && event.key === "한" && event.code === "KeyG" && event.repeat && event.shiftKey, "Native keyboard fields")));
    input.addEventListener("input", handle(4, event => check(event instanceof InputEvent && event.data === "한" && event.inputType === "insertText" && event.isComposing && input.value === "입력", "Native input fields and value")));
  });
  if (report.scenarios["typed-ui-events"].status === "PASS") report.scenarios["typed-ui-events"] = { status: "PENDING", seen: 0 };
  run("fetch-json-get", async () => {
    const response = await fetch("/__api/json");
    check(response instanceof Response && response.ok && response.status === 200 && response.headers.get("x-weber") === "native-servo", "HTTP response and headers");
    const clone = response.clone(), data = await response.json();
    check(data.value === "한글" && response.bodyUsed && (await clone.json()).value === data.value, "JSON Unicode, clone and body consumption");
    let rejected = false; try { await response.text(); } catch (error) { rejected = error instanceof TypeError; }
    check(rejected, "A body can be consumed only once");
  });
  run("fetch-text-post", async () => {
    const headers = new Headers([["X-Test", " one "]]); headers.append("x-test", "two");
    check(headers.get("X-TEST") === "one, two", "Headers normalization");
    const response = await fetch("/__api/echo", { method: "POST", headers, body: "native AOT 한글" });
    check(response.status === 201 && response.headers.get("x-request-test") === "one, two" && await response.text() === "native AOT 한글", "POST body and status");
  });
  run("fetch-abort-and-failure", async () => {
    const controller = new AbortController(), promise = fetch("/__api/delay", { signal: controller.signal });
    controller.abort("cancelled"); let reason;
    try { await promise; } catch (error) { reason = error; }
    check(reason === "cancelled", "Abort rejection reason");
    let failure = false; try { await fetch("/__api/disconnect"); } catch (error) { failure = error instanceof TypeError; }
    check(failure, "Network failure rejects");
    const missing = await fetch("/__api/missing"); check(missing.status === 404 && !missing.ok, "HTTP failure resolves with status");
    let parseFailure = false; try { await (await fetch("/__api/invalid-json")).json(); } catch (error) { parseFailure = error instanceof SyntaxError; }
    check(parseFailure, "Invalid JSON rejects");
  });
  report.scenarios["resize-observer-lifecycle"] = { status: "PENDING" };
  try {
    const box = document.createElement("div"); box.id = "weber-profile-resize"; box.style.cssText = "width:70px;height:20px"; document.body.append(box);
    let calls = 0;
    const observer = new ResizeObserver((entries, received) => {
      try {
        calls++; check(received === observer && entries.length === 1 && entries[0].target === box, "Resize callback identity");
        if (calls === 1) { check(entries[0].contentRect.width === 70, "Initial resize delivery"); box.style.width = "90px"; }
        else if (calls === 2) {
          check(entries[0].contentRect.width === 90, "Resize after mutation"); observer.unobserve(box); box.style.width = "110px";
          setTimeout(() => {
            try { check(calls === 2, "Unobserve suppresses delivery"); observer.observe(box); }
            catch (error) { report.scenarios["resize-observer-lifecycle"] = { status: "FAIL", error: String(error) }; }
          }, 100);
        } else if (calls === 3) { check(entries[0].contentRect.width === 110, "Re-observation"); observer.disconnect(); box.style.width = "130px";
          setTimeout(() => { report.scenarios["resize-observer-lifecycle"] = calls === 3 ? { status: "PASS", calls } : { status: "FAIL", error: "Delivery after disconnect" }; }, 100);
        } else throw new Error("Unexpected resize delivery");
      } catch (error) { observer.disconnect(); report.scenarios["resize-observer-lifecycle"] = { status: "FAIL", error: String(error) }; }
    });
    observer.observe(box);
  } catch (error) { report.scenarios["resize-observer-lifecycle"] = { status: "FAIL", error: String(error) }; }
};
globalThis.weberProfileArmDisposal = () => {
  const report = globalThis.weberProfileReport;
  report.disposalCallbacks = 0; report.disposalFetchRejected = false;
  const box = document.createElement("div"); box.style.cssText = "width:190px;height:20px"; document.body.append(box);
  const observer = new ResizeObserver(() => report.disposalCallbacks++); observer.observe(box);
  setTimeout(() => report.disposalCallbacks++, 100);
  fetch("/__api/delay").then(() => report.disposalCallbacks++, error => { report.disposalFetchRejected = error.name === "AbortError"; });
};

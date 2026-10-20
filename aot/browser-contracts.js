// The same contract cases execute in native AOT and against the real Servo DOM.
globalThis.runBrowserContracts = function(document, Event, MutationObserver) {
  const passed = [];
  function check(value, message) { if (!value) throw new Error(message); }
  function test(name, action) { document.body.replaceChildren(); action(); passed.push(name); }
  function throwsName(name, action) {
    let actual = ""; try { action(); } catch (error) { actual = error.name; }
    check(actual === name, "Expected " + name + ", received " + actual);
  }
  test("node identity and relationships", () => {
    const a = document.createElement("DIV"); const b = document.createElement("span");
    check(a.tagName === "DIV" && a.localName === "div", "HTML name casing");
    check(document.body.appendChild(a) === a && a.appendChild(b) === b, "append return identity");
    check(a.firstChild === b && a.lastChild === b && b.parentNode === a && b.ownerDocument === document, "relations");
    check(b.nodeType === 1 && b.nodeValue === null && b.isConnected, "node properties");
  });
  test("insert move and replace", () => {
    const a = document.createElement("div"); const b = document.createElement("span"); const c = document.createElement("p");
    document.body.appendChild(a); document.body.appendChild(b); document.body.insertBefore(c, b);
    document.body.insertBefore(b, a); document.body.insertBefore(b, b);
    check(b.nextSibling === a && a.previousSibling === b, "move siblings");
    check(document.body.replaceChild(b, c) === c && c.parentNode === null, "replace existing sibling");
    check(document.body.lastChild === b && document.body.childNodes.length === 2, "replacement ordering");
  });
  test("detached node remains reusable", () => {
    const node = document.createElement("button"); node.id = "detached"; document.body.appendChild(node);
    let calls = 0; node.addEventListener("click", () => calls++);
    check(document.body.removeChild(node) === node, "removeChild return");
    node.dispatchEvent(new Event("click")); node.textContent = "detached text";
    check(!node.isConnected && document.getElementById("detached") === null, "detached query exclusion");
    document.body.appendChild(node); node.dispatchEvent(new Event("click"));
    check(calls === 2 && document.getElementById("detached") === node && node.textContent === "detached text", "retained identity and listeners");
  });
  test("text replacement detaches children", () => {
    const parent = document.createElement("div"); const child = document.createElement("span");
    const text = document.createTextNode("한글😀"); child.appendChild(text); parent.appendChild(child); document.body.appendChild(parent);
    check(parent.textContent === "한글😀" && text.length === 4, "UTF16 text");
    parent.textContent = "<b>literal</b>";
    check(child.parentNode === null && parent.children.length === 0 && parent.firstChild.nodeType === 3, "replacement text node");
    text.data = "retained"; parent.appendChild(child);
    check(parent.textContent === "<b>literal</b>retained", "detached subtree retained");
    parent.textContent = null; check(parent.firstChild === null, "null clears text");
  });
  test("fragment insertion empties fragment", () => {
    const fragment = document.createDocumentFragment(); const a = document.createElement("p"); const b = document.createTextNode("tail");
    fragment.appendChild(a); fragment.appendChild(b);
    check(document.body.appendChild(fragment) === fragment, "fragment return");
    check(fragment.firstChild === null && document.body.firstChild === a && a.nextSibling === b, "fragment transfer");
  });
  test("attributes and input value", () => {
    const input = document.createElement("input"); input.setAttribute("ID", "field"); input.className = "example";
    document.body.appendChild(input); input.value = "value";
    check(document.getElementById("field") === input && input.getAttribute("class") === "example" && input.value === "value", "reflection");
    input.removeAttribute("id"); check(!input.hasAttribute("id") && input.id === "" && input.getAttribute("missing") === null, "attribute removal");
  });
  test("tree exception names", () => {
    const a = document.createElement("div"); const b = document.createElement("span"); a.appendChild(b);
    throwsName("HierarchyRequestError", () => b.appendChild(a));
    throwsName("NotFoundError", () => a.removeChild(document.createElement("p")));
    throwsName("NotFoundError", () => a.insertBefore(document.createElement("p"), document.createElement("p")));
    throwsName("InvalidCharacterError", () => document.createElement("bad tag"));
  });
  test("capture target bubble and identity", () => {
    const parent = document.createElement("div"); const child = document.createElement("button"); parent.appendChild(child); document.body.appendChild(parent);
    const order = [];
    parent.addEventListener("test", function(event) { check(this === parent && event.target === child && event.currentTarget === parent && event.eventPhase === 1, "capture identity"); order.push("capture"); }, true);
    child.addEventListener("test", () => order.push("target")); parent.addEventListener("test", () => order.push("bubble"));
    const event = new Event("test", { bubbles: true }); child.dispatchEvent(event);
    check(order.join() === "capture,target,bubble" && event.currentTarget === null && event.eventPhase === 0, "propagation ordering");
  });
  test("duplicate once removal and listener mutation", () => {
    const node = document.createElement("button"); let count = 0;
    const callback = () => count++; node.addEventListener("x", callback); node.addEventListener("x", callback);
    node.dispatchEvent(new Event("x")); node.removeEventListener("x", callback); node.dispatchEvent(new Event("x"));
    node.addEventListener("x", callback, { once: true }); node.dispatchEvent(new Event("x")); node.dispatchEvent(new Event("x"));
    check(count === 2, "dedupe removal once");
    node.addEventListener("y", () => node.removeEventListener("y", callback)); node.addEventListener("y", callback); node.dispatchEvent(new Event("y"));
    check(count === 2, "removed pending listener skipped");
    let nullable = 0; const nullListener = () => nullable++;
    node.addEventListener("nullable", nullListener, null);
    node.dispatchEvent(new Event("nullable", null));
    node.removeEventListener("nullable", nullListener, null);
    node.dispatchEvent(new Event("nullable"));
    check(nullable === 1, "nullable event options");
  });
  test("cancellation passive and propagation stop", () => {
    const parent = document.createElement("div"); const child = document.createElement("button"); parent.appendChild(child);
    child.addEventListener("x", event => event.preventDefault()); check(!child.dispatchEvent(new Event("x", { cancelable: true })), "cancelable dispatch return");
    child.addEventListener("p", event => event.preventDefault(), { passive: true }); check(child.dispatchEvent(new Event("p", { cancelable: true })), "passive ignores cancellation");
    let calls = 0; parent.addEventListener("s", () => calls++); child.addEventListener("s", event => event.stopImmediatePropagation()); child.addEventListener("s", () => calls++);
    child.dispatchEvent(new Event("s", { bubbles: true })); check(calls === 0, "stop immediate");
  });
  test("selectors groups combinators and scope", () => {
    const panel = document.createElement("section"); panel.id = "selection"; document.body.appendChild(panel);
    for (let index = 0; index < 3; index++) { const child = document.createElement("span"); child.className = "item"; child.setAttribute("title", String(index)); panel.appendChild(child); }
    check(panel.querySelectorAll(":scope > .item").length === 3, "scope child selector");
    check(panel.querySelector(".item + span:nth-child(2)") === panel.children[1], "adjacent and nth child");
    check(panel.querySelectorAll('span:not([title="0"]), span[title="1"]').length === 2, "groups dedupe in tree order");
    check(panel.children[0].matches("#selection > span.item") && panel.children[0].closest("section") === panel, "matches and closest");
    const snapshot = panel.querySelectorAll("span"); panel.appendChild(document.createElement("span"));
    check(snapshot.length === 3, "static querySelectorAll");
    throwsName("SyntaxError", () => panel.querySelector("["));
  });
  test("classList token behavior and reflection", () => {
    const node = document.createElement("div"); node.className = "one one two"; const list = node.classList;
    check(list.length === 2 && list.contains("one") && list.item(2) === null, "token normalization");
    list.add("three", "two"); list.remove("one"); check(node.className === "two three", "token edits");
    check(list.toggle("four", true) && !list.toggle("two", false), "forced toggle");
    check(list.replace("three", "four") && node.className === "four", "replacement dedupe");
    throwsName("SyntaxError", () => list.add("")); throwsName("InvalidCharacterError", () => list.add("bad token"));
  });
  test("inline CSS parsing and attribute synchronization", () => {
    const node = document.createElement("div"); const style = node.style;
    style.setProperty("width", "12px", "important"); style.color = "red";
    check(style.width === "12px" && style.getPropertyPriority("width") === "important", "CSS values and priority");
    check(node.getAttribute("style").includes("width: 12px"), "style attribute reflected");
    style.width = "not-a-length"; check(style.width === "12px", "invalid value ignored");
    node.setAttribute("style", "height: 7px;"); check(style.height === "7px" && style.width === "", "same style object synchronized");
    node.removeAttribute("style"); check(style.cssText === "", "removed style clears declaration");
  });
  test("mutation attribute filter old value and disconnect", () => {
    const node = document.createElement("div"); document.body.appendChild(node);
    const observer = new MutationObserver(() => {});
    observer.observe(node, { attributes: true, attributeOldValue: true, attributeFilter: ["class"] });
    node.className = "one"; node.className = "two"; node.id = "ignored";
    const records = observer.takeRecords();
    check(records.length === 2 && records[0].oldValue === null && records[1].oldValue === "one" && records[0].target === node && records[0].attributeName === "class", "filtered attribute records");
    observer.disconnect(); node.className = "three"; check(observer.takeRecords().length === 0, "disconnect clears registration");
  });
  test("mutation childList characterData and replaceAll", () => {
    const parent = document.createElement("div"); const text = document.createTextNode("old"); parent.appendChild(text); document.body.appendChild(parent);
    const observer = new MutationObserver(() => {}); observer.observe(parent, { childList: true, subtree: true, characterDataOldValue: true });
    text.data = "new"; parent.textContent = "replacement";
    const records = observer.takeRecords(); observer.disconnect();
    check(records.length === 2 && records[0].type === "characterData" && records[0].oldValue === "old", "characterData record");
    check(records[1].removedNodes[0] === text && records[1].addedNodes[0] === parent.firstChild && records[1].previousSibling === null, "coalesced replacement record");
  });
  test("mutation transient subtree observation", () => {
    const parent = document.createElement("div"); const child = document.createElement("span"); parent.appendChild(child); document.body.appendChild(parent);
    const observer = new MutationObserver(() => {}); observer.observe(parent, { attributes: true, subtree: true });
    parent.removeChild(child); child.className = "detached";
    const records = observer.takeRecords(); observer.disconnect();
    check(records.length === 1 && records[0].target === child, "detached subtree observed until checkpoint");
  });
  test("mutation invalid options rejected", () => {
    const observer = new MutationObserver(() => {}); let rejected = 0;
    for (const options of [{}, { attributes: false, attributeOldValue: true }, { characterData: false, characterDataOldValue: true }]) {
      try { observer.observe(document.body, options); } catch (error) { if (error instanceof TypeError) rejected++; }
    }
    observer.disconnect(); check(rejected === 3, "invalid observer options");
  });
  test("observation update clears transient descendants", () => {
    const parent = document.createElement("div"); const child = document.createElement("span"); parent.appendChild(child);
    const observer = new MutationObserver(() => {}); observer.observe(parent, { attributes: true, subtree: true });
    parent.removeChild(child);
    observer.observe(parent, { attributes: true, subtree: true, attributeOldValue: true });
    child.id = "unobserved"; parent.id = "observed";
    const records = observer.takeRecords(); observer.disconnect();
    check(records.length === 1 && records[0].target === parent && records[0].oldValue === null, "reobserve clears previous transient source");
  });
  test("classList contains accepts non tokens", () => {
    const list = document.createElement("div").classList;
    check(!list.contains("") && !list.contains("two words"), "contains returns false without validating token");
    throwsName("SyntaxError", () => list.toggle(""));
    throwsName("InvalidCharacterError", () => list.toggle("two words"));
  });
  test("per iteration lexical closures", () => {
    const callbacks = [];
    for (let index = 0; index < 3; index++) callbacks.push(() => index);
    check(callbacks.map(callback => callback()).join() === "0,1,2", "per-iteration let binding");
    const source = { first: function First() {}, last: {} }; const target = {};
    for (let key of Object.keys(source)) Object.defineProperty(target, key, { get: () => source[key] });
    check(typeof target.first === "function", "CommonJS export getter closure");
  });
  test("document shape and root relations", () => {
    check(document.nodeType === 9 && document.ownerDocument === null && document.textContent === null, "document node");
    check(document.documentElement.localName === "html" && document.body.localName === "body" && document.head.localName === "head", "HTML document structure");
    check(document.body.parentNode === document.documentElement && document.documentElement.parentNode === document, "document ancestry");
    check(document.body.getRootNode() === document && document.body.isConnected, "connected document root");
  });
  test("live collections and static selector NodeList", () => {
    const parent = document.createElement("div"); const children = parent.children; const nodes = parent.childNodes;
    const child = document.createElement("span"); child.id = "named"; parent.appendChild(child); parent.appendChild(document.createTextNode("text"));
    check(children.length === 1 && nodes.length === 2 && children.namedItem("named") === child && children[0] === child, "live collections");
    const selected = parent.querySelectorAll("span"); parent.appendChild(document.createElement("span"));
    check(selected.length === 1 && selected.item(0) === child && children.length === 2, "static selector result");
    check(Object.prototype.toString.call(nodes) === "[object NodeList]" && Object.prototype.toString.call(children) === "[object HTMLCollection]", "collection brands");
  });
  test("template content and deep cloning", () => {
    const template = document.createElement("template"); template.innerHTML = '<button data-kind="test">Hello &amp; goodbye<!--tail--></button>';
    check(template.childNodes.length === 0 && template.content.firstChild.textContent === "Hello & goodbye", "inert template content");
    const clone = template.cloneNode(true); const button = clone.content.firstChild;
    check(button !== template.content.firstChild && button.getAttribute("data-kind") === "test" && button.lastChild.nodeType === 8, "deep template clone");
    document.body.appendChild(clone.content); check(button.isConnected && !template.content.firstChild.isConnected, "fragment transfer");
  });
  test("contextual HTML parsing serialization and comments", () => {
    const table = document.createElement("table"); table.innerHTML = "<tr><td>&lt;literal&gt;</td></tr>";
    check(table.firstChild.localName === "tbody" && table.querySelector("td").textContent === "<literal>", "table insertion mode");
    check(table.innerHTML === "<tbody><tr><td>&lt;literal&gt;</td></tr></tbody>", "HTML serialization");
    const node = document.createElement("div"); node.innerHTML = "A<!--ignored-->B";
    check(node.textContent === "AB" && node.childNodes[1].data === "ignored", "comment text excluded");
  });
  test("arbitrary HTML tags and attributes", () => {
    const node = document.createElement("aside"); node.setAttribute("data-value", "한글 & value"); node.setAttribute("aria-label", "label");
    const clone = node.cloneNode(); check(clone.localName === "aside" && clone.getAttribute("data-value") === "한글 & value" && clone.getAttribute("aria-label") === "label", "tag attribute clone");
  });
  test("SVG namespace and element case", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const gradient = document.createElementNS(svg.namespaceURI, "linearGradient"); svg.appendChild(gradient);
    check(gradient.localName === "linearGradient" && gradient.tagName === "linearGradient" && gradient.namespaceURI === svg.namespaceURI, "SVG identity");
    gradient.setAttribute("viewBox", "0 0 10 10"); check(gradient.getAttribute("viewBox") === "0 0 10 10" && gradient.getAttribute("viewbox") === null, "SVG attribute casing");
  });
  test("fragment mutation records are coalesced", () => {
    const parent = document.createElement("div"); const fragment = document.createDocumentFragment(); const a = document.createElement("span"); const b = document.createElement("p"); fragment.append(a, b);
    const observer = new MutationObserver(() => {}); observer.observe(parent, { childList: true }); observer.observe(fragment, { childList: true });
    parent.appendChild(fragment); const records = observer.takeRecords(); observer.disconnect();
    check(records.length === 2 && records[0].target === fragment && records[0].removedNodes.length === 2 && records[1].target === parent && records[1].addedNodes.length === 2, "one record per fragment and destination");
  });
  test("replaceChild combines removal and insertion", () => {
    const parent = document.createElement("div"); const old = document.createElement("span"); const next = document.createElement("p"); parent.appendChild(old);
    const observer = new MutationObserver(() => {}); observer.observe(parent, { childList: true }); parent.replaceChild(next, old);
    const records = observer.takeRecords(); observer.disconnect();
    check(records.length === 1 && records[0].addedNodes[0] === next && records[0].removedNodes[0] === old, "single replacement record");
  });
  test("replaceChildren preserves source parent records", () => {
    const source = document.createElement("div"); const target = document.createElement("div"); const a = document.createElement("span"); const b = document.createElement("p"); source.append(a, b);
    const observer = new MutationObserver(() => {}); observer.observe(source, { childList: true }); observer.observe(target, { childList: true }); target.replaceChildren(a, b);
    const records = observer.takeRecords(); observer.disconnect();
    check(records.length === 3 && records[0].target === source && records[1].target === source && records[2].target === target && records[2].addedNodes.length === 2, "source removals and coalesced destination insertion");
  });
  test("cloning excludes registered event listeners", () => {
    const button = document.createElement("button"); let calls = 0; button.addEventListener("click", () => calls++);
    const clone = button.cloneNode(true); clone.dispatchEvent(new Event("click")); button.dispatchEvent(new Event("click")); check(calls === 1, "listeners not copied");
  });
  document.body.replaceChildren(); return passed;
};
globalThis.runObserverCheckpoint = function(document, MutationObserver, done) {
  const parent = document.createElement("div"); const child = document.createElement("span");
  parent.appendChild(child); document.body.appendChild(parent);
  let deliveries = 0; let valid = false;
  const order = [];
  const other = document.createElement("div");
  const second = new MutationObserver(() => order.push("second")); second.observe(other, { attributes: true });
  const observer = new MutationObserver(records => { order.push("first"); deliveries++; valid = records.length === 1 && records[0].target === child; });
  observer.observe(parent, { attributes: true, subtree: true });
  parent.removeChild(child); child.id = "during";
  const synchronous = deliveries;
  queueMicrotask(() => {
    order.push("checkpoint");
    child.id = "after";
    const leaked = observer.takeRecords().length;
    observer.disconnect(); second.disconnect(); parent.remove();
    done(synchronous === 0 && deliveries === 1 && valid && leaked === 0 && order.join() === "first,second,checkpoint");
  });
  other.id = "same-notify-microtask";
};

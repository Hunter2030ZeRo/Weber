import "../../aot/browser-contracts.js";

declare global {
  interface Window { runBrowserContracts(document: Document, event: typeof Event, observer: typeof MutationObserver): readonly string[] }
  interface Window { runObserverCheckpoint(document: Document, observer: typeof MutationObserver, done: (passed: boolean) => void): void }
}
function check(value: boolean, message: string): asserts value { if (!value) throw new Error(message); }
function element(id: string): HTMLElement {
  const node = document.getElementById(id); check(node !== null, `Missing ${id}`); return node;
}
function nextBatch(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener("weber:dom-applied", done); reject(new Error("Browser binding timeout")); }, 5000);
    function done() { clearTimeout(timer); resolve(); }
    window.addEventListener("weber:dom-applied", done, { once: true });
  });
}
export async function runBrowserTest(): Promise<void> {
  const contracts = window.runBrowserContracts(document.implementation.createHTMLDocument(""), Event, MutationObserver);
  check(contracts.length === 30, "Shared Servo contracts passed");
  check(await new Promise<boolean>(resolve => window.runObserverCheckpoint(document.implementation.createHTMLDocument(""), MutationObserver, resolve)), "Servo observer checkpoint and transient cleanup");
  let applied = nextBatch(); location.href = "weber://dom-browser"; await applied;
  const button = element("browser-button"); const input = element("browser-input");
  check(input instanceof HTMLInputElement && input.value === "AOT initial value", "value property applied to native input");
  check(button.firstChild?.nodeType === Node.TEXT_NODE, "real text node created by AOT");
  check(element("browser-panel").style.marginLeft === "8px", "AOT inline style reaches Servo");
  check(element("browser-output").getAttribute("title") === "observed", "observer callback delivered at native microtask checkpoint");
  check(element("browser-parsed").querySelector("tbody td")?.textContent === "<literal>", "parsed HTML structure reaches Servo");
  check(element("browser-parsed").querySelector("svg circle")?.namespaceURI === "http://www.w3.org/2000/svg", "SVG namespace reaches Servo");
  check(!("__weberParsedScriptRan" in globalThis), "innerHTML script remains inert in Servo");
  applied = nextBatch(); button.click(); await applied;
  check(button.textContent === "Browser API: 1" && element("browser-output").textContent === "Callback 1", "native event object and AOT callback");
  input.value = "브라우저 DOM 😀";
  applied = nextBatch(); input.dispatchEvent(new Event("input", { bubbles: true })); await applied;
  check(element("browser-output").textContent === input.value, "input target.value synchronized");
  applied = nextBatch(); location.href = "weber://dom-dispose"; await applied;
  check(element("aot-dom-root").firstChild === null, "browser document disposal");
  applied = nextBatch(); location.href = "weber://dom-browser"; await applied;
  check(element("browser-button").textContent === "Browser API: 0", "browser realm reset");
  element("aot-dom-root").scrollIntoView();
  document.title = `Weber browser DOM PASS contracts=${contracts.length} native-events text property dispose`;
  location.href = "weber://close";
}

type Snapshot = { readonly epoch: number; readonly nodes: number; readonly listeners: readonly number[]; readonly tasks: number };
declare global {
  interface Window { readonly __weberDom?: { snapshot(): Snapshot; call(action: string, event?: unknown): unknown } }
  interface Window { weberHostCall(payload: string): string | null }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  check(value !== null, `Missing ${id}`);
  return value;
}
function waitFor(event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { window.removeEventListener(event, done); reject(new Error(`Timeout ${event}`)); }, 5000);
    function done() { clearTimeout(timeout); resolve(); }
    window.addEventListener(event, done, { once: true });
  });
}
async function navigate(action: string, event = "weber:dom-applied") {
  const complete = waitFor(event);
  location.href = `weber://${action}`;
  await complete;
}

export async function runDomTest(): Promise<void> {
  await navigate("dom-start");
  check(element("hermes-output").textContent === "Created by native AOT", "AOT created DOM text");
  const snapshot = window.__weberDom?.snapshot();
  check(snapshot !== undefined && snapshot.listeners.length === 3, "three rooted callbacks");
  const stale = snapshot.listeners[0];
  check(stale !== undefined, "click listener exists");
  let applied = waitFor("weber:dom-applied");
  element("hermes-button").click(); await applied;
  check(element("hermes-button").textContent === "AOT click: 1", "AOT click callback updates text");
  const queued = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { window.removeEventListener("weber:dom-applied", updated); reject(new Error("Queued clicks lost")); }, 5000);
    function updated() {
      if (element("hermes-button").textContent === "AOT click: 6") {
        clearTimeout(timeout); window.removeEventListener("weber:dom-applied", updated); resolve();
      }
    }
    window.addEventListener("weber:dom-applied", updated);
  });
  for (let click = 0; click < 5; click++) element("hermes-button").click();
  await queued;
  const input = element("hermes-input");
  check(input instanceof HTMLInputElement, "AOT input element type");
  const text = '<img src=x onerror="throw 1"> 한글 \\ "';
  input.value = text;
  applied = waitFor("weber:dom-applied");
  input.dispatchEvent(new Event("input", { bubbles: true })); await applied;
  check(element("hermes-output").textContent === text, "Unicode and quotes preserved");
  check(element("hermes-output").children.length === 0, "text is not HTML injection");
  const detached = element("hermes-button");
  applied = waitFor("weber:dom-applied");
  element("hermes-remove").click(); await applied;
  check(document.getElementById("hermes-panel") === null, "subtree removed");
  check(window.__weberDom?.snapshot().listeners.length === 1, "subtree callbacks released");
  detached.click();
  const raw = encodeURIComponent(JSON.stringify({ epoch: snapshot.epoch, listener: stale, value: "" }));
  await navigate(`dom-event?event=${raw}`, "weber:dom-error");
  await navigate("dom-start");
  check(element("hermes-button").textContent === "AOT click: 0", "fresh callback state after reset");
  await navigate(`dom-event?event=${raw}`, "weber:dom-error");
  await navigate("dom-dispose");
  const disposed = window.__weberDom?.snapshot();
  check(disposed?.nodes === 1 && disposed.listeners.length === 0, "dispose releases nodes and callbacks");
  check(element("aot-dom-root").children.length === 0, "dispose clears actual DOM");
  await navigate(`dom-event?event=${raw}`, "weber:dom-error");
  await navigate("dom-start");
  element("aot-dom-root").scrollIntoView();
  document.title = "Weber DOM binding PASS: create text attribute click input remove stale dispose";
  location.href = "weber://close";
}

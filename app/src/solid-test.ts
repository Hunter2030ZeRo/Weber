function check(value: boolean, message: string): asserts value { if (!value) throw new Error(message); }
export async function runSolidTest(): Promise<void> {
  // Install the adapter through the legacy mount path, then use only sync calls.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("adapter bootstrap timed out")), 5000);
    window.addEventListener("weber:dom-applied", () => { clearTimeout(timeout); resolve(); }, { once: true });
    location.href = "weber://dom-solid";
  });
  const adapter = window.__weberDom; check(adapter !== undefined, "native adapter installed");
  check(window.weberHostCall('{"action":"unknown"}') === null, "unsupported host call fails without blocking");
  const root = document.getElementById("aot-dom-root"); check(root !== null, "mount");
  function get<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = root?.querySelector<T>(`#${id}`); check(node !== null && node !== undefined, `Missing ${id}`); return node;
  }
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate: () => boolean, message: string) {
    const deadline = performance.now() + 5000;
    while (!predicate() && performance.now() < deadline) await delay(10);
    check(predicate(), message);
  }
  check(get("solid-count").textContent === "0", "AOT Solid initial render");
  let stateInNativeBubble = "";
  const observeMicrotask = () => { stateInNativeBubble = get("solid-microtask-state").textContent ?? ""; };
  root.addEventListener("click", observeMicrotask);
  get("solid-microtask").click(); root.removeEventListener("click", observeMicrotask);
  check(stateInNativeBubble === "handler" && get("solid-microtask-state").textContent === "handler", "Hermes microtask waits until native event dispatch returns");
  await Promise.resolve();
  check(get("solid-microtask-state").textContent === "microtask", "browser checkpoint drains native Hermes microtasks");
  const checkbox = get<HTMLInputElement>("solid-checkbox"); checkbox.click();
  check(!checkbox.checked, "AOT preventDefault rolls back native checkbox activation");
  let tail = 0; const observe = () => tail++;
  root.addEventListener("click", observe);
  get("solid-stop").click(); root.removeEventListener("click", observe);
  check(tail === 0, "AOT propagation decision affects native dispatch before bubble listener");
  get("solid-counter").click();
  check(get("solid-count").textContent === "1" && get("solid-conditional").textContent === "Visible after click", "signal and Show updated before click returns");
  checkbox.click(); check(checkbox.checked, "conditional allow preserves native checkbox default action");
  get("solid-counter").click();
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  check(!get("solid-link").dispatchEvent(event) && event.defaultPrevented, "native dispatch return and cancellation reflect AOT decision");
  const input = get<HTMLInputElement>("solid-input"); input.value = "Solid 한글 😀"; input.dispatchEvent(new Event("input", { bubbles: true }));
  check(get("solid-text").textContent === input.value, "Solid input update completed synchronously");
  const first = get("solid-list").children[0]; const third = get("solid-list").children[2];
  get("solid-reorder").click();
  check(get("solid-list").textContent === "314" && get("solid-list").children[0] === third && get("solid-list").children[1] === first, "native nodes preserved by Solid For reconciliation");
  await until(() => get("solid-timer").textContent === "timer ready" && get("solid-ticks").textContent === "3" && Number(get("solid-frames").textContent) >= 3, "real Servo timeout, interval and frame callbacks reach native AOT");
  check(Number(get("solid-stamp").textContent) > 0 && Math.abs(Number(get("solid-origin").textContent) - performance.timeOrigin) < 1, "AOT timestamps use the real document time origin");
  check(Math.abs(performance.timeOrigin + performance.now() - Date.now()) < 1000, "Servo timeOrigin uses Unix epoch rather than system uptime");
  check(Number(get("solid-origin").textContent) > 1e12, "Hermes receives the corrected Unix time origin");
  const movingTransform = get("solid-orb").style.transform;
  get("solid-motion").click(); const paused = get("solid-frames").textContent;
  await delay(70);
  check(get("solid-frames").textContent === paused && get("solid-ticks").textContent === "3", "rAF cancellation and self-cleared interval stay stopped");
  get("solid-motion").click();
  await until(() => Number(get("solid-frames").textContent) > Number(paused) && get("solid-orb").style.transform !== movingTransform, "AOT frame callbacks resume rendered motion");
  const oldFrames = get("solid-frames"); const oldCount = oldFrames.textContent;
  adapter.call("dispose"); check(root.firstChild === null && adapter.snapshot().tasks === 0, "Solid disposal releases native subtree and all scheduled callbacks");
  await delay(70); check(oldFrames.textContent === oldCount && root.firstChild === null, "disposed callbacks cannot update old or replacement DOM");
  adapter.call("solid"); check(get("solid-count").textContent === "0", "fresh document remount and template cache");
  await until(() => Number(get("solid-frames").textContent) >= 3 && get("solid-ticks").textContent === "3" && get("solid-timer").textContent === "timer ready", "fresh document schedules new callbacks after old session disposal");
  get("solid-motion").click(); check(adapter.snapshot().tasks === 0, "paused remount has no pending native tasks");
  root.scrollIntoView(); document.title = "Weber Solid AOT PASS sync cancellation checkbox propagation signals input keyed-list timers raf checkpoint dispose remount";
  location.href = "weber://close";
}

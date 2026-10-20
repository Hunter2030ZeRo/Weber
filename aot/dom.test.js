function check(condition, message) { if (!condition) throw new Error(message); }
function rejects(action, message) {
  let rejected = false;
  try { action(); } catch (error) { rejected = error instanceof Error; }
  check(rejected, message);
}
const dom = globalThis.WeberDOM;
const root = dom.begin();
const parent = dom.createElement("section");
const child = dom.createElement("button");
dom.appendChild(root, parent);
dom.appendChild(parent, child);
dom.remove(parent);
rejects(() => dom.setText(child, "stale"), "removed descendant must reject mutation");
rejects(() => dom.appendChild(root, child), "removed descendant must reject reuse");
dom.begin();
const first = dom.createElement("div");
const second = dom.createElement("div");
dom.appendChild(first, second);
rejects(() => dom.appendChild(second, first), "cycles must reject");
dom.dispose();
rejects(() => dom.createElement("div"), "disposed document must reject creation");
rejects(() => dom.dispose(), "double disposal must reject");
print("AOT DOM lifetime tests passed");

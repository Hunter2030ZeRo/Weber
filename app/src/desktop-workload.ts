// Shared ownership workload: compiled to native AOT or to the web comparison.
let retained: HTMLButtonElement | undefined;
export function mutate(count = 500) {
  if (!Number.isInteger(count) || count < 0 || count > 2000) throw new RangeError("Invalid mutation cohort");
  const create = () => {
    const node = document.createElement("button"); node.textContent = "temporary";
    node.addEventListener("click", () => { node.textContent = "listener cycle"; });
    document.body.appendChild(node); node.remove();
  };
  for (let index = 0; index < count; index++) create();
}
export function retain() {
  retained = document.createElement("button"); retained.id = "desktop-retained"; retained.textContent = "preserved";
  retained.addEventListener("click", () => { if (retained) retained.textContent = "reused"; });
  document.body.appendChild(retained); retained.remove();
}
export function reinsert() {
  if (!retained || retained.textContent !== "preserved") throw new Error("Retained detached node lost");
  document.body.appendChild(retained);
  if (document.getElementById("desktop-retained") !== retained) throw new Error("Retained identity changed");
}
export function releaseRetained() { retained?.remove(); retained = undefined; }

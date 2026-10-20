globalThis.weberLifetimePrepare = () => {
  const document = globalThis.WeberBrowserDOM.installGlobals();
  const retained = document.createElement("div"); retained.textContent = "retained detached";
  globalThis.weberRetainedNode = retained; globalThis.weberRetainedId = retained._id;
  const attached = document.createElement("div"); attached.id = "attached"; document.body.append(attached);
  const create = () => {
    const node = document.createElement("button"); node.textContent = "unreachable";
    node.addEventListener("click", () => node.textContent = "cycle");
    document.body.append(node); node.remove();
  };
  for (let index = 0; index < 500; index++) create();
  return document._nodes.size;
};
globalThis.weberLifetimeVerify = () => {
  const document = globalThis.document; document._nodes.sweep();
  if (document._nodes.size > 8) throw new Error("Unreachable detached DOM wrappers retained: " + document._nodes.size);
  const retained = globalThis.weberRetainedNode;
  if (document._nodes.get(globalThis.weberRetainedId) !== retained || retained.textContent !== "retained detached") throw new Error("Retained detached node lost its identity");
  document.body.append(retained); retained.setAttribute("data-reused", "yes");
  if (document.getElementById("attached") === null || retained.parentNode !== document.body) throw new Error("Attached node or reinsertion lost");
  return JSON.stringify({ passed: true, cases: ["unreachable detached wrappers released", "detached listener cycles collected", "retained detached identity preserved", "collected lookup retains connected tree", "retained node can be reinserted"], nodes: document._nodes.size });
};

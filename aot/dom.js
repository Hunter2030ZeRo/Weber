// Native AOT DOM facade. Handles and callbacks belong to one document session.
globalThis.WeberDOM = (() => {
  let epoch = 0;
  let nextNode = 1;
  let nextListener = 1;
  let active = false;
  let browserTopology = false;
  let commands = [];
  const nodes = new Map();
  const listeners = new Map();
  function requireNode(node) {
    if (!active || !nodes.has(node)) throw new Error("stale DOM node");
    return nodes.get(node);
  }
  function drop(node) {
    const entry = requireNode(node);
    for (const child of entry.children) drop(child);
    for (const [id, listener] of listeners) {
      if (listener.node === node) listeners.delete(id);
    }
    nodes.delete(node);
  }
  return {
    session() { return active ? epoch : 0; },
    stats() { return { session: active ? epoch : 0, nodes: nodes.size, topologyNodes: browserTopology ? 0 : nodes.size, listeners: listeners.size, allocatedHandles: nextNode - 1 }; },
    begin(browser = false) {
      globalThis.WeberScheduler?.reset();
      globalThis.WeberResize?.reset();
      globalThis.WeberFetch?.reset();
      epoch = globalThis.weberNextSession?.() ?? epoch + 1;
      active = true;
      browserTopology = browser;
      nodes.clear(); listeners.clear(); commands = [];
      nodes.set(0, browser ? null : { children: [], parent: null });
      commands.push({ op: "reset", epoch });
      return 0;
    },
    createElement(tag, namespace = "http://www.w3.org/1999/xhtml", inert = false) {
      requireNode(0);
      const node = nextNode++;
      nodes.set(node, browserTopology ? null : { children: [], parent: null });
      commands.push({ op: "create", node, tag, namespace, inert });
      return node;
    },
    reserveCloneHandle() {
      requireNode(0);
      if (!browserTopology) throw new Error("Native clone requires the browser facade");
      if (nextNode > 0xffffffff) throw new RangeError("DOM handle space exhausted");
      const node = nextNode++; nodes.set(node, null); return node;
    },
    cloneNative(source, deep, handles) { requireNode(source); commands.push({ op: "clone", source, deep: Boolean(deep), handles }); },
    appendChild(parent, node) {
      if (browserTopology) throw new Error("Browser topology uses validated insert");
      const destination = requireNode(parent);
      const entry = requireNode(node);
      if (node === 0 || entry.parent !== null) throw new Error("node already attached");
      for (let ancestor = parent; ancestor !== null; ancestor = requireNode(ancestor).parent) {
        if (ancestor === node) throw new Error("DOM cycle");
      }
      destination.children.push(node); entry.parent = parent;
      commands.push({ op: "append", parent, node });
    },
    createText(value) {
      requireNode(0);
      const node = nextNode++;
      nodes.set(node, browserTopology ? null : { children: [], parent: null });
      commands.push({ op: "createtext", node, value: String(value) });
      return node;
    },
    createComment(value) {
      requireNode(0); const node = nextNode++;
      nodes.set(node, browserTopology ? null : { children: [], parent: null });
      commands.push({ op: "createcomment", node, value: String(value) }); return node;
    },
    createProcessingInstruction(target, value) {
      requireNode(0); const node = nextNode++;
      nodes.set(node, browserTopology ? null : { children: [], parent: null });
      commands.push({ op: "createinstruction", node, target, value }); return node;
    },
    createFragment(template = null) {
      requireNode(0);
      const node = nextNode++;
      nodes.set(node, browserTopology ? null : { children: [], parent: null });
      commands.push({ op: "createfragment", node, template }); return node;
    },
    insert(parent, node, before) {
      const destination = requireNode(parent);
      const entry = requireNode(node);
      if (node === 0) throw new Error("cannot insert mount root");
      if (browserTopology) { if (before !== null) requireNode(before); commands.push({ op: "insert", parent, node, before }); return; }
      if (before !== null && requireNode(before).parent !== parent) throw new Error("NotFoundError");
      for (let ancestor = parent; ancestor !== null; ancestor = requireNode(ancestor).parent) {
        if (ancestor === node) throw new Error("HierarchyRequestError");
      }
      if (node === before) return;
      if (entry.parent !== null) {
        const old = requireNode(entry.parent);
        old.children = old.children.filter(child => child !== node);
      }
      const index = before === null ? destination.children.length : destination.children.indexOf(before);
      destination.children.splice(index, 0, node); entry.parent = parent;
      commands.push({ op: "insert", parent, node, before });
    },
    detach(node) {
      const entry = requireNode(node);
      if (node === 0) throw new Error("cannot detach mount root");
      if (browserTopology) { commands.push({ op: "detach", node }); return; }
      if (entry.parent === null) return;
      const parent = requireNode(entry.parent);
      parent.children = parent.children.filter(child => child !== node);
      entry.parent = null;
      commands.push({ op: "detach", node });
    },
    removeAttribute(node, name) { requireNode(node); commands.push({ op: "removeattribute", node, name }); },
    setProperty(node, name, value) { requireNode(node); commands.push({ op: "property", node, name, value: String(value) }); },
    setText(node, value) {
      const entry = requireNode(node);
      if (!browserTopology && entry.children.length) throw new Error("setText requires a leaf node");
      commands.push({ op: "text", node, value: String(value) });
    },
    setAttribute(node, name, value) {
      requireNode(node);
      commands.push({ op: "attribute", node, name, value: String(value) });
    },
    on(node, event, callback) {
      requireNode(node);
      const listener = nextListener++;
      listeners.set(listener, { node, callback });
      commands.push({ op: "listen", node, event, listener });
      return listener;
    },
    remove(node) {
      if (node === 0) throw new Error("cannot remove document root");
      if (browserTopology) throw new Error("Browser topology uses detach and weak release");
      const entry = requireNode(node);
      if (entry.parent !== null) {
        const parent = requireNode(entry.parent);
        parent.children = parent.children.filter(child => child !== node);
      }
      drop(node);
      commands.push({ op: "remove", node });
    },
    release(node) {
      if (node === 0 || !active || !nodes.has(node)) return;
      const entry = nodes.get(node);
      if (!browserTopology && entry.parent !== null && nodes.has(entry.parent)) {
        const parent = nodes.get(entry.parent); parent.children = parent.children.filter(child => child !== node);
      }
      nodes.delete(node);
      for (const [id, listener] of listeners) if (listener.node === node) listeners.delete(id);
      commands.push({ op: "release", node });
    },
    dispatch(raw) {
      const event = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!active || event.epoch !== epoch) throw new Error("stale DOM session");
      const listener = listeners.get(event.listener);
      if (!listener) throw new Error("stale DOM listener");
      requireNode(listener.node);
      return listener.callback(event.value, event);
    },
    dispose() {
      if (!active) throw new Error("DOM session already disposed");
      globalThis.WeberScheduler?.reset();
      globalThis.WeberResize?.reset();
      globalThis.WeberFetch?.reset();
      nodes.clear(); listeners.clear(); active = false;
      commands.push({ op: "dispose" });
    },
    takeCommands() { const result = commands; commands = []; return result; },
    flush() { return JSON.stringify(this.takeCommands()); },
    schedule(command) { requireNode(0); commands.push(command); },
  };
})();

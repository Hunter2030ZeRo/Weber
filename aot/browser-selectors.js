globalThis.WeberSelectors = (() => {
  const engine = () => globalThis.WeberPlatform.selectors;
  const adapter = {
    isTag: node => node.nodeType === 1,
    getAttributeValue: (node, name) => node.getAttribute(name) ?? undefined,
    getChildren: node => [...node.childNodes], getName: node => node.localName,
    getParent: node => node.parentNode,
    getSiblings: node => node.parentNode ? [...node.parentNode.childNodes] : [node],
    getText: node => node.textContent, hasAttrib: (node, name) => node.hasAttribute(name),
    removeSubsets: nodes => nodes.filter((node, index) => nodes.indexOf(node) === index && !nodes.some(other => other !== node && other.contains(node))),
  };
  function query(root, selector, includeRoot = false) {
    root._check?.();
    selector = String(selector);
    if (root._document._native && !includeRoot && !(root.nodeType === 9 && /:(root|scope)\b/i.test(selector))) {
      return globalThis.WeberLiveDOM.query("selectors", root._id, { op: "query", name: selector }).map(id => {
        const node = root._document._nodes.get(id); if (!node) throw new Error("Native selector wrapper missing"); return node;
      });
    }
    try {
      return engine().selectAll(String(selector), includeRoot ? [root] : root, {
        adapter, cacheResults: false, relativeSelector: false, context: root,
      });
    } catch (error) { throw new globalThis.WeberEvents.DOMException(String(error), "SyntaxError"); }
  }
  function matches(node, selector) {
    node._check();
    if (node._document._native) return globalThis.WeberLiveDOM.query("selectors", node._id, { op: "matches", name: String(selector) });
    try { return engine().is(node, String(selector), { adapter, cacheResults: false, relativeSelector: false, context: node }); }
    catch (error) { throw new globalThis.WeberEvents.DOMException(String(error), "SyntaxError"); }
  }
  return { query, matches };
})();

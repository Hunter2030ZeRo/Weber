globalThis.WeberHTML = (() => {
  function tree(node, adapter) {
    if (node.nodeType === 3) return { nodeName: "#text", value: node.data };
    if (node.nodeType === 8) return { nodeName: "#comment", data: node.data };
    const result = node.nodeType === 1 ? adapter.createElement(node.localName, node.namespaceURI, node._attributeList.map(attr => ({ name: attr.localName, value: attr.value, prefix: attr.prefix, namespace: attr.namespaceURI }))) : adapter.createDocumentFragment();
    for (const child of node.childNodes) adapter.appendChild(result, tree(child, adapter));
    if (node.content) adapter.setTemplateContent(result, tree(node.content, adapter)); return result;
  }
  function from(document, node) {
    if (node.nodeName === "#text") return document.createTextNode(node.value);
    if (node.nodeName === "#comment") return document.createComment(node.data);
    const result = document._element(node.tagName, node.namespaceURI, node.tagName === "script");
    for (const attr of node.attrs) { if (attr.namespace) result.setAttributeNS(attr.namespace, attr.prefix ? attr.prefix + ":" + attr.name : attr.name, attr.value); else result.setAttribute(attr.name, attr.value); }
    for (const child of node.childNodes) result.appendChild(from(document, child));
    if (node.content) for (const child of node.content.childNodes) result.content.appendChild(from(document, child)); return result;
  }
  function parse(element, html) {
    const { parseFragment, defaultTreeAdapter: adapter } = globalThis.WeberPlatform.html;
    element._check(); const context = adapter.createElement(element.localName, element.namespaceURI, []);
    const fragment = parseFragment(context, html); const replacement = element._document.createDocumentFragment();
    for (const child of fragment.childNodes) replacement.appendChild(from(element._document, child));
    (element.content ?? element).replaceChildren(replacement);
  }
  return { parse, serialize: node => { const { serialize, defaultTreeAdapter } = globalThis.WeberPlatform.html; return serialize(tree(node, defaultTreeAdapter)); } };
})();

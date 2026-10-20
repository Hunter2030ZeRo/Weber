globalThis.WeberBrowserDOM = (() => {
  const dom = globalThis.WeberDOM;
  const { Event, EventTarget, DOMException } = globalThis.WeberEvents;
  const HTML = "http://www.w3.org/1999/xhtml";
  function error(name, message) { throw new DOMException(message, name); }
  function notify(target, record) { globalThis.WeberObservers.notify(target._document, { target, ...record }); }
  function validName(name) { if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) error("InvalidCharacterError", "Invalid name"); }
  class Node extends EventTarget {
    constructor(document, id, type, name) {
      super(); this._document = document; this._id = id; this.nodeType = type; this.nodeName = name;
      this.parentNode = null; this._children = [];
      this.childNodes = globalThis.WeberCollections.create(() => this._children);
    }
    _check() { if (this._document._epoch !== dom.session()) error("InvalidStateError", "Document session expired"); }
    get ownerDocument() { return this.nodeType === 9 ? null : this._document; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get firstChild() { return this._children[0] ?? null; }
    get lastChild() { return this._children[this._children.length - 1] ?? null; }
    get nextSibling() { return this.parentNode?._children[this.parentNode._children.indexOf(this) + 1] ?? null; }
    get previousSibling() { return this.parentNode?._children[this.parentNode._children.indexOf(this) - 1] ?? null; }
    get children() { return this._elements ??= globalThis.WeberCollections.create(() => this._children.filter(node => node.nodeType === 1), true); }
    get firstElementChild() { return this.children[0] ?? null; }
    get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
    get childElementCount() { return this.children.length; }
    get isConnected() { return this.getRootNode().nodeType === 9; }
    getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
    hasChildNodes() { return this._children.length > 0; }
    get textContent() {
      this._check(); if (this.nodeType === 9) return null;
      if (this._document._native) return globalThis.WeberLiveDOM.query("node", this._id, { name: "textContent" });
      if ([3, 7, 8].includes(this.nodeType)) return this._data;
      return this._children.filter(node => ![7, 8].includes(node.nodeType)).map(node => node.textContent).join("");
    }
    set textContent(value) {
      this._check(); value = value == null ? "" : String(value); if (this.nodeType === 9) return;
      if ([3, 7, 8].includes(this.nodeType)) {
        const oldValue = this._document._observers.size ? this.textContent : null; if (!this._document._native) this._data = value; dom.setText(this._id, value);
        notify(this, { type: "characterData", oldValue }); return;
      }
      this.replaceChildren(...(value ? [this._document.createTextNode(value)] : []));
    }
    get nodeValue() { return [3, 7, 8].includes(this.nodeType) ? this.textContent : null; }
    set nodeValue(value) { if ([3, 7, 8].includes(this.nodeType)) this.textContent = value; }
    contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
    _validate(node, before) {
      this._check(); if (!(node instanceof Node)) throw new TypeError("Expected Node"); node._check();
      if (![1, 9, 11].includes(this.nodeType) || node.nodeType === 9 || node.contains(this)) error("HierarchyRequestError", "Invalid insertion");
      if (node._document !== this._document) error("NotSupportedError", "Cross-document adoption is unsupported");
      if (before !== null && before.parentNode !== this) error("NotFoundError", "Reference is not a child");
    }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, before) { return this._insert(node, before ?? null, false); }
    _insert(node, before, suppressed) {
      this._validate(node, before); if (node === before) before = node.nextSibling;
      const addedNodes = node.nodeType === 11 ? [...node.childNodes] : [node]; if (!addedNodes.length) return node;
      if (node.nodeType === 11) {
        for (const child of addedNodes) node._remove(child, true);
        notify(node, { type: "childList", addedNodes: [], removedNodes: addedNodes });
      } else if (node.parentNode) node.parentNode.removeChild(node);
      const previousSibling = before ? before.previousSibling : this.lastChild;
      for (const child of addedNodes) {
        dom.insert(this._id, child._id, before?._id ?? null);
        this._children.splice(before === null ? this._children.length : this._children.indexOf(before), 0, child); child.parentNode = this;
      }
      notify(this, { type: "childList", addedNodes, removedNodes: [], previousSibling, nextSibling: before, suppressed }); return node;
    }
    removeChild(node) { return this._remove(node, false); }
    _remove(node, suppressed) {
      this._check(); if (!(node instanceof Node)) throw new TypeError("Expected Node");
      if (node.parentNode !== this) error("NotFoundError", "Node is not a child");
      const previousSibling = node.previousSibling; const nextSibling = node.nextSibling;
      dom.detach(node._id); this._children.splice(this._children.indexOf(node), 1); node.parentNode = null;
      notify(this, { type: "childList", addedNodes: [], removedNodes: [node], previousSibling, nextSibling, suppressed }); return node;
    }
    replaceChild(node, old) {
      if (!(old instanceof Node) || old.parentNode !== this) error("NotFoundError", "Node is not a child"); this._validate(node, old);
      let nextSibling = old.nextSibling; if (nextSibling === node) nextSibling = node.nextSibling;
      if (node.parentNode) node.parentNode.removeChild(node);
      const previousSibling = old.previousSibling; const addedNodes = node.nodeType === 11 ? [...node.childNodes] : [node];
      const removedNodes = old.parentNode === this ? [this._remove(old, true)] : [];
      this._insert(node, nextSibling, true); notify(this, { type: "childList", addedNodes, removedNodes, previousSibling, nextSibling }); return old;
    }
    remove() { this._check(); if (this.parentNode) this.parentNode.removeChild(this); }
    append(...nodes) { for (const node of nodes) this.appendChild(node instanceof Node ? node : this._document.createTextNode(String(node))); }
    replaceChildren(...nodes) {
      this._check(); const replacements = nodes.map(node => node instanceof Node ? node : this._document.createTextNode(String(node)));
      for (const node of replacements) this._validate(node, null);
      let replacement = replacements[0] ?? null;
      if (replacements.length > 1) { replacement = this._document.createDocumentFragment(); for (const node of replacements) replacement.appendChild(node); }
      const addedNodes = replacement ? replacement.nodeType === 11 ? [...replacement.childNodes] : [replacement] : [];
      const removedNodes = [...this.childNodes]; for (const child of removedNodes) this._remove(child, true);
      if (replacement) this._insert(replacement, null, true);
      if (removedNodes.length || addedNodes.length) notify(this, { type: "childList", addedNodes, removedNodes });
    }
    cloneNode(deep = false) {
      this._check(); let clone;
      if (this._document._native) return this._cloneNative(Boolean(deep));
      if (this.nodeType === 3) clone = this._document.createTextNode(this.data);
      else if (this.nodeType === 8) clone = this._document.createComment(this.data);
      else if (this.nodeType === 7) clone = this._document.createProcessingInstruction(this.target, this.data);
      else if (this.nodeType === 11) clone = this._document.createDocumentFragment();
      else if (this.nodeType === 1) {
        clone = this._document._element(this.localName, this.namespaceURI, this._inert);
        for (const attr of this._attributeList) { if (attr.namespaceURI === null) clone.setAttribute(attr.name, attr.value); else clone.setAttributeNS(attr.namespaceURI, attr.name, attr.value); }
        if (this.localName === "input") { clone.value = this.value; clone.checked = this.checked; }
        if (this.content && deep) for (const child of this.content.childNodes) clone.content.appendChild(child.cloneNode(true));
      } else error("NotSupportedError", "Cannot clone this document");
      if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true)); return clone;
    }
    _cloneNative(deep) {
      const document = this._document, handles = [];
      function copy(source, deep) {
        if (![1, 3, 7, 8, 11].includes(source.nodeType)) error("NotSupportedError", "Cannot clone this node");
        const id = dom.reserveCloneHandle();
        handles.push({ node: id, name: source.nodeName, type: source.nodeType });
        let clone;
        if (source.nodeType === 3) clone = new Text(document, id, "");
        else if (source.nodeType === 8) clone = new Comment(document, id, "");
        else if (source.nodeType === 7) clone = new ProcessingInstruction(document, id, source.target, "");
        else if (source.nodeType === 11) clone = new DocumentFragment(document, id);
        else {
          clone = new Element(document, id, source.localName, source.namespaceURI);
          clone.nodeName = source.nodeName; clone.tagName = source.tagName; clone.prefix = source.prefix; clone._inert = source._inert;
          for (const attr of source._attributeList) {
            const copied = new attributeTypes.Attr(document, attr.namespaceURI, attr.prefix, attr.localName, attr.value);
            copied.ownerElement = clone; clone._attributeList.push(copied);
          }
          if (source.content) clone.content = copy(source.content, deep);
        }
        document._nodes.set(id, clone);
        if (deep) for (const child of source._children) { const copied = copy(child, true); copied.parentNode = clone; clone._children.push(copied); }
        return clone;
      }
      const clone = copy(this, deep);
      // Values/form state are copied inside Servo. Do not read and resend every
      // text/value/checked property through an individual synchronous query.
      dom.cloneNative(this._id, deep, handles); return clone;
    }
    querySelectorAll(selector) { const matches = globalThis.WeberSelectors.query(this, selector); return globalThis.WeberCollections.create(() => matches); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getElementsByTagName(name) {
      name = String(name); const lower = name.replace(/[A-Z]/g, character => character.toLowerCase());
      const collect = () => {
        const found = [];
        const walk = node => { for (const child of node.childNodes) { if (child.nodeType === 1 && (name === "*" || child.localName === (child.namespaceURI === HTML ? lower : name))) found.push(child); walk(child); } };
        walk(this); return found;
      };
      return globalThis.WeberCollections.create(collect, true);
    }
  }
  class CharacterData extends Node { get data() { return this.textContent; } set data(value) { this.textContent = value; } get length() { return this.data.length; } }
  class Text extends CharacterData { constructor(document, id, value) { super(document, id, 3, "#text"); if (!document._native) this._data = value; } }
  class Comment extends CharacterData { constructor(document, id, value) { super(document, id, 8, "#comment"); if (!document._native) this._data = value; } }
  class ProcessingInstruction extends CharacterData {
    constructor(document, id, target, value) { super(document, id, 7, target); this.target = target; if (!document._native) this._data = value; }
  }
  class DocumentFragment extends Node { constructor(document, id) { super(document, id, 11, "#document-fragment"); } }
  class Element extends Node {
    constructor(document, id, tag, namespace = HTML) {
      super(document, id, 1, namespace === HTML ? tag.toUpperCase() : tag);
      this.tagName = this.nodeName; this.localName = tag; this.namespaceURI = namespace; this._attributeList = []; if (!document._native) { this._value = ""; this._checked = false; }
    }
    matches(selector) { return globalThis.WeberSelectors.matches(this, selector); }
    closest(selector) { for (let node = this; node?.nodeType === 1; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    get classList() { return this._classList ??= new globalThis.WeberTokens(this); }
    set classList(value) { this.classList.value = value; }
    get style() {
      this._check(); if (!this._style) {
        if (globalThis.weberCanQuery?.()) return this._style = globalThis.WeberStyle.create(this);
        this._style = globalThis.WeberPlatform.createStyle(value => { if (!this._styleSync) this.setAttribute("style", value); });
        this._styleSync = true; try { this._style.cssText = this.getAttribute("style") ?? ""; } finally { this._styleSync = false; }
      } return this._style;
    }
    set style(value) { this.style.cssText = String(value); }
    get id() { return this.getAttribute("id") ?? ""; } set id(value) { this.setAttribute("id", value); }
    get className() { return this.getAttribute("class") ?? ""; } set className(value) { this.setAttribute("class", value); }
    get value() { this._check(); return this._document._native ? globalThis.WeberLiveDOM.query("node", this._id, { name: "value" }) : this._value; } set value(value) { this._check(); value = String(value); if (!this._document._native) this._value = value; dom.setProperty(this._id, "value", value); }
    get checked() { this._check(); return this._document._native ? globalThis.WeberLiveDOM.query("node", this._id, { name: "checked" }) : this._checked; } set checked(value) { this._check(); value = Boolean(value); if (!this._document._native) this._checked = value; dom.setProperty(this._id, "checked", value); }
    get disabled() { return this.hasAttribute("disabled"); } set disabled(value) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
    get innerHTML() { return globalThis.WeberHTML.serialize(this.content ?? this); } set innerHTML(value) { globalThis.WeberHTML.parse(this, String(value)); }
  }
  const attributeTypes = globalThis.WeberAttributes.install(Element, Node);
  class Document extends Node {
    constructor() {
      dom.begin(true); super(null, 0, 9, "#document"); this._document = this; this._epoch = dom.session(); this._native = Boolean(globalThis.weberCanQuery?.());
      this._nodes = new globalThis.WeberNodeRegistry(this); this._nodes.set(0, this); this._nativeEvents = new Set(); this.listenerErrors = []; this._observers = new Set();
      this.documentElement = this.createElement("html"); this.head = this.createElement("head"); this.body = this.createElement("body");
      this.appendChild(this.documentElement); this.documentElement.append(this.head, this.body); this.defaultView = globalThis;
    }
    get title() { return this.head.querySelector("title")?.textContent ?? ""; }
    set title(value) {
      this._check(); value = String(value);
      let title = this.head.querySelector("title"); if (!title) { title = this.createElement("title"); this.head.append(title); }
      title.textContent = value; dom.schedule({ op: "title", value });
    }
    _element(tag, namespace, inert = false) {
      this._check(); validName(tag); const element = new Element(this, dom.createElement(tag, namespace, inert), tag, namespace);
      element._inert = inert; this._nodes.set(element._id, element);
      if (tag === "template" && namespace === HTML) { element.content = new DocumentFragment(this, dom.createFragment(element._id)); this._nodes.set(element.content._id, element.content); }
      return element;
    }
    createElement(tag) { return this._element(String(tag).toLowerCase(), HTML); }
    createElementNS(namespace, tag) {
      const info = globalThis.WeberAttributes.qualified(namespace, tag);
      const node = this._element(info.name, info.namespaceURI); node.prefix = info.prefix; node.localName = info.localName; return node;
    }
    createAttribute(name) { name = globalThis.WeberAttributes.name(name).replace(/[A-Z]/g, character => character.toLowerCase()); return new attributeTypes.Attr(this, null, null, name); }
    createAttributeNS(ns, name) { const info = globalThis.WeberAttributes.qualified(ns, name); return new attributeTypes.Attr(this, info.namespaceURI, info.prefix, info.localName); }
    createTextNode(value) { this._check(); value = String(value); const node = new Text(this, dom.createText(value), value); this._nodes.set(node._id, node); return node; }
    createComment(value) { this._check(); value = String(value); const node = new Comment(this, dom.createComment(value), value); this._nodes.set(node._id, node); return node; }
    createProcessingInstruction(target, value) {
      this._check(); target = String(target); value = String(value); validName(target);
      if (value.includes("?>")) error("InvalidCharacterError", "Invalid processing instruction data");
      const node = new ProcessingInstruction(this, dom.createProcessingInstruction(target, value), target, value); this._nodes.set(node._id, node); return node;
    }
    createEvent(type) {
      type = String(type).toLowerCase();
      const Constructor = type === "customevent" ? globalThis.WeberEvents.CustomEvent : ["event", "events", "htmlevents"].includes(type) ? Event : null;
      if (!Constructor) error("NotSupportedError", "Unsupported event interface");
      const event = new Constructor(""); event._initialized = false; return event;
    }
    createDocumentFragment() { this._check(); const node = new DocumentFragment(this, dom.createFragment()); this._nodes.set(node._id, node); return node; }
    importNode(node, deep = false) { if (node._document !== this) error("NotSupportedError", "Cross-document import is not implemented"); return node.cloneNode(deep); }
    getElementById(id) { id = String(id); const find = node => { if (node.nodeType === 1 && node.id === id && id) return node; for (const child of node.childNodes) { const result = find(child); if (result) return result; } return null; }; return find(this); }
    _listen(type) {
      this._check(); if (!["click", "input", "change", "submit", "keydown", "keyup", "beforeinput", "scroll", "compositionstart", "compositionupdate", "compositionend"].includes(type) || this._nativeEvents.has(type)) return;
      this._nativeEvents.add(type); dom.on(0, type, (value, message) => {
        const target = this._nodes.get(message.target); if (!target) throw new Error("Native event target is not managed");
        const previousChecked = target._checked;
        if (!this._native) { if (type === "input") target._value = value; if (message.checked != null) target._checked = message.checked; }
        const ui = message.ui ?? {};
        const Constructor = globalThis.WeberEvents[{ mouse: "MouseEvent", keyboard: "KeyboardEvent", input: "InputEvent", composition: "CompositionEvent" }[ui.kind]] ?? Event;
        const event = new Constructor(type, { ...ui, relatedTarget: this._nodes.get(ui.relatedTarget) ?? null, view: globalThis, bubbles: message.bubbles ?? true, cancelable: message.cancelable }); event.defaultPrevented = Boolean(message.default_prevented);
        target.dispatchEvent(event);
        if (!this._native && type === "click" && event.defaultPrevented && target.localName === "input" && target.getAttribute("type") === "checkbox") target._checked = previousChecked;
        return event._nativeDecision;
      });
    }
  }
  const constants = { ELEMENT_NODE: 1, TEXT_NODE: 3, PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 };
  Object.assign(Node, constants); Object.assign(Node.prototype, constants);
  globalThis.WeberLiveDOM.install(Element, Document);
  function installGlobals() {
    const document = new Document(); Object.assign(globalThis, { window: globalThis, document, Node, Text, Comment, ProcessingInstruction, CharacterData, DocumentFragment, Element, HTMLElement: Element, Document,
      NodeList: globalThis.WeberCollections.NodeList, HTMLCollection: globalThis.WeberCollections.HTMLCollection,
      MutationObserver: globalThis.WeberObservers.MutationObserver, ...globalThis.WeberEvents });
    Object.assign(globalThis, attributeTypes);
    if (globalThis.weberCanQuery?.()) globalThis.CSSStyleDeclaration = globalThis.WeberStyle.CSSStyleDeclaration;
    Object.assign(globalThis, { ResizeObserver: globalThis.WeberResize.ResizeObserver });
    Object.assign(globalThis, { fetch: globalThis.WeberFetch.fetch, Headers: globalThis.WeberFetch.Headers, Response: globalThis.WeberFetch.Response });
    const target = new EventTarget();
    for (const name of ["addEventListener", "removeEventListener", "dispatchEvent"]) globalThis[name] = target[name].bind(target);
    globalThis.WeberScheduler?.install(); globalThis.WeberLiveDOM.installGlobals(); return document;
  }
  return { createDocument: () => new Document(), installGlobals, Node, Text, Comment, Element, Document, ...globalThis.WeberEvents };
})();

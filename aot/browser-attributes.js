globalThis.WeberAttributes = (() => {
  const XML = "http://www.w3.org/XML/1998/namespace", XMLNS = "http://www.w3.org/2000/xmlns/";
  const fail = (name, message) => { throw new globalThis.WeberEvents.DOMException(message, name); };
  const namespace = value => value == null || String(value) === "" ? null : String(value);
  const lower = value => String(value).replace(/[A-Z]/g, character => character.toLowerCase());
  function name(value) {
    value = String(value);
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) fail("InvalidCharacterError", "Invalid attribute name");
    return value;
  }
  function qualified(ns, value) {
    ns = namespace(ns); value = name(value);
    const parts = value.split(":");
    if (parts.length > 2 || parts.some(part => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(part))) fail("InvalidCharacterError", "Invalid qualified name");
    const prefix = parts.length === 2 ? parts[0] : null, localName = parts.at(-1);
    if ((prefix && !ns) || (prefix === "xml" && ns !== XML) || ((value === "xmlns" || prefix === "xmlns") && ns !== XMLNS) || (ns === XMLNS && value !== "xmlns" && prefix !== "xmlns")) fail("NamespaceError", "Invalid namespace");
    return { namespaceURI: ns, prefix, localName, name: value };
  }
  function install(Element, Node) {
    class Attr extends Node {
      constructor(document, ns, prefix, localName, value = "") {
        super(document, null, 2, prefix ? prefix + ":" + localName : localName);
        this.namespaceURI = ns; this.prefix = prefix; this.localName = localName; this.ownerElement = null; this._value = String(value);
      }
      get name() { return this.prefix ? this.prefix + ":" + this.localName : this.localName; }
      get nodeName() { return this.name; } set nodeName(value) {}
      get specified() { return true; }
      get value() { return this._value; }
      set value(value) { value = String(value); if (this.ownerElement) this.ownerElement._setAttributeValue(this, value); else this._value = value; }
      get nodeValue() { return this.value; } set nodeValue(value) { this.value = value == null ? "" : value; }
      get textContent() { return this.value; } set textContent(value) { this.value = value == null ? "" : value; }
      cloneNode() { return new Attr(this._document, this.namespaceURI, this.prefix, this.localName, this.value); }
    }
    class NamedNodeMap {
      constructor(element) {
        this._element = element;
        const find = key => typeof key === "string" ? /^(0|[1-9][0-9]*)$/.test(key) ? element._attributeList[Number(key)] : element.getAttributeNode(key) : null;
        return new Proxy(this, {
          get: (target, key, receiver) => Reflect.has(target, key) ? Reflect.get(target, key, receiver) : find(key) ?? undefined,
          has: (target, key) => Reflect.has(target, key) || Boolean(find(key)),
          ownKeys: target => [...new Set([...element._attributeList.keys()].map(String).concat(element._attributeList.map(attr => attr.name).filter(key => !(key in target)), Reflect.ownKeys(target)))],
          getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key) ?? (find(key) ? { value: find(key), enumerable: /^(0|[1-9][0-9]*)$/.test(key), configurable: true, writable: false } : undefined),
        });
      }
      get length() { return this._element._attributeList.length; }
      item(index) { if (!arguments.length) throw new TypeError("Index required"); return this._element._attributeList[Number(index) >>> 0] ?? null; }
      getNamedItem(name) { return this._element.getAttributeNode(name); }
      getNamedItemNS(ns, local) { return this._element.getAttributeNodeNS(ns, local); }
      setNamedItem(attr) { return this._element.setAttributeNode(attr); }
      setNamedItemNS(attr) { return this._element.setAttributeNodeNS(attr); }
      removeNamedItem(name) { const attr = this.getNamedItem(name); if (!attr) fail("NotFoundError", "Attribute not found"); return this._element.removeAttributeNode(attr); }
      removeNamedItemNS(ns, local) { const attr = this.getNamedItemNS(ns, local); if (!attr) fail("NotFoundError", "Attribute not found"); return this._element.removeAttributeNode(attr); }
      [Symbol.iterator]() { return this._element._attributeList[Symbol.iterator](); }
    }
    const prototype = Element.prototype;
    // The list owns identity/namespaces; the Map view is only for selector and
    // serializer adapters which consume qualified names.
    Object.defineProperties(prototype, {
      _attributes: { get() { const result = new Map(); for (const attr of this._attributeList) if (!result.has(attr.name)) result.set(attr.name, attr.value); return result; } },
      attributes: { get() { return this._namedAttributes ??= new NamedNodeMap(this); } },
      dataset: { get() {
        if (this._dataset) return this._dataset;
        const keyName = key => {
          key = String(key); if (/-[a-z]/.test(key)) fail("SyntaxError", "Invalid dataset key");
          return "data-" + key.replace(/[A-Z]/g, character => "-" + character.toLowerCase());
        };
        const entries = () => this._attributeList.filter(attr => attr.namespaceURI === null && attr.name.startsWith("data-") && !/[A-Z]/.test(attr.name.slice(5))).map(attr => [attr.name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase()), attr.value]);
        const target = {};
        this._dataset = new Proxy(target, {
          get: (target, key) => typeof key === "string" ? entries().find(([name]) => name === key)?.[1] ?? Reflect.get(target, key) : Reflect.get(target, key),
          set: (target, key, value) => { if (typeof key !== "string") return Reflect.set(target, key, value); this.setAttribute(keyName(key), String(value)); return true; },
          deleteProperty: (target, key) => { if (typeof key === "string") this.removeAttribute(keyName(key)); return true; },
          has: (target, key) => entries().some(([name]) => name === key) || Reflect.has(target, key),
          ownKeys: () => entries().map(([name]) => name),
          getOwnPropertyDescriptor: (target, key) => { const entry = entries().find(([name]) => name === key); return entry ? { value: entry[1], enumerable: true, configurable: true, writable: true } : undefined; },
        });
        return this._dataset;
      } },
    });
    Object.assign(prototype, {
      getAttributeNode(value) { this._check(); value = this.namespaceURI === "http://www.w3.org/1999/xhtml" ? lower(value) : String(value); return this._attributeList.find(attr => attr.name === value) ?? null; },
      getAttributeNodeNS(ns, local) { this._check(); ns = namespace(ns); local = String(local); return this._attributeList.find(attr => attr.namespaceURI === ns && attr.localName === local) ?? null; },
      getAttribute(value) { return this.getAttributeNode(value)?.value ?? null; },
      getAttributeNS(ns, local) { return this.getAttributeNodeNS(ns, local)?.value ?? null; },
      hasAttribute(value) { return this.getAttributeNode(value) !== null; },
      hasAttributeNS(ns, local) { return this.getAttributeNodeNS(ns, local) !== null; },
      hasAttributes() { return this._attributeList.length > 0; },
      getAttributeNames() { return this._attributeList.map(attr => attr.name); },
      setAttribute(value, data) {
        value = name(value); if (this.namespaceURI === "http://www.w3.org/1999/xhtml") value = lower(value);
        let attr = this.getAttributeNode(value);
        if (!attr) { attr = new Attr(this._document, null, null, value); attr._new = true; attr.ownerElement = this; this._attributeList.push(attr); }
        this._setAttributeValue(attr, String(data));
      },
      setAttributeNS(ns, value, data) {
        const info = qualified(ns, value); data = String(data);
        let attr = this.getAttributeNodeNS(info.namespaceURI, info.localName);
        if (!attr) { attr = new Attr(this._document, info.namespaceURI, info.prefix, info.localName); attr._new = true; attr.ownerElement = this; this._attributeList.push(attr); }
        attr.prefix = info.prefix; this._setAttributeValue(attr, data);
      },
      _setAttributeValue(attr, value) {
        this._check(); const oldValue = attr._new ? null : attr.value; delete attr._new;
        attr._value = value;
        globalThis.WeberDOM.schedule(attr.namespaceURI === null ? { op: "attribute", node: this._id, name: attr.name, value } : { op: "attributens", node: this._id, namespace: attr.namespaceURI, name: attr.name, value });
        if (attr.namespaceURI === null && attr.name === "style" && this._style && !globalThis.WeberStyle.isNative(this._style) && !this._styleSync) { this._styleSync = true; try { this._style.cssText = value; } finally { this._styleSync = false; } }
        globalThis.WeberObservers.notify(this._document, { target: this, type: "attributes", attributeName: attr.localName, attributeNamespace: attr.namespaceURI, oldValue });
      },
      removeAttribute(value) { const attr = this.getAttributeNode(value); if (attr) this.removeAttributeNode(attr); },
      removeAttributeNS(ns, local) { const attr = this.getAttributeNodeNS(ns, local); if (attr) this.removeAttributeNode(attr); },
      removeAttributeNode(attr) {
        if (!(attr instanceof Attr)) throw new TypeError("Expected Attr");
        if (attr.ownerElement !== this) fail("NotFoundError", "Attribute not owned by element");
        this._check(); const oldValue = attr.value;
        this._attributeList.splice(this._attributeList.indexOf(attr), 1); attr.ownerElement = null;
        globalThis.WeberDOM.schedule({ op: "removeattributens", node: this._id, namespace: attr.namespaceURI, name: attr.localName });
        if (attr.namespaceURI === null && attr.name === "style" && this._style && !globalThis.WeberStyle.isNative(this._style)) { this._styleSync = true; try { this._style.cssText = ""; } finally { this._styleSync = false; } }
        globalThis.WeberObservers.notify(this._document, { target: this, type: "attributes", attributeName: attr.localName, attributeNamespace: attr.namespaceURI, oldValue });
        return attr;
      },
      setAttributeNode(attr) { return this.setAttributeNodeNS(attr); },
      _syncNativeStyle(value, mutations) {
        let attr = this.getAttributeNodeNS(null, "style");
        if (value === null) {
          if (attr) { this._attributeList.splice(this._attributeList.indexOf(attr), 1); attr.ownerElement = null; }
        } else {
          if (!attr) { attr = new Attr(this._document, null, null, "style"); attr.ownerElement = this; this._attributeList.push(attr); }
          attr._value = value;
        }
        for (const oldValue of mutations) globalThis.WeberObservers.notify(this._document, { target: this, type: "attributes", attributeName: "style", attributeNamespace: null, oldValue });
      },
      setAttributeNodeNS(attr) {
        this._check(); if (!(attr instanceof Attr)) throw new TypeError("Expected Attr");
        if (attr.ownerElement && attr.ownerElement !== this) fail("InUseAttributeError", "Attribute already owned");
        const old = this.getAttributeNodeNS(attr.namespaceURI, attr.localName);
        if (old === attr) return attr;
        if (old) { const index = this._attributeList.indexOf(old); this._attributeList[index] = attr; old.ownerElement = null; }
        else this._attributeList.push(attr);
        attr.ownerElement = this; attr._document = this._document;
        attr._new = !old;
        const previous = old?.value;
        const value = attr.value; if (old) attr._value = previous;
        this._setAttributeValue(attr, value); return old;
      },
    });
    return { Attr, NamedNodeMap };
  }
  return { install, namespace, qualified, name };
})();

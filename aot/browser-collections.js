globalThis.WeberCollections = (() => {
  class NodeList {
    constructor(source) { this._source = source; }
    get length() { return this._source().length; }
    item(index) { return this._source()[Number(index) >>> 0] ?? null; }
    *values() { for (let i = 0; i < this.length; i++) yield this.item(i); }
    *keys() { for (let i = 0; i < this.length; i++) yield i; }
    *entries() { for (let i = 0; i < this.length; i++) yield [i, this.item(i)]; }
    forEach(callback, thisArg) { for (let i = 0; i < this.length; i++) callback.call(thisArg, this.item(i), i, this); }
    [Symbol.iterator]() { return this.values(); }
    get [Symbol.toStringTag]() { return "NodeList"; }
  }
  class HTMLCollection extends NodeList {
    namedItem(name) { name = String(name); return this._source().find(node => name && (node.id === name || node.getAttribute("name") === name)) ?? null; }
    get [Symbol.toStringTag]() { return "HTMLCollection"; }
  }
  function create(source, elements = false) {
    return new Proxy(elements ? new HTMLCollection(source) : new NodeList(source), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) return target._source()[Number(key)];
        if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
        return elements && typeof key === "string" ? target.namedItem(key) ?? undefined : undefined;
      },
      set() { throw new TypeError("DOM collections are read only"); },
    });
  }
  return { create, NodeList, HTMLCollection };
})();

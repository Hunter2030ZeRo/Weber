// Live reads flush preceding writes and use the suspended Servo script call's
// scoped query route. Never calculate layout from the local mirror.
globalThis.WeberLiveDOM = (() => {
  function query(kind, node = null, args = {}) {
    const epoch = globalThis.WeberDOM.session();
    if (!epoch) throw new globalThis.WeberEvents.DOMException("Document session expired", "InvalidStateError");
    const response = globalThis.WeberWire.decode(new Uint8Array(globalThis.weberDomQueryBytes(globalThis.WeberWire.encode({ epoch, kind, node, args, commands: globalThis.WeberDOM.takeCommands() }).buffer)));
    if (!response.ok) throw new globalThis.WeberEvents.DOMException(response.error.message, response.error.name);
    return response.value;
  }
  class DOMRectReadOnly {
    constructor(x = 0, y = 0, width = 0, height = 0) { this._x = Number(x); this._y = Number(y); this._width = Number(width); this._height = Number(height); }
    get x() { return this._x; } get y() { return this._y; } get width() { return this._width; } get height() { return this._height; }
    get top() { return Math.min(this.y, this.y + this.height); } get bottom() { return Math.max(this.y, this.y + this.height); }
    get left() { return Math.min(this.x, this.x + this.width); } get right() { return Math.max(this.x, this.x + this.width); }
    toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }; }
    static fromRect(rect = {}) { return new this(rect.x ?? 0, rect.y ?? 0, rect.width ?? 0, rect.height ?? 0); }
  }
  class DOMRect extends DOMRectReadOnly {
    get x() { return this._x; } set x(value) { this._x = Number(value); }
    get y() { return this._y; } set y(value) { this._y = Number(value); }
    get width() { return this._width; } set width(value) { this._width = Number(value); }
    get height() { return this._height; } set height(value) { this._height = Number(value); }
  }
  const cssName = name => name === "cssFloat" ? "float" : name.replace(/[A-Z]/g, character => "-" + character.toLowerCase());
  function install(Element, Document) {
    const check = node => { if (!(node instanceof Element)) throw new TypeError("Expected Element"); node._check(); };
    const scroll = (node, relative, args) => {
      let options;
      if (args.length === 1 && (args[0] == null || typeof args[0] === "object")) options = args[0] ?? {};
      else options = { left: args[0], top: args[1] };
      const data = { relative, behavior: String(options.behavior ?? "auto") };
      for (const [key, value] of [["x", options.left], ["y", options.top]]) if (value !== undefined) data[key] = Number.isFinite(Number(value)) ? Number(value) : 0;
      query("scroll", node, data);
    };
    Object.assign(Element.prototype, {
      getBoundingClientRect() { check(this); return DOMRect.fromRect(query("rect", this._id)); },
      getClientRects() {
        check(this); const rects = query("rects", this._id).map(rect => DOMRect.fromRect(rect));
        const result = { length: rects.length, item(index) { return rects[Number(index) >>> 0] ?? null; }, [Symbol.iterator]() { return rects[Symbol.iterator](); } };
        rects.forEach((rect, index) => Object.defineProperty(result, index, { value: rect, enumerable: true })); return result;
      },
      scrollTo(...args) { check(this); scroll(this._id, false, args); },
      scroll(...args) { this.scrollTo(...args); },
      scrollBy(...args) { check(this); scroll(this._id, true, args); },
      focus(options = {}) { check(this); query("focus", this._id, { preventScroll: Boolean(options?.preventScroll) }); },
      blur() { check(this); query("blur", this._id); },
    });
    for (const name of ["clientWidth", "clientHeight", "clientTop", "clientLeft", "scrollWidth", "scrollHeight", "scrollTop", "scrollLeft"]) {
      Object.defineProperty(Element.prototype, name, { configurable: true, get() { check(this); return query("metrics", this._id)[name]; },
        ...(["scrollTop", "scrollLeft"].includes(name) ? { set(value) { scroll(this._id, false, [{ [name === "scrollLeft" ? "left" : "top"]: value }]); } } : {}) });
    }
    Object.defineProperty(Document.prototype, "activeElement", { configurable: true, get() { this._check(); const id = query("active"); return this._nodes.get(id) ?? this.body; } });
  }
  function installGlobals() {
    Object.assign(globalThis, { DOMRect, DOMRectReadOnly,
      getComputedStyle(element, pseudo = null) {
        if (!element?._document || element.nodeType !== 1) throw new TypeError("Expected Element"); element._check();
        const read = name => query("computed", element._id, { name, pseudo: pseudo == null ? null : String(pseudo) });
        // Obtain the real declaration once to validate element/pseudo arguments.
        read("");
        const readonly = () => { throw new globalThis.WeberEvents.DOMException("Computed style is read only", "NoModificationAllowedError"); };
        const target = { getPropertyValue: name => read(String(name)), getPropertyPriority: () => "", setProperty: readonly, removeProperty: readonly,
          item(index) { return query("computedNames", element._id)[Number(index) >>> 0] ?? ""; },
          get length() { return query("computedNames", element._id).length; }, get cssText() { return ""; },
          [Symbol.iterator]() { return query("computedNames", element._id)[Symbol.iterator](); } };
        return new Proxy(target, { get: (target, key, receiver) => typeof key !== "string" || Reflect.has(target, key) ? Reflect.get(target, key, receiver) : /^(0|[1-9][0-9]*)$/.test(key) ? target.item(key) || undefined : read(cssName(key)), set: readonly });
      },
      scrollTo: (...args) => scroll(null, false, args), scroll: (...args) => scroll(null, false, args), scrollBy: (...args) => scroll(null, true, args),
    });
    for (const name of ["innerWidth", "innerHeight", "scrollX", "scrollY", "pageXOffset", "pageYOffset", "devicePixelRatio"]) Object.defineProperty(globalThis, name, { configurable: true, get: () => query("viewport")[name] });
  }
  return { query, install, installGlobals };
})();

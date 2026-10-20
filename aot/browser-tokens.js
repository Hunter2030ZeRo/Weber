globalThis.WeberTokens = class DOMTokenList {
  constructor(element) {
    this._element = element;
    const index = key => typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 0xffffffff;
    return new Proxy(this, {
      get: (target, key, receiver) => index(key) ? target._tokens()[Number(key)] : Reflect.get(target, key, receiver),
      has: (target, key) => index(key) ? Number(key) < target.length : Reflect.has(target, key),
      ownKeys: target => [...target._tokens().keys()].map(String).concat(Reflect.ownKeys(target)),
      getOwnPropertyDescriptor: (target, key) => index(key) && Number(key) < target.length ? { value: target._tokens()[Number(key)], enumerable: true, configurable: true, writable: false } : Reflect.getOwnPropertyDescriptor(target, key),
    });
  }
  _tokens() { return [...new Set(this._element.className.split(/[\t\n\f\r ]+/).filter(Boolean))]; }
  _validate(tokens) {
    if (tokens.includes("")) throw new globalThis.WeberEvents.DOMException("Empty token", "SyntaxError");
    for (const token of tokens) {
      if (!token) throw new globalThis.WeberEvents.DOMException("Empty token", "SyntaxError");
      if (/[\t\n\f\r ]/.test(token)) throw new globalThis.WeberEvents.DOMException("Whitespace in token", "InvalidCharacterError");
    }
  }
  get value() { return this._element.className; } set value(value) { this._element.className = value; }
  get length() { return this._tokens().length; }
  item(index) { if (!arguments.length) throw new TypeError("Index required"); return this._tokens()[Number(index) >>> 0] ?? null; }
  contains(token) { if (!arguments.length) throw new TypeError("Token required"); return this._tokens().includes(String(token)); }
  supports() { throw new TypeError("classList has no supported tokens"); }
  _update(tokens) { if (!tokens.length && !this._element.hasAttribute("class")) return; this.value = tokens.join(" "); }
  add(...tokens) { tokens = tokens.map(String); this._validate(tokens); this._update([...new Set([...this._tokens(), ...tokens])]); }
  remove(...tokens) { tokens = tokens.map(String); this._validate(tokens); this._update(this._tokens().filter(token => !tokens.includes(token))); }
  toggle(token, force) {
    if (!arguments.length) throw new TypeError("Token required");
    token = String(token); this._validate([token]); const exists = this.contains(token);
    const present = force === undefined ? !exists : Boolean(force);
    if (present && !exists) this.add(token); if (!present && exists) this.remove(token); return present;
  }
  replace(old, replacement) {
    if (arguments.length < 2) throw new TypeError("Two tokens required");
    old = String(old); replacement = String(replacement); this._validate([old, replacement]);
    const tokens = this._tokens(); if (!tokens.includes(old)) return false;
    this.value = [...new Set(tokens.map(token => token === old ? replacement : token))].join(" "); return true;
  }
  [Symbol.iterator]() { return this._tokens()[Symbol.iterator](); }
  toString() { return this.value; }
};

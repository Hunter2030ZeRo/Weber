// Only identity and application expandos live here. Servo owns the declaration,
// CSS parsing and normalized values. Local fallback is for standalone runtimes.
globalThis.WeberStyle = (() => {
  const token = {}, receivers = new WeakMap();
  let properties;
  const index = key => typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
  const string = value => { if (typeof value === "symbol") throw new TypeError("Cannot convert symbol to DOMString"); return String(value); };
  const argument = (count, minimum) => { if (count < minimum) throw new TypeError("Missing CSSStyleDeclaration argument"); };
  function request(receiver, op, name, value, priority) {
    const element = receivers.get(receiver);
    if (!element) throw new TypeError("Illegal CSSStyleDeclaration invocation");
    element._check();
    const reply = globalThis.WeberLiveDOM.query("style", element._id, { op, name, value, priority });
    if (reply.mutations) element._syncNativeStyle(reply.attribute, reply.mutations);
    return reply.defined ? reply.value : undefined;
  }
  class CSSStyleDeclaration {
    constructor(element, key) { if (key !== token) throw new TypeError("Illegal constructor"); receivers.set(this, element); }
    get cssText() { return request(this, "get", "cssText"); }
    set cssText(value) { request(this, "set", "cssText", string(value)); }
    get length() { return request(this, "get", "length"); }
    get parentRule() { return null; }
    item(value) { argument(arguments.length, 1); return request(this, "item", String(Number(value) >>> 0)); }
    getPropertyValue(name) { argument(arguments.length, 1); return request(this, "value", string(name)); }
    getPropertyPriority(name) { argument(arguments.length, 1); return request(this, "priority", string(name)); }
    setProperty(name, value, priority = "") {
      argument(arguments.length, 2); request(this, "setProperty", string(name), value == null ? "" : string(value), priority == null ? "" : string(priority));
    }
    removeProperty(name) { argument(arguments.length, 1); return request(this, "removeProperty", string(name)); }
    [Symbol.iterator]() {
      let offset = 0; const declaration = this;
      return { next() { return offset < declaration.length ? { value: declaration.item(offset++), done: false } : { done: true }; }, [Symbol.iterator]() { return this; } };
    }
    get [Symbol.toStringTag]() { return "CSSStyleDeclaration"; }
  }
  function create(element) {
    const target = new CSSStyleDeclaration(element, token);
    if (!properties) properties = new Set(request(target, "properties"));
    const proxy = new Proxy(target, {
      get(target, key, receiver) {
        if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
        if (index(key)) return Number(key) < receiver.length ? receiver.item(key) : undefined;
        return properties.has(key) ? request(receiver, "get", key) : undefined;
      },
      set(target, key, value, receiver) {
        if (index(key) || key === "length" || key === "parentRule") return false;
        if (key === "cssText") { request(receiver, "set", key, string(value)); return true; }
        if (properties.has(key)) { request(receiver, "set", key, value == null ? "" : string(value)); return true; }
        return Reflect.set(target, key, value, receiver);
      },
      has(target, key) { return Reflect.has(target, key) || properties.has(key) || (index(key) && Number(key) < request(target, "get", "length")); },
      ownKeys(target) { return [...new Set([...Array.from({ length: request(target, "get", "length") }, (_, i) => String(i)), ...Reflect.ownKeys(target)])]; },
      getOwnPropertyDescriptor(target, key) {
        if (index(key) && Number(key) < request(target, "get", "length")) return { value: request(target, "item", key), enumerable: true, configurable: true, writable: false };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    receivers.set(proxy, element); return proxy;
  }
  return { create, isNative: value => receivers.has(value), CSSStyleDeclaration };
})();

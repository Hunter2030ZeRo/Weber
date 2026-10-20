globalThis.WeberResize = (() => {
  const observers = new Map(); let next = 1;
  class ResizeObserver {
    constructor(callback) {
      if (typeof callback !== "function") throw new TypeError("Expected ResizeObserver callback");
      this._callback = callback; this._targets = new Set(); this._id = next++; this._epoch = globalThis.WeberDOM.session();
      this._document = globalThis.document;
    }
    _check(target) {
      if (this._epoch !== globalThis.WeberDOM.session()) throw new globalThis.WeberEvents.DOMException("Observer session expired", "InvalidStateError");
      if (!target || target.nodeType !== 1 || target._document !== this._document) throw new TypeError("Expected owned Element"); target._check();
    }
    observe(target, options = {}) {
      this._check(target); const box = String(options?.box ?? "content-box");
      if (!["content-box", "border-box", "device-pixel-content-box"].includes(box)) throw new TypeError("Invalid ResizeObserver box");
      this._targets.add(target); observers.set(this._id, this); globalThis.WeberDOM.schedule({ op: "resizeobserve", observer: this._id, node: target._id, box });
    }
    unobserve(target) { this._check(target); this._targets.delete(target); globalThis.WeberDOM.schedule({ op: "resizeunobserve", observer: this._id, node: target._id }); if (!this._targets.size) this.disconnect(); }
    disconnect() {
      this._targets.clear();
      observers.delete(this._id);
      if (this._epoch === globalThis.WeberDOM.session()) globalThis.WeberDOM.schedule({ op: "resizedisconnect", observer: this._id });
    }
  }
  function run(message) {
    const observer = observers.get(message.observer);
    if (!observer || message.epoch !== globalThis.WeberDOM.session() || observer._epoch !== message.epoch) return;
    const entries = message.entries.map(entry => ({ ...entry, target: observer._document._nodes.get(entry.target), contentRect: globalThis.DOMRectReadOnly.fromRect(entry.contentRect) })).filter(entry => observer._targets.has(entry.target));
    if (!entries.length) return;
    try { observer._callback.call(observer, entries, observer); }
    catch (error) { observer._document.listenerErrors.push(String(error)); }
  }
  return { ResizeObserver, run, get activeCount() { return observers.size; }, reset() { observers.clear(); } };
})();

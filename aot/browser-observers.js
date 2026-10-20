globalThis.WeberObservers = (() => {
  const pending = new Set();
  let queued = false;
  function schedule(observer) {
    pending.add(observer);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const observers = [...pending]; pending.clear();
      for (const observer of observers) observer._deliver();
    });
  }
  class MutationObserver {
    constructor(callback) {
      if (typeof callback !== "function") throw new TypeError("Expected observer callback");
      this._callback = callback; this._registrations = new Map(); this._records = [];
      this._transients = [];
    }
    observe(target, options = {}) {
      if (!target?._document || !target._check) throw new TypeError("Expected Node");
      target._check(); options = { ...options };
      if (options.attributes === undefined && (options.attributeOldValue !== undefined || options.attributeFilter !== undefined)) options.attributes = true;
      if (options.characterData === undefined && options.characterDataOldValue !== undefined) options.characterData = true;
      if (!(options.attributes || options.childList || options.characterData) ||
          (!options.attributes && (options.attributeOldValue || options.attributeFilter)) ||
          (!options.characterData && options.characterDataOldValue)) throw new TypeError("Invalid observation options");
      if (options.attributeFilter) options.attributeFilter = Array.from(options.attributeFilter, String);
      this._transients = this._transients.filter(entry => entry.target !== target);
      this._registrations.set(target, options); target._document._observers.add(this);
    }
    takeRecords() { const records = this._records; this._records = []; return records; }
    disconnect() {
      for (const target of this._registrations.keys()) target._document._observers.delete(this);
      this._registrations.clear(); this._records = []; this._transients = [];
    }
    _queue(record) {
      let interested = false; let oldValue = false; let cleanup = false;
      for (const [target, options] of this._registrations) {
        if (record.target !== target && !(options.subtree && (target.contains(record.target) || this._transients.some(entry => entry.target === target && entry.node.contains(record.target))))) continue;
        if (record.type === "childList" && options.subtree) {
          for (const node of record.removedNodes) this._transients.push({ target, node });
          cleanup ||= record.removedNodes.length > 0;
        }
        if (record.suppressed || !options[record.type] || (record.type === "attributes" && options.attributeFilter && (record.attributeNamespace != null || !options.attributeFilter.includes(record.attributeName)))) continue;
        interested = true;
        oldValue ||= record.type === "attributes" ? Boolean(options.attributeOldValue) : Boolean(options.characterDataOldValue);
      }
      if (interested) this._records.push({ type: record.type, target: record.target,
        addedNodes: globalThis.WeberCollections.create(() => record.addedNodes ?? []), removedNodes: globalThis.WeberCollections.create(() => record.removedNodes ?? []),
        previousSibling: record.previousSibling ?? null, nextSibling: record.nextSibling ?? null,
        attributeName: record.attributeName ?? null, attributeNamespace: record.attributeNamespace ?? null,
        oldValue: oldValue ? record.oldValue : null });
      if (!interested && !cleanup) return;
      schedule(this);
    }
    _deliver() {
      this._transients = [];
      const records = this.takeRecords().filter(record => record.target._document._epoch === globalThis.WeberDOM.session());
      if (records.length) {
        try { this._callback(records, this); }
        catch (error) { records[0].target._document.listenerErrors.push(String(error)); }
      }
    }
  }
  function notify(document, record) {
    if (document._suppressMutations) return;
    for (const observer of document._observers) observer._queue(record);
  }
  return { MutationObserver, notify };
})();

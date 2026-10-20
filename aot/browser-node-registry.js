// Identity lookup must not own detached nodes. Native handles are released only
// after the AOT wrapper becomes unreachable, so retained nodes can be reinserted.
globalThis.WeberNodeRegistry = class NodeRegistry {
  constructor(document) {
    if (typeof WeakRef !== "function" || typeof FinalizationRegistry !== "function") throw new Error("Native weak references are required for DOM ownership");
    this._document = document; this._entries = new Map();
    this._finalizers = new FinalizationRegistry(id => this._release(id));
  }
  set(id, node) { this._entries.set(id, new WeakRef(node)); if (id !== 0) this._finalizers.register(node, id, node); return this; }
  get(id) { return this._entries.get(id)?.deref(); }
  get size() { return this._entries.size; }
  _release(id) {
    if (!this._entries.delete(id)) return;
    if (this._document._epoch === globalThis.WeberDOM.session()) globalThis.WeberDOM.release(id);
  }
  sweep() { for (const [id, reference] of this._entries) if (id !== 0 && !reference.deref()) this._release(id); }
  clear() { this._entries.clear(); }
};

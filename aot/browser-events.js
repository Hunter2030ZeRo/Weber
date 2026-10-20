// Synchronous EventTarget semantics inside the AOT realm.
globalThis.WeberEvents = (() => {
  class DOMException extends Error {
    constructor(message = "", name = "Error") { super(String(message)); this.name = String(name); }
    get code() { return { IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11, SyntaxError: 12, NamespaceError: 14, SecurityError: 18, AbortError: 20, TimeoutError: 23 }[this.name] ?? 0; }
  }
  class Event {
    constructor(type, options = {}) {
      if (!arguments.length) throw new TypeError("Event type required");
      options = options ?? {};
      if (typeof options !== "object" && typeof options !== "function") throw new TypeError("Expected event dictionary");
      this.type = String(type); this.bubbles = Boolean(options.bubbles);
      this.cancelable = Boolean(options.cancelable); this.defaultPrevented = false;
      this.target = null; this.currentTarget = null; this.eventPhase = 0;
      this.isTrusted = false; this._dispatching = false; this._stop = false;
      this._immediate = false; this._passive = false;
      this.composed = Boolean(options.composed); this._path = [];
      this.timeStamp = globalThis.WeberScheduler ? Math.max(0.001, globalThis.performance?.now() ?? globalThis.weberMonotonicNow()) : Date.now();
      this._initialized = true;
    }
    get srcElement() { return this.target; }
    initEvent(type, bubbles = false, cancelable = false) {
      if (!arguments.length) throw new TypeError("Event type required");
      type = String(type); bubbles = Boolean(bubbles); cancelable = Boolean(cancelable);
      if (this._dispatching) return;
      this.type = type; this.bubbles = bubbles; this.cancelable = cancelable; this.target = null;
      this.defaultPrevented = false; this._stop = false; this._immediate = false; this.isTrusted = false; this._initialized = true;
    }
    preventDefault() { if (this.cancelable && !this._passive) this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._immediate = true; }
    get cancelBubble() { return this._stop; } set cancelBubble(value) { if (value) this.stopPropagation(); }
    get returnValue() { return !this.defaultPrevented; } set returnValue(value) { if (!value) this.preventDefault(); }
    composedPath() { return this._dispatching ? [...this._path] : []; }
  }
  class EventTarget {
    constructor() { this._listeners = []; }
    addEventListener(type, callback, options = {}) {
      options = options ?? {};
      const capture = typeof options === "boolean" ? options : Boolean(options.capture);
      const once = Boolean(options.once), passive = Boolean(options.passive), signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Expected AbortSignal");
      if (callback == null || signal?.aborted) return;
      if (typeof callback !== "object" && typeof callback !== "function") throw new TypeError("Expected callback object");
      type = String(type);
      if (this._listeners.some(entry => !entry.removed && entry.type === type && entry.callback === callback && entry.capture === capture)) return;
      const entry = { type, callback, capture, once, passive, removed: false, signal };
      if (signal) { entry.abort = () => this._removeListener(entry); signal._algorithms.add(entry.abort); }
      this._listeners.push(entry);
      if (this._document) this._document._listen(type);
    }
    removeEventListener(type, callback, options = {}) {
      options = options ?? {};
      const capture = typeof options === "boolean" ? options : Boolean(options.capture);
      for (const entry of this._listeners) {
        if (entry.type === String(type) && entry.callback === callback && entry.capture === capture) this._removeListener(entry);
      }
      this._listeners = this._listeners.filter(entry => !entry.removed);
    }
    _removeListener(entry) {
      entry.removed = true; entry.signal?._algorithms.delete(entry.abort);
      this._listeners = this._listeners.filter(item => item !== entry);
    }
    dispatchEvent(event) {
      if (!(event instanceof Event)) throw new TypeError("Expected Event");
      if (event._dispatching || !event._initialized) throw new DOMException("Event is not dispatchable", "InvalidStateError");
      const path = []; for (let node = this.parentNode; node; node = node.parentNode) path.push(node);
      event._dispatching = true; event.target = this; event._path = [this, ...path];
      event._stop = false; event._immediate = false;
      const invoke = (target, capture, phase) => {
        Object.defineProperty(event, "currentTarget", { value: target, writable: true, configurable: true }); event.eventPhase = phase;
        for (const entry of [...target._listeners]) {
          if (entry.removed || entry.type !== event.type || entry.capture !== capture) continue;
          if (entry.once) target.removeEventListener(entry.type, entry.callback, entry.capture);
          event._passive = entry.passive;
          try {
            if (typeof entry.callback === "function") entry.callback.call(target, event);
            else entry.callback.handleEvent(event);
          } catch (error) {
            const document = target._document;
            if (document) document.listenerErrors.push(String(error));
            else this.listenerError = String(error);
          }
          event._passive = false;
          if (event._immediate) break;
        }
      };
      try {
        for (const target of [...path].reverse()) { if (event._stop) break; invoke(target, true, 1); }
        if (!event._stop) { invoke(this, true, 2); if (!event._immediate) invoke(this, false, 2); }
        if (event.bubbles) for (const target of path) { if (event._stop) break; invoke(target, false, 3); }
      } finally {
        event._nativeDecision = { defaultPrevented: event.defaultPrevented, stopPropagation: event._stop, stopImmediatePropagation: event._immediate };
        Object.defineProperty(event, "currentTarget", { value: null, writable: true, configurable: true }); event.eventPhase = 0; event._dispatching = false;
        event._stop = false; event._immediate = false;
      }
      return !event.defaultPrevented;
    }
  }
  class CustomEvent extends Event {
    constructor(type, options = {}) { if (!arguments.length) throw new TypeError("Event type required"); super(type, options); this.detail = options?.detail === undefined ? null : options.detail; }
    initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
      if (!arguments.length) throw new TypeError("Event type required");
      if (this._dispatching) return;
      this.initEvent(type, bubbles, cancelable); this.detail = detail;
    }
  }
  const signalKey = {};
  class AbortSignal extends EventTarget {
    constructor(key) { if (key !== signalKey) throw new TypeError("Illegal constructor"); super(); this._aborted = false; this._reason = undefined; this._algorithms = new Set(); this._onabort = null; }
    get aborted() { return this._aborted; }
    get reason() { return this._reason; }
    throwIfAborted() { if (this._aborted) throw this._reason; }
    get onabort() { return this._onabort; }
    set onabort(callback) {
      if (typeof callback !== "function") callback = null;
      this._onabort = callback;
      if (callback && !this._abortHandler) { this._abortHandler = event => this._onabort?.call(this, event); this.addEventListener("abort", this._abortHandler); }
      else if (!callback && this._abortHandler) { this.removeEventListener("abort", this._abortHandler); this._abortHandler = null; }
    }
    _abort(reason) {
      if (this._aborted) return;
      this._aborted = true; this._reason = reason === undefined ? new DOMException("The operation was aborted", "AbortError") : reason;
      for (const algorithm of this._algorithms) algorithm();
      this._algorithms.clear(); this.dispatchEvent(new Event("abort"));
    }
    static abort(reason) { const signal = new AbortSignal(signalKey); signal._aborted = true; signal._reason = reason === undefined ? new DOMException("The operation was aborted", "AbortError") : reason; return signal; }
  }
  class AbortController {
    constructor() { this._signal = new AbortSignal(signalKey); }
    get signal() { return this._signal; }
    abort(reason) { this._signal._abort(reason); }
  }
  class UIEvent extends Event {
    constructor(type, options = {}) {
      if (!arguments.length) throw new TypeError("Event type required"); super(type, options);
      this.detail = Number(options?.detail ?? 0) | 0; this.view = options?.view ?? null;
    }
  }
  const modifiers = (event, options) => { for (const key of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) event[key] = Boolean(options?.[key]); };
  const modifierState = function(key) { return Boolean({ Alt: this.altKey, Control: this.ctrlKey, Meta: this.metaKey, Shift: this.shiftKey }[String(key)]); };
  class MouseEvent extends UIEvent {
    constructor(type, options = {}) {
      if (!arguments.length) throw new TypeError("Event type required"); super(type, options);
      for (const key of ["screenX", "screenY", "clientX", "clientY", "button", "buttons"]) this[key] = Number(options?.[key] ?? 0) | 0;
      modifiers(this, options); this.relatedTarget = options?.relatedTarget ?? null;
    }
    get x() { return this.clientX; } get y() { return this.clientY; }
    getModifierState(key) { return modifierState.call(this, key); }
  }
  class KeyboardEvent extends UIEvent {
    constructor(type, options = {}) {
      if (!arguments.length) throw new TypeError("Event type required"); super(type, options);
      this.key = String(options?.key ?? ""); this.code = String(options?.code ?? ""); this.location = Number(options?.location ?? 0) >>> 0;
      this.repeat = Boolean(options?.repeat); this.isComposing = Boolean(options?.isComposing); modifiers(this, options);
      this.keyCode = Number(options?.keyCode ?? 0) >>> 0; this.charCode = Number(options?.charCode ?? 0) >>> 0;
    }
    get which() { return this.keyCode; }
    getModifierState(key) { return modifierState.call(this, key); }
  }
  class InputEvent extends UIEvent {
    constructor(type, options = {}) {
      if (!arguments.length) throw new TypeError("Event type required"); super(type, options);
      this.data = options?.data == null ? null : String(options.data); this.inputType = String(options?.inputType ?? "");
      this.isComposing = Boolean(options?.isComposing); this.dataTransfer = null;
    }
    getTargetRanges() { return []; }
  }
  class CompositionEvent extends UIEvent {
    constructor(type, options = {}) { if (!arguments.length) throw new TypeError("Event type required"); super(type, options); this.data = String(options?.data ?? ""); }
  }
  Object.assign(Event, { NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 });
  Object.assign(Event.prototype, { NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 });
  return { Event, CustomEvent, EventTarget, DOMException, AbortSignal, AbortController, UIEvent, MouseEvent, KeyboardEvent, InputEvent, CompositionEvent };
})();

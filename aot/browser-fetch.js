// Text/JSON fetch profile. The actual HTTP/CORS/redirect/cancellation work is
// performed by Servo fetch. AOT owns promises, headers and text body consumption.
globalThis.WeberFetch = (() => {
  const pending = new Map(); let next = 1;
  const token = value => { value = String(value); if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) throw new TypeError("Invalid HTTP token"); return value; };
  const headerName = value => token(value).toLowerCase();
  const headerValue = value => { value = String(value).replace(/^[\t ]+|[\t ]+$/g, ""); if (/[\r\n\0]/.test(value)) throw new TypeError("Invalid header value"); return value; };
  class Headers {
    constructor(init = undefined) {
      this._entries = new Map(); this._immutable = false;
      if (init != null) {
        if (typeof init[Symbol.iterator] === "function") for (const entry of init) { const pair = Array.from(entry); if (pair.length !== 2) throw new TypeError("Expected header pair"); this.append(pair[0], pair[1]); }
        else for (const key of Object.keys(init)) this.append(key, init[key]);
      }
    }
    _check() { if (this._immutable) throw new TypeError("Immutable response headers"); }
    append(name, value) { this._check(); name = headerName(name); value = headerValue(value); this._entries.set(name, this._entries.has(name) ? this._entries.get(name) + ", " + value : value); }
    set(name, value) { this._check(); this._entries.set(headerName(name), headerValue(value)); }
    delete(name) { this._check(); this._entries.delete(headerName(name)); }
    get(name) { return this._entries.get(headerName(name)) ?? null; }
    has(name) { return this._entries.has(headerName(name)); }
    *entries() { for (const pair of [...this._entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) yield pair; }
    *keys() { for (const [key] of this.entries()) yield key; }
    *values() { for (const [, value] of this.entries()) yield value; }
    forEach(callback, thisArg) { for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this); }
    [Symbol.iterator]() { return this.entries(); }
  }
  class Response {
    constructor(body = null, init = {}) {
      const status = Number(init.status ?? 200) >>> 0;
      if (status < 200 || status > 599) throw new RangeError("Invalid response status");
      if (body !== null && [204, 205, 304].includes(status)) throw new TypeError("Null-body status");
      this.status = status; this.statusText = String(init.statusText ?? ""); this.headers = new Headers(init.headers);
      this._body = body === null ? null : String(body); this.bodyUsed = false; this.url = ""; this.redirected = false; this.type = "default";
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    text() {
      if (this.bodyUsed) return Promise.reject(new TypeError("Body already consumed"));
      if (this._body !== null) this.bodyUsed = true;
      return Promise.resolve(this._body ?? "");
    }
    json() { return this.text().then(value => JSON.parse(value)); }
    clone() {
      if (this.bodyUsed) throw new TypeError("Body already consumed");
      const clone = Object.create(Response.prototype); Object.assign(clone, this); clone.headers = new Headers(this.headers); clone.headers._immutable = this.headers._immutable; return clone;
    }
  }
  function release(handle) {
    const entry = pending.get(handle); if (!entry) return;
    pending.delete(handle); entry.signal?._algorithms.delete(entry.abort); return entry;
  }
  function fetch(input, init = {}) {
    return new Promise((resolve, reject) => {
      if (typeof input !== "string") throw new TypeError("This fetch profile requires a string URL");
      init = init ?? {};
      const signal = init.signal;
      if (signal != null && !(signal instanceof globalThis.WeberEvents.AbortSignal)) throw new TypeError("Expected AbortSignal");
      if (signal?.aborted) { reject(signal.reason); return; }
      const method = token(init.method ?? "GET").toUpperCase(), headers = new Headers(init.headers);
      if (["CONNECT", "TRACE", "TRACK"].includes(method)) throw new TypeError("Forbidden HTTP method");
      if (init.body != null && typeof init.body !== "string") throw new TypeError("This fetch profile requires a string body");
      if (init.body != null && ["GET", "HEAD"].includes(method)) throw new TypeError("GET/HEAD cannot have a body");
      const epoch = globalThis.WeberDOM.session(); if (!epoch) throw new TypeError("No document session");
      if (next > 0xffffffff) throw new RangeError("Fetch handle space exhausted");
      const handle = next++;
      const abort = () => { if (!release(handle)) return; globalThis.WeberDOM.schedule({ op: "fetchabort", handle }); reject(signal.reason); };
      pending.set(handle, { resolve, reject, signal, abort, epoch }); signal?._algorithms.add(abort);
      globalThis.WeberDOM.schedule({ op: "fetchstart", handle, url: input, method, headers: [...headers], body: init.body ?? null });
    });
  }
  function run(message) {
    const entry = pending.get(message.handle);
    if (!entry || entry.epoch !== message.epoch || message.epoch !== globalThis.WeberDOM.session()) return;
    release(message.handle);
    if (message.error) { entry.reject(new TypeError(message.error)); return; }
    const data = message.response, response = Object.create(Response.prototype);
    Object.assign(response, { status: data.status, statusText: data.statusText, headers: new Headers(data.headers), _body: data.body, bodyUsed: false, url: data.url, redirected: data.redirected, type: data.type });
    response.headers._immutable = true; entry.resolve(response);
  }
  function reset() {
    for (const handle of [...pending.keys()]) release(handle).reject(new globalThis.WeberEvents.DOMException("Document session disposed", "AbortError"));
  }
  return { fetch, Headers, Response, run, reset, get pendingCount() { return pending.size; } };
})();

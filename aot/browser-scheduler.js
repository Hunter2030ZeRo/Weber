globalThis.WeberScheduler = (() => {
  const tasks = new Map();
  let next = 1;
  let baseNative = globalThis.weberMonotonicNow();
  let baseDocument = 0;
  let timeOrigin = Date.now();
  let lastNow = 0;
  const now = () => lastNow = Math.max(lastNow, baseDocument + globalThis.weberMonotonicNow() - baseNative);
  function bindClock(clock) {
    if (!clock) return;
    if (!Number.isFinite(clock.now) || !Number.isFinite(clock.origin)) throw new TypeError("Invalid document clock");
    baseNative = globalThis.weberMonotonicNow(); baseDocument = clock.now; timeOrigin = clock.origin;
  }
  function schedule(kind, callback, delay, args) {
    if (typeof callback !== "function") throw new TypeError("AOT scheduling requires a compiled function");
    if (!globalThis.WeberDOM.session()) throw new Error("Cannot schedule outside a document session");
    if (next > 0xffffffff) throw new RangeError("Scheduler handle space exhausted");
    const handle = next++;
    tasks.set(handle, { kind, callback, args, epoch: globalThis.WeberDOM.session(), document: globalThis.document });
    globalThis.WeberDOM.schedule({ op: "schedule", kind, handle, delay: Math.max(0, Number(delay) >> 0) });
    return handle;
  }
  function cancel(handle, frame = false) {
    handle = Number(handle) >>> 0;
    const task = tasks.get(handle);
    if (!task || (task.kind === "frame") !== frame) return;
    tasks.delete(handle); globalThis.WeberDOM.schedule({ op: "cancel", handle });
  }
  function run(message) {
    const task = tasks.get(message.handle);
    if (!task || task.epoch !== message.epoch || message.epoch !== globalThis.WeberDOM.session()) return;
    if (task.kind !== "interval") tasks.delete(message.handle);
    try { task.callback.apply(globalThis, task.kind === "frame" ? [message.timestamp] : task.args); }
    catch (error) { task.document?.listenerErrors.push(String(error)); }
  }
  function install() {
    Object.assign(globalThis, {
      setTimeout: (callback, delay = 0, ...args) => schedule("timeout", callback, delay, args),
      setInterval: (callback, delay = 0, ...args) => schedule("interval", callback, delay, args),
      clearTimeout: handle => cancel(handle), clearInterval: handle => cancel(handle),
      requestAnimationFrame: callback => schedule("frame", callback, 0, []),
      cancelAnimationFrame: handle => cancel(handle, true),
      performance: { now, get timeOrigin() { return timeOrigin; } },
    });
  }
  return { install, run, bindClock, reset() { tasks.clear(); lastNow = 0; } };
})();

(() => {
  if (window.__weberDom) return;
  const root = document.getElementById("aot-dom-root");
  if (!root) throw new Error("DOM binding root missing");
  const ids = new WeakMap();
  class Handles extends Map {
    set(id, node) { ids.set(node, id); return super.set(id, node); }
    delete(id) { const node = this.get(id); if (node) ids.delete(node); return super.delete(id); }
    clear() { for (const node of this.values()) ids.delete(node); super.clear(); }
  }
  const nodes = new Handles([[0, root]]);
  const listeners = new Map();
  const tasks = new Map();
  const resizeObservers = new Map();
  const requests = new Map();
  let checkpointEpoch = null;
  window.addEventListener("weber:backend-events", event => { if (epoch) window.__weberDom.request("backend-events", event.detail); });
  window.addEventListener("weber:window-state", event => { if (epoch) window.__weberDom.request("window-state", event.detail); });
  let epoch = 0;
  let inFlight = false;
  let queue = [];
  let queryActive = false;
  function pump() {
    if (inFlight || !queue.length) return;
    inFlight = true;
    location.href = "weber://dom-event?event=" + encodeURIComponent(JSON.stringify(queue.shift()));
  }
  function clear() {
    for (const observer of resizeObservers.values()) observer.disconnect(); resizeObservers.clear();
    for (const request of requests.values()) request.abort(); requests.clear();
    for (const task of tasks.values()) {
      if (task.kind === "frame") window.cancelAnimationFrame(task.native);
      else window.clearTimeout(task.native);
    }
    tasks.clear(); checkpointEpoch = null;
    for (const binding of listeners.values()) binding.node.removeEventListener(binding.event, binding.callback, binding.capture);
    listeners.clear(); nodes.clear(); nodes.set(0, root);
    root.replaceChildren(); queue = [];
  }
  function node(id) {
    const result = nodes.get(id);
    if (!result) throw new Error("stale Servo DOM handle: " + id);
    return result;
  }
  const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });
  function query(raw, binary = false) {
    const pack = value => binary ? WeberWire.encode(value) : JSON.stringify(value);
    if (queryActive) return pack({ ok: false, error: { name: "InvalidStateError", message: "Nested DOM query" } });
    queryActive = true;
    try {
      const request = binary ? WeberWire.decode(raw) : JSON.parse(raw);
      if (!window.__weberDom.apply(request.commands) || request.epoch !== epoch) throw new DOMException("Stale query session", "InvalidStateError");
      const target = request.node === null ? window : node(request.node), args = request.args;
      let value;
      switch (request.kind) {
        case "rect": value = rect(target.getBoundingClientRect()); break;
        case "rects": value = Array.from(target.getClientRects(), rect); break;
        case "computed": value = getComputedStyle(target, args.pseudo).getPropertyValue(args.name); break;
        case "computedNames": { const style = getComputedStyle(target); value = Array.from({ length: style.length }, (_, index) => style.item(index)); break; }
        case "metrics": value = Object.fromEntries(["clientWidth", "clientHeight", "clientTop", "clientLeft", "scrollWidth", "scrollHeight", "scrollTop", "scrollLeft"].map(name => [name, target[name]])); break;
        case "viewport": value = Object.fromEntries(["innerWidth", "innerHeight", "scrollX", "scrollY", "pageXOffset", "pageYOffset", "devicePixelRatio"].map(name => [name, window[name]])); break;
        case "scroll": {
          const options = { behavior: args.behavior ?? "auto" };
          if (args.x !== null && args.x !== undefined) options.left = args.x;
          if (args.y !== null && args.y !== undefined) options.top = args.y;
          if (args.relative) target.scrollBy(options); else target.scrollTo(options);
          value = null; break;
        }
        case "focus": target.focus({ preventScroll: Boolean(args.preventScroll) }); value = null; break;
        case "blur": target.blur(); value = null; break;
        case "active": value = ids.get(document.activeElement) ?? null; break;
        case "selectors": {
          if (args.op === "matches") value = target.matches(args.name);
          else if (args.op === "query") value = Array.from(target.querySelectorAll(args.name), result => {
            const id = ids.get(result);
            if (id === undefined) throw new DOMException("Unmanaged selector result", "NotSupportedError");
            return id;
          });
          else throw new TypeError("Unknown selector operation");
          break;
        }
        case "node": {
          if (!["textContent", "value", "checked"].includes(args.name)) throw new TypeError("Unknown node read");
          value = target[args.name] ?? (args.name === "checked" ? false : ""); break;
        }
        case "style": {
          if (!(target instanceof Element)) throw new TypeError("Style target must be an Element");
          const style = target.style;
          if (args.op === "properties") { value = { defined: true, value: Object.getOwnPropertyNames(Object.getPrototypeOf(style)) }; break; }
          const write = ["set", "setProperty", "removeProperty"].includes(args.op);
          const observer = write ? new MutationObserver(() => {}) : null;
          observer?.observe(target, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
          let result, mutations;
          try {
            switch (args.op) {
              case "get": result = style[args.name]; break;
              case "set": style[args.name] = args.value; break;
              case "item": result = style.item(Number(args.name)); break;
              case "value": result = style.getPropertyValue(args.name); break;
              case "priority": result = style.getPropertyPriority(args.name); break;
              case "setProperty": style.setProperty(args.name, args.value, args.priority); break;
              case "removeProperty": result = style.removeProperty(args.name); break;
              default: throw new TypeError("Unknown CSSOM operation");
            }
            if (write) mutations = observer.takeRecords().map(record => record.oldValue);
          } finally { observer?.disconnect(); }
          if (result !== undefined && result !== null && !["string", "number", "boolean"].includes(typeof result)) throw new TypeError("Unsupported CSSOM result");
          value = { defined: result !== undefined, value: result ?? null, ...(write ? { attribute: target.getAttribute("style"), mutations } : {}) }; break;
        }
        default: throw new TypeError("Unknown live DOM query");
      }
      return pack({ ok: true, value });
    } catch (error) { return pack({ ok: false, error: { name: error.name, message: error.message } }); }
    finally { queryActive = false; }
  }
  window.__weberDom = {
    call(action, event) {
      return this.request(action, event).decision;
    },
    request(action, event) {
      if (queryActive) throw new Error("Nested host call during DOM query");
      const now = performance.now();
      const raw = window.weberHostBytes(WeberWire.encode({ action, event, clock: { now, origin: performance.timeOrigin ?? Date.now() - now } }), bytes => query(bytes, true));
      if (raw === null) throw new Error("Synchronous Hermes call rejected");
      const reply = WeberWire.decode(raw);
      if (!this.apply(reply.commands)) throw new Error("Servo rejected native DOM commands");
      return reply;
    },
    checkpoint() {
      if (!epoch || checkpointEpoch === epoch) return;
      const scheduledEpoch = epoch; checkpointEpoch = epoch;
      queueMicrotask(() => {
        if (checkpointEpoch === scheduledEpoch) checkpointEpoch = null;
        if (scheduledEpoch === epoch) this.call("checkpoint");
      });
    },
    snapshot() { return { epoch, nodes: nodes.size, listeners: [...listeners.keys()], tasks: tasks.size, resizeObservers: resizeObservers.size, requests: requests.size }; },
    fail(message) {
      inFlight = false;
      window.dispatchEvent(new CustomEvent("weber:dom-error", { detail: message }));
      pump();
    },
    apply(commands) {
      try {
        for (const command of commands) {
          switch (command.op) {
            case "title": document.title = command.value; break;
            case "release": {
              const target = nodes.get(command.node);
              if (target?.isConnected) throw new Error("Cannot release a connected DOM handle");
              for (const [id, binding] of listeners) if (binding.node === target) {
                binding.node.removeEventListener(binding.event, binding.callback, binding.capture); listeners.delete(id);
              }
              nodes.delete(command.node); break;
            }
            case "reset": clear(); epoch = command.epoch; break;
            case "create":
              if (nodes.has(command.node)) throw new Error("duplicate DOM handle");
              if (command.inert && command.tag === "script") {
                const template = document.createElement("template"); template.innerHTML = "<script></script>";
                nodes.set(command.node, template.content.firstChild);
              } else nodes.set(command.node, document.createElementNS(command.namespace, command.tag)); break;
            case "clone": {
              const cloned = node(command.source).cloneNode(command.deep), entries = [];
              const walk = target => {
                entries.push(target);
                if (target instanceof HTMLTemplateElement) walk(target.content);
                for (const child of target.childNodes) walk(child);
              };
              walk(cloned);
              if (entries.length !== command.handles.length) throw new Error("Native clone topology differs from wrapper ownership");
              const unique = new Set();
              for (let index = 0; index < entries.length; index++) {
                const handle = command.handles[index], target = entries[index];
                if (nodes.has(handle.node) || unique.has(handle.node) || target.nodeType !== handle.type || target.nodeName !== handle.name) throw new Error("Invalid native clone handle mapping");
                unique.add(handle.node);
              }
              for (let index = 0; index < entries.length; index++) nodes.set(command.handles[index].node, entries[index]);
              break;
            }
            case "append": node(command.parent).appendChild(node(command.node)); break;
            case "createtext": nodes.set(command.node, document.createTextNode(command.value)); break;
            case "createcomment": nodes.set(command.node, document.createComment(command.value)); break;
            case "createinstruction": nodes.set(command.node, document.createProcessingInstruction(command.target, command.value)); break;
            case "createfragment": nodes.set(command.node, command.template === null || command.template === undefined ? document.createDocumentFragment() : node(command.template).content); break;
            case "insert": node(command.parent).insertBefore(node(command.node), command.before === null ? null : node(command.before)); break;
            case "detach": { const target = node(command.node); if (target.parentNode) target.parentNode.removeChild(target); break; }
            case "removeattribute": node(command.node).removeAttribute(command.name); break;
            case "property": {
              const target = node(command.node), value = command.name === "value" ? command.value : command.value === "true";
              if (target[command.name] !== value) target[command.name] = value;
              break;
            }
            case "text": node(command.node).textContent = command.value; break;
            case "attribute": node(command.node).setAttribute(command.name, command.value); break;
            case "attributens": node(command.node).setAttributeNS(command.namespace, command.name, command.value); break;
            case "removeattributens": node(command.node).removeAttributeNS(command.namespace, command.name); break;
            case "listen": {
              const target = node(command.node);
              const capturedEpoch = epoch;
              const callback = event => {
                const target = ids.get(event.target) ?? null;
                const message = { epoch: capturedEpoch, listener: command.listener,
                  target,
                  value: event.target instanceof HTMLInputElement ? event.target.value : "",
                  checked: event.target instanceof HTMLInputElement ? event.target.checked : null,
                  bubbles: event.bubbles, cancelable: event.cancelable, default_prevented: event.defaultPrevented };
                const modifiers = Object.fromEntries(["altKey", "ctrlKey", "metaKey", "shiftKey"].map(key => [key, Boolean(event[key])]));
                if (event instanceof MouseEvent) message.ui = { kind: "mouse", ...modifiers,
                  ...Object.fromEntries(["screenX", "screenY", "clientX", "clientY", "button", "buttons", "detail"].map(key => [key, event[key]])), relatedTarget: ids.get(event.relatedTarget) ?? null };
                else if (event instanceof KeyboardEvent) message.ui = { kind: "keyboard", ...modifiers,
                  ...Object.fromEntries(["key", "code", "location", "repeat", "isComposing", "keyCode", "charCode"].map(key => [key, event[key]])) };
                else if (event instanceof InputEvent) message.ui = { kind: "input", data: event.data, inputType: event.inputType, isComposing: event.isComposing };
                else if (typeof CompositionEvent === "function" && event instanceof CompositionEvent) message.ui = { kind: "composition", data: event.data };
                if (window.weberHostCall && command.node === 0) {
                  const decision = window.__weberDom.call("event", message);
                  if (decision.defaultPrevented) event.preventDefault();
                  if (decision.stopImmediatePropagation) event.stopImmediatePropagation();
                  else if (decision.stopPropagation) event.stopPropagation();
                  window.__weberDom.checkpoint();
                  return;
                }
                queue.push(message);
                pump();
              };
              const capture = command.node === 0;
              target.addEventListener(command.event, callback, capture);
              listeners.set(command.listener, { node: target, event: command.event, callback, capture });
              break;
            }
            case "remove": {
              const target = node(command.node);
              for (const [id, binding] of listeners) {
                if (target.contains(binding.node)) {
                  binding.node.removeEventListener(binding.event, binding.callback, binding.capture);
                  listeners.delete(id);
                }
              }
              for (const [id, element] of nodes) if (target.contains(element)) nodes.delete(id);
              target.remove(); break;
            }
            case "dispose": clear(); epoch = 0; break;
            case "schedule": {
              const capturedEpoch = epoch;
              const callback = timestamp => {
                if (epoch !== capturedEpoch || !tasks.has(command.handle)) return;
                if (command.kind !== "interval") tasks.delete(command.handle);
                window.__weberDom.call("task", { epoch: capturedEpoch, handle: command.handle,
                  timestamp: command.kind === "frame" ? timestamp : performance.now() });
              };
              const native = command.kind === "frame" ? window.requestAnimationFrame(callback)
                : command.kind === "interval" ? window.setInterval(callback, command.delay) : window.setTimeout(callback, command.delay);
              tasks.set(command.handle, { native, kind: command.kind }); break;
            }
            case "cancel": {
              const task = tasks.get(command.handle);
              if (task?.kind === "frame") window.cancelAnimationFrame(task.native);
              else if (task) window.clearTimeout(task.native);
              tasks.delete(command.handle); break;
            }
            case "resizeobserve": {
              let observer = resizeObservers.get(command.observer);
              if (!observer) {
                const capturedEpoch = epoch;
                observer = new ResizeObserver(entries => {
                  if (epoch !== capturedEpoch || resizeObservers.get(command.observer) !== observer) return;
                  const size = values => Array.from(values ?? [], value => ({ inlineSize: value.inlineSize, blockSize: value.blockSize }));
                  const message = { epoch: capturedEpoch, observer: command.observer, entries: entries.map(entry => ({
                    target: ids.get(entry.target) ?? 0,
                    contentRect: rect(entry.contentRect), borderBoxSize: size(entry.borderBoxSize), contentBoxSize: size(entry.contentBoxSize), devicePixelContentBoxSize: size(entry.devicePixelContentBoxSize),
                  })) };
                  window.__weberDom.call("resize", message);
                });
                resizeObservers.set(command.observer, observer);
              }
              observer.observe(node(command.node), { box: command.box }); break;
            }
            case "resizeunobserve": resizeObservers.get(command.observer)?.unobserve(node(command.node)); break;
            case "resizedisconnect": resizeObservers.get(command.observer)?.disconnect(); resizeObservers.delete(command.observer); break;
            case "fetchstart": {
              const capturedEpoch = epoch, controller = new AbortController(); requests.set(command.handle, controller);
              const deliver = message => {
                if (epoch !== capturedEpoch || requests.get(command.handle) !== controller) return;
                if (new TextEncoder().encode(JSON.stringify(message)).length > 60000) message = { error: "Response exceeds this text fetch profile's delivery limit", response: null };
                requests.delete(command.handle); window.__weberDom.call("fetch", { epoch: capturedEpoch, handle: command.handle, ...message });
              };
              fetch(command.url, { method: command.method, headers: command.headers, body: command.body, signal: controller.signal }).then(async response => {
                const body = response.body === null ? null : await response.text();
                deliver({ error: null, response: { status: response.status, statusText: response.statusText, headers: [...response.headers], body, url: response.url, redirected: response.redirected, type: response.type } });
              }, error => deliver({ error: String(error), response: null })).catch(error => deliver({ error: String(error), response: null }));
              break;
            }
            case "fetchabort": requests.get(command.handle)?.abort(); requests.delete(command.handle); break;
            default: throw new Error("unsupported DOM command");
          }
        }
        inFlight = false;
        window.dispatchEvent(new CustomEvent("weber:dom-applied"));
        pump();
        return true;
      } catch (error) { this.fail(String(error)); return false; }
    },
  };
})();

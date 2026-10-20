# Static Hermes DOM binding

The newer [browser-shaped API](browser-dom.md) layers standard object/method
names and detach semantics over this explicit handle API. The legacy destructive
remove operation documented here remains available.

Hermes AOT code now creates and controls a mounted Servo DOM subtree through
`WeberDOM`. This remains a two-engine binding: the application callbacks run as
native AOT code in Hermes; the actual DOM and adapter run in Servo/SpiderMonkey.
There are no shared GC pointers and no change to Servo's script implementation.

## API and mounting contract

The page supplies `<div id="aot-dom-root"></div>`. `weber://dom-start` initializes
a document session, runs the AOT mount function, and applies its command batch.
The example in `aot/logic.js` mounts a section, output, button, input and removal
button. DOM click/input events invoke callbacks held in the Hermes runtime.

The AOT facade in `aot/dom.js` provides:

- `begin()` → document root handle (0) in a new session.
- `createElement(tag)` → opaque numeric node handle.
- `appendChild(parent, child)` → attach an unattached child, rejecting cycles.
- `setText(node, text)` → set leaf text, preserving text rather than parsing HTML.
- `setAttribute(node, name, value)` → set a supported attribute.
- `on(node, event, callback)` → retain a callback and return its listener handle.
- `remove(node)` → remove a subtree and release its node/callback registrations.
- `dispose()` → clear the mounted subtree and all registrations.
- `flush()` → serialize the pending command batch for the native host.

The supported elements are section/div/span/button/input/output/p. Attributes are
id/title/placeholder/type/class. Events are click/input; callbacks receive the
input value as a string (empty for click). This is a small supported DOM subset,
not a browser-compatible `document` implementation. Input property writes, node
queries outside the mount, promises, event propagation control, layout reads,
styles, text nodes, move/reparent and arbitrary event/attribute APIs are not yet
implemented. `setText` rejects nodes with managed children to avoid silently
invalidating their handles.

## Ownership and transport

Node and listener IDs increase monotonically in one Hermes runtime. Each begin
also increments a document epoch. IDs are never reused across resets. The node
registry validates operations; removed node handles throw on use. Callbacks are
rooted by a Hermes Map and released on subtree removal, reset or disposal. Closing
the host destroys the complete runtime. An allowed page navigation invalidates
the binding; the next page must explicitly mount a new session.

The Servo adapter owns the real Element references and event listeners. Removing
a subtree removes its descendants from the adapter registry and detaches their
listeners, including listeners on externally retained detached elements. A page
can only mount into the designated root. External mutations of managed nodes
are outside the current binding contract.

Event messages contain epoch, listener ID and value. Events are queued in Servo
and sent one at a time through denied `weber://dom-event` navigation requests;
each applied command batch acknowledges the previous event. This avoids losing
bursts of events to overlapping location assignments. Rust parses messages and
commands into closed Serde enums with unknown-field rejection. Event payloads
are limited to 8 KiB and command batches to 64 KiB. Tags and attributes are
allowlisted by the Rust protocol. Strings are JSON escaped; text uses textContent.
No HTML interpolation, eval in Hermes or cross-heap object pointer is used.

Errors are surfaced through `weber:dom-error` and native logs. Command application
is asynchronous and is not transactional: a Servo adapter error can follow an
already-applied prefix. The adapter does not implement rollback. This prototype
uses navigation/evaluation as its transport, without a latency or throughput
claim. A production bridge needs a dedicated channel, richer acknowledgements
and defined recovery for external DOM changes.

## Reproduction and evidence

```sh
cargo build --locked
pnpm --dir app run build
target/hermes/bin/shermes -O -exec aot/dom.js aot/dom.test.js
WEBER_DOM_TEST=1 node scripts/wayland-smoke.mjs
```

Cargo combines the DOM facade and app source and compiles them with shermes into
the native object linked into Weber. Both source files are declared build inputs.

Validation on 2026-10-19:

- Native AOT lifecycle tests passed: descendant use after removal, reuse of a
  removed node, cyclic attachment, creation after disposal, double disposal.
- Real Wayland run with DISPLAY unset passed: element creation, attributes, text,
  click callback and input callback, subtree deletion, stale listener rejection,
  epoch rejection after reset, document disposal and clean native exit.
- Unicode, backslash and quotes survived the round trip; HTML-looking text
  remained a text node rather than creating markup.
- Five consecutive DOM clicks were queued and delivered without losing a
  callback; the AOT-owned button count advanced from 1 to 6.
- The Wayland test uses programmatic DOM events, not physical input injection.
- TypeScript/Vite build and host Clippy with `-D warnings` passed. Existing
  upstream Servo/Hermes warnings remain in logs.

[Machine-readable Wayland result](../artifacts/dom-binding.json) ·
[Rendered AOT-created controls](../artifacts/dom-binding.png)

Hermes native libraries and the CXX boundary have not received Miri/sanitizer or
stress/GC profiling proof in this work. A framework-level SolidJS renderer inside
Hermes and full browser DOM compatibility remain beyond this subset.

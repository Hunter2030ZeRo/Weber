# Browser platform extension — 2026-10-19

This records the earlier 20-case increment. Synchronous cancellation, HTML parsing,
live collections and an actual Solid AOT application have since been implemented
and tested; see [current implementation and remaining limits](native-solid.md).
The remaining-work list below is historical for that earlier increment.

This increment compiles selector matching, inline CSS and MutationObserver support
into Static Hermes native code, with the existing Servo/SpiderMonkey DOM bridge.
It does not replace Servo's JavaScript engine. The current default application
and shell execute as native Hermes AOT; SpiderMonkey still owns the Servo DOM
adapter and the explicit web comparison. See [the current SDK](framework.md).

## Build and runtime

`app/platform.mjs` lazily bundles css-select 7.0.0, parse5 7.3.0 and a cssstyle 6.2.0
standalone fallback. Real-view inline styles use Servo's CSSOM. The esbuild 0.25.12
browser bundle has no runtime Node requirement. Cargo compiles it into exported
`weber_platform`, and the application/DOM sources into exported `weber_logic`.
Both native objects are linked into the Rust host. JSI initializes these two units
inside each persistent Hermes runtime; no Hermes runtime source evaluation is
used. A byte-identical platform bundle reuses its compiled object.

Both compilations pass `-Xes6-block-scoping`, and the runtime enables
`withES6BlockScoping(true)`. The pinned Static Hermes revision defaults this
feature off. Without it, closures generated for module export getters captured
the final loop variable and the CSSStyleDeclaration export became the wrong
value. A shared regression checks per-iteration let bindings and export getters.
This was a compiler/runtime configuration correction, not an upstream compiler
fix. The platform object's C compilation currently uses `-Wc,-O0` to keep this
development build practical; release optimization and performance remain open.

Native `queueMicrotask` calls JSI's actual microtask queue. Every DOM entrypoint
drains that queue before serializing its outgoing command batch, including DOM
writes produced by observer callbacks. This is a checkpoint for one synchronous
AOT host call, not a complete browser event loop or timer implementation.

## Servo patch

Pinned upstream Servo 0.7.0 has TODOs for transient observer registrations. The
unchanged shared test exposed this: after removing a child, its attributes were
no longer observed before the next microtask. AOT passed while Servo failed.

The tracked patch modifies three existing Rust modules:

- Node removal copies ancestor subtree registrations onto the removed subtree.
- MutationObserver tracks each transient registration's source and removes
  matching registrations when observe() updates that source.
- Notification removes transients before callback invocation. The pending list
  deduplicates observers while preserving first-queued order. Constructing an
  observer no longer prematurely puts it in the pending-notification list.

References use Servo's traced DOM pointers/rooting conventions. No additional
Rust unsafe block is introduced. `scripts/bootstrap.sh` checks the exact pinned
revision, recognizes an already-applied patch, and otherwise uses git apply's
context checks. A separate clean-source apply/reverse-check passed. The patched
Servo itself was rebuilt and run; this is not uncompiled integration code.

## Evidence

| Check | Result |
|---|---|
| Cargo build with patched Servo and both Hermes AOT units | Pass |
| Native Hermes shared contracts | 20/20, no listener errors |
| Real Servo shared contracts | 20/20 |
| Both engines: observer delivery, shared notification microtask, transient cleanup | Pass |
| Wayland with DISPLAY unset: AOT CSS, observer writes, events, input, disposal/remount | Pass, native exit 0 |
| Previous low-level DOM ownership/session smoke | Pass |
| Strict TypeScript/Vite, host Clippy, Rust formatting | Pass |

The results are project-owned contracts, not WPT. Click/input events in this run
were generated programmatically in Servo, not through physical Wayland devices.
The new library bundle is about 2.1 MB of source before native compilation; no
memory, startup or latency improvement is asserted. Dependency warnings remain
in the build logs.

Artifacts: [native AOT cases](../artifacts/browser-dom-native.json),
[Wayland result](../artifacts/browser-dom.json),
[rendered controls](../artifacts/browser-dom.png). Detailed current logs are
`artifacts/platform-build.log`, `platform-clippy.log` and `browser-dom-native.log`.

## Remaining compatibility work

- **Synchronous native event cancellation:** native click/input delivery travels
  through denied navigation and asynchronous evaluate_javascript. A Hermes
  preventDefault() decision cannot return before Servo's native dispatch/default
  action completes. A synchronous hook on Servo's script thread plus reentrancy,
  exception and lifetime rules is needed; the current bridge cannot establish
  these semantics. AOT-only dispatchEvent cancellation is already tested.
- **Full document/Web IDL:** the document is a mount-scoped mirror with 18 tags
  and six attributes. Live NodeList/HTMLCollection behavior, complete interface
  branding, namespaces, adoption, parsing/innerHTML, cloning, Shadow DOM and
  arbitrary attributes/interfaces remain absent.
- **Observer coverage:** fragment insertion, replaceChild and replacement across
  multiple source parents do not yet produce fully standard coalesced records.
  MutationRecord/DOMTokenList/selector results are not complete Web IDL objects.
- **Rendering state and ownership:** layout reads, getComputedStyle, stylesheets,
  externally mutated DOM synchronization and cross-engine reachability GC are
  absent. Detached wrappers remain until session disposal.
- **Application execution:** running the compiled SolidJS application itself in
  Hermes, browser task scheduling, full web-standard tests and Bun/Node APIs are
  separate remaining work. Only the demonstrated AOT controls use this layer.

Sources: [WHATWG MutationObserver algorithms](https://dom.spec.whatwg.org/#interface-mutationobserver),
[DOMTokenList](https://dom.spec.whatwg.org/#interface-domtokenlist),
[css-select](https://github.com/fb55/css-select) and
[cssstyle](https://github.com/jsdom/cssstyle).

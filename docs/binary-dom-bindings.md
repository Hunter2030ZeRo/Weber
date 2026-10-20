# Binary DOM bindings

This extends the SDK 0.2 foundation with a compiled, experimental byte transport
and native reads. It does not replace Servo's JavaScript engine or finish the
canonical native DOM ownership work.

## Implemented boundary

The normal browser-facade route now uses `Window.weberHostBytes(Uint8Array,
callback)` in the pinned Servo fork. The callback receives a rooted Uint8Array;
the custom API copies bounded buffers through the existing scoped channel while
the original script call is suspended. It does not spin a nested event loop.
Hermes uses JSI ArrayBuffer objects and CXX byte slices/vectors. Requests, replies,
pending command batches and synchronous DOM queries use Weber wire v1.

Wire v1 has a four-byte version header, tagged null/boolean/number/string/array/
record values, little-endian IEEE-754 binary64 numbers and UTF-16 code units.
Packets are limited to 1MiB and nesting to 64; host requests retain a separate
64KiB cap. Both JavaScript decoders and the Rust validation view reject malformed
packets. Rust validates the decoded schema and forwards original packet bytes;
it never recreates the outgoing packet from its UTF-8 validation strings. Thus
neither decimal formatting nor JSON escaping changes wire values.

This is **not zero-copy**: VM buffer allocation, bounded native copies, channel
ownership and schema decoding remain. Telemetry, test reports, the legacy raw DOM
demo and standalone fallback entry points still use JSON. Normal application
DOM requests and queries use the byte route.

## DOM authority and identity

For documents created with a native query scope:

- CharacterData and element text reads come from Servo. Text/comment/instruction
  wrappers do not store `_data` strings.
- Form `value` and `checked` reads come from Servo; wrappers do not store `_value`
  or `_checked`. Read-after-write flushes pending commands before reading.
- Native `cloneNode` copies text and form state inside Servo in one operation.
  The facade reserves wrapper handles and the adapter validates the complete
  cloned node count, type and name before registering those handles. Template
  contents, fragments, comments, deep/shallow cloning and clone independence
  are exercised against the native engine. It avoids fetching and resending
  every text/input value while cloning Solid templates.
- CSSOM queries use the same byte route. The preceding native CSS binding remains.
- Element selectors and ordinary Document selectors use native Servo selectors
  and return the existing wrappers by handle. Native node-to-handle lookup uses
  WeakMap rather than repeated whole-map searches.
- The current Document is represented by a managed subtree in a real Servo
  document. Document selectors containing `:root` or `:scope` retain the previous
  selector fallback until that document boundary is replaced. The selector
  library is initialized lazily when fallback is actually requested.

Detached nodes remain owned by retained wrappers and can be reinserted. Wrapper
identity, observer old values and the document clock are tested across requests.
Standalone tests without a native scope keep the explicit local fallback.

Wire preservation and native DOM semantics are separate. The pinned Servo
`DOMString` implementation converts UTF-16 to Rust strings lossily. Lone
surrogates therefore normalize to U+FFFD when written to its DOM, in both engines.
The wire codec independently preserves those code units before DOM conversion;
this milestone does not fix that Servo conformance limitation.

The facade still stores child/parent links and Attr objects alongside native
Servo state. This is not a canonical native node-handle facade yet. Removing
those links requires replacing their ownership/GC role as well as their lookup
role: a retained detached ancestor must preserve descendant wrappers, listener
closures and expandos. Replacing getters alone would allow reachable native
children's wrappers to be collected and lose identity.

Native clone currently relies on that known wrapper ownership graph. Unmanaged
native tree changes that alter its shape are rejected, rather than assigning
incorrect handles. Native attribute changes outside the facade are not yet
reflected into its Attr cache. General native parser/DOM materialization still
requires the canonical handle/lifecycle work.

## SpiderMonkey removal boundary

The inspected, pinned source exposes an embedding WebView and its delegate;
it does not expose a public engine-independent DOM object API. The byte extension
is still serviced by Servo's Window/generated WebIDL bindings. In particular:

- `components/script_bindings/reflector.rs` stores SpiderMonkey JSObject/Heap
  references and traces them through JSTracer.
- `components/script_bindings/root.rs` implements DOM roots and tracing using
  SpiderMonkey GC types.
- Window and Node implementation methods take JSContext/NoGC and generated
  binding traits internal to the script crate.
- `servo/js_jit` enables `script/js_jit`, which enables `js/jit`. Disabling that
  feature only disables JIT support; it does not remove the JavaScript runtime,
  DOM reflectors, tracing or generated bindings.

The dependency graph is recorded in
`artifacts/binary-binding-validation/spidermonkey-dependencies.txt`.
Hermes-only DOM execution still requires a real engine-port project: native DOM
roots and lifecycle, binding generation, conversion/error behavior, event
dispatch/reentrancy, promise checkpoints and GC tracing must be implemented and
compiled together. No uncompiled Hermes-only integration is presented as done.

## Evidence

The current native binding report is `artifacts/binary-native-bindings.json`.
Its test changes text and form state directly in Servo, reads through retained
AOT wrappers, then verifies writes, detached-node reuse, selectors, CSSOM and
clock stability. JSON.parse/stringify are disabled in both realms during the
exchange. Wire-only code-unit/number preservation is checked separately from
Servo DOM normalization. These are programmatic native renderer tests, not
physical-input proof.

Current release regression and performance results are recorded in
[binary-dom-validation.md](binary-dom-validation.md). Earlier framework reports
remain evidence only for their own source hashes.

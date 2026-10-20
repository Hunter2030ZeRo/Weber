# Synchronous events, HTML DOM and Solid AOT — 2026-10-19

This is an earlier implementation snapshot. The current completion criteria and
added layout, event, namespace and async APIs are documented in the
[fixed compatibility target](compatibility-target.md) and [live DOM path](live-dom.md).

For the subsequent timer/rAF implementation and revised event microtask checkpoint,
see [current scheduling work](scheduling.md). The original validation below is
retained; its scheduling limits have since been narrowed by that increment.

This increment runs an actual SolidJS TSX component as Static Hermes native AOT
code and applies its DOM operations to Servo. It also returns conditional event
cancellation to Servo before the browser's default action. Servo's DOM bindings
still run in SpiderMonkey. This is a compiled two-engine integration, not a
replacement JavaScript engine for Servo or a full browser implementation.
The normal application exposes it through the **Solid AOT app** link; it does not
require a test URL. The Wayland suite uses that same `weber://dom-solid` entrypoint.
The same TSX component can be opened in the SpiderMonkey web path with `?solidWeb=1`.

## Synchronous native event path

The tracked `patches/servo-sync-host.patch` adds an explicit `Window.weberHostCall`
Web IDL extension, an embedder message and a WebViewDelegate callback. This is a
Weber-specific API; it is not part of unmodified upstream Servo.

1. A capture listener at Weber's owned mount serializes the target handle, session,
   input value/checked state and event flags.
2. Servo's script thread sends a request and waits for the response. This uses
   Servo's existing profiled generic-channel mechanism, not prompt/alert dialogs.
3. The main thread calls Hermes through CXX. Its RefCell guard rejects reentrant
   calls. It does not call Servo evaluation/layout or spin a nested event loop
   while the script thread is waiting.
4. AOT listeners run synchronously, including Solid's delegated handlers. The
   response includes typed DOM commands and cancellation/propagation decisions.
5. Back on the script thread, the adapter applies commands and invokes the native
   event's preventDefault/stopPropagation methods before returning to dispatch.

Requests and responses are size bounded and decoded before delivery. Unsupported
requests, missing WebViews and AOT failures return null, which the adapter reports
as an error. An unimplemented delegate returns null by default. Like Servo's
existing synchronous embedder channels, the call waits for its embedder response;
an unresponsive embedder can block the script thread. There is no performance or
timeout guarantee.

The old navigation/evaluate_javascript transport remains for legacy handle calls
and initial adapter installation. Managed document events use the synchronous
path. This is ownership of a subtree, not arbitrary interleaving of native and AOT
listeners: native listeners inside that subtree can observe different phase/order
than AOT listeners replayed at the mount's capture listener. Events crossing
Shadow DOM and full trusted input-event identity are not implemented. The AOT
events are synthetic, including those triggered by browser activation.

## HTML and object compatibility

- The mirror now has a Document node, html/head/body ancestry, root/connectivity
  queries and document-level EventTarget dispatch. The real Servo document is
  still external; this HTML tree lives inside Weber's mount.
- Child NodeLists and element HTMLCollections are live, stable objects with
  indexed access, item(), iteration and collection brands. HTMLCollection has
  namedItem(). Selector NodeLists are static; MutationRecord node lists are also
  exposed through NodeList wrappers. This does not provide complete Web IDL
  branding, descriptors, conversions, interface-specific types or collection
  exotic-object behavior.
- Arbitrary validated HTML tag/attribute names replace the old 18-tag/six-attribute
  whitelist. Text and Comment nodes, DocumentFragment, deep cloneNode,
  same-document importNode and template.content are implemented. Listeners are
  not copied by cloning. Basic createElementNS/SVG case and namespace preservation
  are tested; namespaced attributes, prefix validation and complete namespace
  semantics remain open.
- parse5 7.3.0 provides contextual HTML fragment parsing and serialization for
  innerHTML, including table insertion modes, character references, comments and
  template content. The native transport creates innerHTML script nodes from an
  inert native template so that inserting the parsed tree does not execute them.
  Script/module loading, custom element reactions and full HTML interface/default
  state reflection are not established by this parser integration.
- Fragment transfers emit coalesced removal/insertion records. replaceChild emits
  one combined destination record, and replaceChildren retains source-parent
  removals while coalescing the destination. Suppressed intermediate records still
  establish transient observers until the checkpoint.

## Actual SolidJS, compiled once for each target

`app/src/compatibility-app.tsx` is used by both the normal Vite page and the native
AOT entrypoint. Vite + vite-plugin-solid compile normal DOM output. The application
uses Solid 1.9.9's normal web renderer and reactive core, not a manually reproduced
counter or a custom universal renderer.

`app/src/aot-web.ts` is a small adapter around the normal web renderer. It scopes
template caches to the current document and reinstalls delegated listeners when a
new document session mounts. The AOT code includes the compiled TSX and Solid
runtime. Cargo compiles that bundle with the DOM/application sources into
`weber_logic`; the parser/selector/CSS bundle is `weber_platform`. Both are native
objects linked into the host. No source evaluation runs inside Hermes.

The component exercises signals, Show, keyed For, Unicode input, checkbox state,
conditional navigation cancellation and stopPropagation. Its lifecycle is disposed
before document reset. The original outer demonstration UI, animation scheduler
and test driver still run in SpiderMonkey; only the shared compatibility app has
been moved to this AOT path. General timers/rAF/network/browser APIs for arbitrary
Hermes apps and the complete desktop shell remain future work.

## Validation

| Check | Result |
|---|---|
| Patched Servo + both native AOT units, Cargo build | Pass |
| Identical DOM cases in Hermes native AOT and actual Servo DOM | 30/30 in each |
| Observer delivery/order/transient cleanup | Pass in both engines |
| Native AOT Solid suite | Seven cases, pass |
| Real Wayland Solid app, DISPLAY unset | Pass, exit 0 |
| Native checkbox activation canceled/allowed by AOT condition | Pass |
| Native dispatchEvent return/defaultPrevented from AOT | Pass |
| Native propagation stop, immediate signal/input updates, keyed node identity | Pass |
| Disposal and new-document Solid remount | Pass |
| Parsed HTML/table/SVG reaches native DOM; parsed script remains inert | Pass |
| Legacy DOM/session regression, strict TypeScript/Vite, host Clippy/format | Pass |

The Wayland tests generate browser events programmatically. They do not prove
physical input latency, IME, accessibility or release performance. These 30 local
contracts are not WPT coverage and do not establish full HTML/Web IDL compliance.
Detached mirror/native handles remain session rooted; cross-engine reachability
GC is not implemented. Layout reads/getComputedStyle, external mutation sync,
adoption across documents, Shadow DOM and broad browser APIs remain unsupported.
Event delivery now defers Hermes microtasks to a Servo microtask checkpoint; see
[scheduling](scheduling.md). Ordering between the two realms is still not equivalent
to a unified browser realm.

Artifacts: [native DOM cases](../artifacts/compat-native.json),
[native Solid cases](../artifacts/solid-native.json),
[Wayland Solid result](../artifacts/solid-aot.json),
[rendered native Solid application](../artifacts/solid-aot.png),
[Wayland DOM cases](../artifacts/browser-dom.json).
Logs: `artifacts/compat-build.log`, `compat-clippy.log`, `solid-aot-native.log`,
`browser-dom-native.log`.

```sh
cargo build --locked
pnpm --dir app run build
target/debug/weber-servo --browser-contract-self-test
target/debug/weber-servo --solid-self-test
WEBER_SOLID_TEST=1 node scripts/wayland-smoke.mjs
WEBER_BROWSER_TEST=1 node scripts/wayland-smoke.mjs
WEBER_DOM_TEST=1 node scripts/wayland-smoke.mjs
```

Sources: [Solid DOM compiler/runtime](https://github.com/solidjs/solid),
[parse5](https://github.com/inikulin/parse5),
[DOM mutation algorithms](https://dom.spec.whatwg.org/#concept-node-replace),
[event dispatch](https://dom.spec.whatwg.org/#concept-event-dispatch).

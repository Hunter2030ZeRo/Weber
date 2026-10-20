# Historical browser-shaped DOM compatibility in Static Hermes

This records the earlier mounted-object implementation and 20-case test suite.
The document tree, collections, parsing, event bridge and Solid execution have
since changed. See [current implementation, tests and limits](native-solid.md).
Statements below about the mount being body, fixed tags/attributes or asynchronous
event cancellation describe that earlier implementation.

This layer adds browser-shaped objects above the explicit handle binding. It is
a tested subset, not full DOM/Web IDL, HTML, or browser compatibility. Servo still
owns the actual DOM in SpiderMonkey; Hermes runs the application as native AOT.

`WeberBrowserDOM.installGlobals()` installs `document`, `Node`, `Text`, `Element`,
`Document`, `Event`, `EventTarget`, `MutationObserver` and `DOMException` into the Hermes realm. The
demo uses ordinary object methods and properties:

```js
const document = WeberBrowserDOM.installGlobals();
const button = document.createElement("button");
button.textContent = "Click";
button.addEventListener("click", event => {
  event.currentTarget.textContent = "Clicked";
});
document.body.appendChild(button);
```

The document is **scoped to the page's `aot-dom-root` mount**, with `body` mapping
to that DIV. It is not the complete Servo document: there is no HTML/head/window
model or synchronization of arbitrary external DOM mutations. Synchronous getters
read the AOT-owned mirror; writes are batched to Servo. Input events synchronize
the targeted input value before AOT listeners run.

## Supported operations and semantics

- Stable Node/Element/Text wrappers and ownerDocument, parentNode, firstChild,
  lastChild, previousSibling, nextSibling, nodeType/nodeName, isConnected.
- createElement, createTextNode, createDocumentFragment; fragment insertion moves
  its children into the destination and leaves the fragment empty.
- appendChild, insertBefore, replaceChild, removeChild, remove, replaceChildren.
  Moving an existing child preserves identity. Browser removal **detaches**;
  detached nodes can be edited, dispatched to, and reattached with listeners.
- textContent, nodeValue and Text.data/length; element text replacement detaches
  old children and creates a real Text node. Text length uses UTF-16 code units.
- get/set/remove/hasAttribute, id/className reflection and input.value.
- getElementById traverses the mounted tree in order, excluding detached nodes.
- querySelector/querySelectorAll, matches and closest use css-select 7.0.0 over
  the AOT mirror. Tested selectors include groups, child/adjacent combinators,
  :scope, :not, :nth-child and attribute matches. Query results are static arrays.
- classList supports token iteration, item/length/value, contains, add/remove,
  toggle and replace, with attribute reflection and tested validation rules.
- In real views, inline style uses Servo's CSSStyleDeclaration through the native
  binding. Standalone runtimes without a scoped DOM route use lazy cssstyle 6.2.0
  fallback. The same style object survives attribute replacement/removal, and
  native results update Attr identity and observer records without duplicate writes.
  See [framework validation](framework-validation.md) for current release evidence.
- MutationObserver supports attributes/filters/oldValue, characterData,
  childList, subtree, takeRecords/disconnect and observation-option updates.
  Notifications run at a native Hermes microtask checkpoint before commands are
  flushed to Servo. Pending observers share one notification microtask; removed
  subtrees remain observable until delivery, then transient observations expire.
- EventTarget supports listener identity, duplicate registration suppression,
  removeEventListener, once/capture/passive and function/object callbacks.
- AOT dispatchEvent is synchronous: capture, target, bubble, target/currentTarget,
  eventPhase, this binding, preventDefault, propagation stops and cancellation
  return value. Exceptions from listeners are recorded in document.listenerErrors
  instead of escaping dispatchEvent. Removed pending listeners are skipped.
- Tree errors use named DOMException instances, including NotFoundError,
  HierarchyRequestError and InvalidCharacterError for tested cases.

Elements are limited to the bridge's 18 supported HTML tags. Attributes remain
id/title/class/type/placeholder/style; unsupported names report NotSupportedError.
Cross-document adoption is explicitly unsupported. Native click/input events
are delegated from the mount, translated into AOT synthetic events, and replayed
through the AOT event path. AOT handlers cannot synchronously cancel Servo's native
default actions or propagation across the engine boundary. These replayed events
are not trusted events. Arbitrary event types work only for AOT dispatchEvent.

The low-level `WeberDOM.remove(handle)` remains destructive for legacy clients.
The new browser objects instead use the separate detach protocol. Session disposal
invalidates the mirror and clears native registrations. Detached nodes are retained
in session registries for identity; reachability-based cross-engine GC is not
implemented, so repeated replacement can retain nodes until session disposal.

`childNodes` is a stable live array with item(), not a Web IDL NodeList;
`children` is a filtered array snapshot, not a live HTMLCollection. Layout reads,
getComputedStyle, stylesheets, innerHTML, cloneNode, Shadow DOM,
AbortSignal listeners, namespaces, arbitrary HTML interfaces, default actions and
framework-level SolidJS execution in Hermes remain unimplemented. Readonly and
property-brand enforcement are not equivalent to Web IDL. css-select accepts
some extensions beyond browser selector grammar; complete CSS parsing and WPT
compatibility are not established. MutationRecord objects/collections are plain
objects/arrays, and fragment/replaceChild/multi-source replacement record
coalescing is not fully equivalent to DOM algorithms.

The pinned Servo checkout also lacked transient MutationObserver registrations.
`patches/servo-transient-observers.patch` implements registration on removal,
cleanup on observe()/notification and pending-observer deduplication. Bootstrap
applies it with revision and patch checks. This is a local compiled Servo change,
not a claim about unmodified upstream Servo. See [platform details and remaining
gaps](browser-platform.md).

## Verification

The implementation follows the relevant [WHATWG DOM tree algorithms](https://dom.spec.whatwg.org/#concept-node-pre-insert)
and [EventTarget/event dispatch model](https://dom.spec.whatwg.org/#interface-eventtarget)
for the supported cases. Tests are project-owned contracts, **not a WPT pass**.

`aot/browser-contracts.js` contains twenty identical cases executed both as native
AOT code and against a real Servo Document created with createHTMLDocument:
identity/relations; insert/move/replace; detached reuse; text replacement;
fragment transfer; attributes/input value; exception names; event phases;
duplicate/once/removal; cancellation/passive/propagation; selectors; classList;
inline CSS; mutation attributes/filter/oldValue; childList/characterData;
transient subtree observations; invalid observer options; observation updates;
token contains validation; per-iteration lexical closures. A separate shared
asynchronous test verifies notification ordering relative to queueMicrotask,
single delivery and transient cleanup. The native entrypoint checks this after
draining the actual Hermes microtask queue.

```sh
cargo build --locked
pnpm --dir app run build
target/debug/weber-servo --browser-contract-self-test
WEBER_BROWSER_TEST=1 node scripts/wayland-smoke.mjs
```

Both realms passed all twenty shared cases and the asynchronous checkpoint test
on 2026-10-19. The Wayland run (DISPLAY
unset) also verified actual Text creation, input.value delivery, native DOM
click/input events reaching AOT Event objects, text updates, inline CSS reaching
the real Servo DOM, observer callbacks updating the DOM, disposal/remount and
clean native close. Events were generated programmatically in Servo; physical
Wayland input was not tested. The prior handle API's native lifetime tests and
Wayland create/callback/removal/stale-session tests also passed after the protocol
extension. Build, TypeScript/Vite, host Clippy and formatting passed; upstream
Servo/Hermes warnings remain visible.

- [AOT contract results](../artifacts/browser-dom-native.json)
- [Wayland bridge results](../artifacts/browser-dom.json)
- [Rendered browser-API controls](../artifacts/browser-dom.png)
- Current detailed logs: artifacts/browser-dom-native.log, platform-build.log and
  platform-clippy.log. Earlier browser-dom-build/clippy logs are historical.

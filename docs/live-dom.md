# Live Servo reads and asynchronous APIs

This implements the bounded [fixed UI profile](compatibility-target.md). The
authoritative completion result is `artifacts/compatibility-profile.json`, not
the existence of these APIs or a successful compilation alone.

## Synchronous queries

`Window.weberHostCall(payload, queryCallback)` is a **local Servo extension**.
Its implementation and generated WebIDL callback configuration are tracked in
`patches/servo-sync-host.patch`. Upstream Servo 0.7.0 does not expose this API.

The originating script call waits for the embedder. While Hermes runs on the
host thread, a native host function may send a bounded query back to that waiting
call. The script thread invokes its rooted WebIDL callback, applies preceding
DOM writes, performs the real read, and returns JSON through a separate reply
channel. It does not run a nested Servo event loop. The Rust query route exists
only during this host call and is cleared by a scope guard. Both directions
validate size/session/type information; channel waits have a 30-second limit.
Nested host calls during query execution are rejected.

This serves getBoundingClientRect/getClientRects, live getComputedStyle property
reads, client/scroll metrics, scrollTo/scrollBy, viewport properties and
focus/blur/activeElement. Returned geometry comes from Servo. A standalone AOT
command without a live script query route cannot produce renderer geometry.
The facade still represents one owned subtree, with virtual document/head/body
nodes; it does not become Servo's global Document object.

## Asynchronous delivery

ResizeObserver subscriptions and fetch requests are typed commands. The Servo
adapter owns the actual browser observer or AbortController. Results contain
the document session and an operation handle; Hermes retains the callbacks and
promise resolvers. Reset/disposal cancels native operations and releases AOT
registries. Native callbacks check the captured session before delivery.

The fetch profile buffers text before resolving its AOT Response. It supports
Headers, status/ok/url/redirect metadata, text/json body consumption, cloning an
unconsumed buffered body, string request bodies and AbortSignal reasons. It does
not implement a streaming Response.body or a complete Request/Response WebIDL
surface. Delivery is subject to the host request size bound (64 KiB JSON), so this
version is intended for small UI API responses. HTTP/CORS behavior is supplied
by the real Servo fetch; it is not replaced by a host HTTP client.

Typed UI events carry mouse coordinates/buttons/modifiers, keyboard key/code/
location/repeat/composition, and input data/inputType/composition. This is a
snapshot across the two engines. It does not establish trusted physical input,
complete UI-event WebIDL conformance, or mixed-engine listener ordering.

## Pinned native unit capacity

Pinned Static Hermes originally has eight SHRuntime unit slots (slot zero is
reserved). Independent native WPT scripts exhaust that process-wide registration
space. `patches/hermes-unit-capacity.patch` expands it to 128 slots; it remains a
fixed bound. This changes the native ABI, so the runtime and every native unit
must be rebuilt together. The build cache includes the SHRuntime header.
There are 36 WPT native objects in addition to the two core application/platform
objects. WPT units execute only when explicitly requested by the test runner.

The original HTML fixtures are parsed before their extracted native test scripts
execute; parsing-time script scheduling is not tested by this shell harness.
The original script text and assertions are hash verified and never rewritten.

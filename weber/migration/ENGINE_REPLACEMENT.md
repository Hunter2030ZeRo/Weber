# Chromium replacement boundary

Source baseline: Electron c1aad3df47dcae19bad6d12157c7f06ad72ea409.
This map comes from that source, not from assumptions about an interchangeable
browser library. The current adapter does not yet modify these call sites.

| Electron implementation | Chromium dependency to remove from engine-facing contract |
| --- | --- |
| shell/browser/api/electron_api_web_contents.h | WebContentsObserver, WebContentsDelegate, RenderWidgetHost input observer and JavaScriptDialogManager inheritance |
| shell/browser/api/electron_api_web_contents.cc — constructors | content::WebContents creation, browser context and site instance lifetime |
| Same file — LoadURL | NavigationController::LoadURLParams, referrer and navigation event semantics |
| Same file — CapturePage | RenderWidgetHostView and surface copy completion |
| shell/browser/native_window.h | Keyboard routing and WebContentsUserData association |
| BUILD.gn — electron_lib | Chromium build graph and V8-dependent bindings |

The new shell/renderer/obscura target proves the engine-side calls with real
Obscura. It is intentionally a standalone replacement-renderer component:
linking a Rust library that embeds V8 into the existing Electron process risks
two different V8 implementations in one address space. A process boundary is
required before browser-side routing is connected.

The C ABI is private and versioned. It accepts bounded JSON requests and returns
borrowed callback bytes with explicit status. It handles local navigation,
viewport changes, synchronous-result evaluation and diagnostic PNG capture.
Unknown commands, invalid handles, cross-thread calls and failed evaluation
are errors. Panics poison the engine; they are not reported as successful calls.
This is not Electron's renderer IPC or its structured-clone implementation.

Remaining first vertical slice: BrowserWindow -> browser-side engine proxy ->
dedicated Obscura renderer process -> native window surface. The success gate is
an ordinary Electron main script loading a local document into that window with
no Chromium renderer. The current C++ smoke does not satisfy that success gate.

Raw frame transport, input dispatch, isolated preload and OS sandboxing remain
part of that work. Bun/Native alternatives and the agent interface are deferred
while implementing the Electron-based engine replacement path.

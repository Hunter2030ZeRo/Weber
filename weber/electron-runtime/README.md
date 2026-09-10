# Electron source runtime on Obscura

This build compiles the fork's original `lib/browser/api/browser-window.ts`,
`base-window.ts`, `web-contents.ts`, and their internal dependencies. It executes
those modules with replacement bindings that send native window and document
operations to `weber-desktop-host`. Each window has an Obscura renderer process.
Chromium `content`, Blink, Viz, and Chromium renderer binaries are not used by
this runtime target. The upstream Electron C++ target remains in the source tree
for reference; building that upstream target still produces Chromium Electron.

`build.cjs` reads the original files directly. It records the path and SHA-256 of
every compiled module in `dist/source-manifest.json`. It does not rewrite or copy
the public implementations of `loadFile`, `loadURL`, the load-event Promise, or
BrowserWindow's forwarding methods into a second framework implementation.

The replacement code is intentionally at the native binding boundary:

* `bootstrap.cjs` installs Electron module/binding resolution and starts the app.
* `bindings.cjs` supplies the native objects expected by the original modules.
* `host-client.cjs` transports bounded requests to the GTK host.
* `menu-binding.cjs` maps original Menu/MenuItem policy to actual GTK menus.
* `global-shortcut-binding.cjs` uses the private synchronous Node-API channel for
  actual X11 registration and ownership booleans; callbacks remain asynchronous.
* `notification-binding.cjs` routes the original Notification lifecycle through
  the desktop D-Bus notification service, with bounded asynchronous delivery.
* `power-binding.cjs` connects the original lazy powerMonitor wrapper to native
  XScreenSaver idle queries and UPower/logind events, without periodic polling.
* `utility-binding.cjs` starts actual independent Node/Bun utility processes;
  `utility-bootstrap.cjs` installs the original ParentPort module in the child.
* `commonjs-loader.cjs` executes CommonJS modules on Bun, whose `Module._load`
  interception differs from Node. Builtins and native addons remain Bun's.

## Build and run

From the fork root, install the build-only TypeScript compiler and Node-API
headers, then compile the original Electron modules and the platform addon
(requires a C++17 compiler):

```sh
npm ci --prefix weber/electron-runtime
node weber/electron-runtime/build.cjs
```

After building the native runtime targets, use the backend selector's
`--runtime-root weber/electron-runtime` option. Direct development startup is:

```sh
WEBER_UNSANDBOXED_DEVELOPMENT=1 \
WEBER_DESKTOP_HOST="$PWD/out/runtime/weber-desktop-host" \
WEBER_OBSCURA_RENDERER="$PWD/out/runtime/obscura/weber-obscura-renderer" \
node weber/electron-runtime/bootstrap.cjs /absolute/path/to/app
```

`bun` can replace `node` for CommonJS applications. Node ESM module resolution
uses `module.registerHooks`; Bun ESM app loading is explicitly unsupported at
this stage. `WEBER_ENTRY` allows the TOML selector to choose an entry file that
differs from `package.json.main` without editing that application metadata.

`original-fs` and `node:original-fs` resolve to the actual `node:fs` module on
Node CommonJS/ESM and Bun CommonJS. This runtime has no ASAR filesystem wrapper,
so `.asar` paths remain ordinary native paths. Providing this import does not
implement ASAR archive loading; adding an archive-aware `fs` layer later must
preserve `original-fs` as the unwrapped native filesystem implementation.

The development opt-in is mandatory because the renderer has process separation
but no operating-system sandbox. Do not mistake a different process for an OS
sandbox. The engine's isolated preload context exposes the implemented
`require('electron')` subset (`contextBridge.exposeInMainWorld` and
`ipcRenderer.invoke`, `send`, `on`, `once` and listener removal). Other Node modules and renderer Node integration are
rejected. Preload code is never substituted with main-world script injection.
Exposed function calls currently return Promises and transport copied JSON
values; this is a subset of Electron's full contextBridge contract.

## Actual scope and validation

`test-live.cjs` checks source provenance and launches an ordinary Electron app
that creates two native windows. The app checks actual native draw completion,
Obscura executable identities, Promise evaluation through the original Electron
IPC helper, isolated preload state, contextBridge calls, bidirectional ipcMain
invocation/rejection, DOM events, independent window state, PNG capture, and
close events.
This test requires the actual host and renderer under a Linux display/Xvfb; it
does not use a simulated engine. A passing result is a narrow integration test,
not a claim of VS Code compatibility or lower memory consumption.

Native GTK menu mouse input, checkbox/radio behavior, accelerators, multiwindow
ownership and removal are tested. Popup menus, icons, sublabels and several
built-in roles remain unsupported. The X11 globalShortcut implementation and
its actual cross-process input tests are described in
[platform-sync/README.md](platform-sync/README.md). A relocatable development
archive is assembled and exercised by [the packaging workflow](../packaging/README.md).

Custom protocols use the original `protocol.ts` implementation with native
resource dispatch for documents, CSS, classic/ES scripts and fetch. Handlers are
owned by the requesting window's session partition. File handlers pass the path
to the native host, which sends raw bytes through a private resource socket;
large application modules do not make a base64 round trip through the JS main.
Standard custom schemes have authority-based origins. Fetch eligibility and CORS
checks are enforced; file interception is explicit. `protocol.handle` uses the
original Request/Response adapter. Persistent cookies/storage, HTTP protocol
handlers, full redirects, service workers and CSP bypass remain unsupported.
Declaring a scheme privilege does not implement all associated browser features.

The original modern clipboard and ClipboardItem modules use native GTK/X11
ownership; a compatibility adapter provides the legacy synchronous text, HTML,
RTF and binary APIs used by Electron applications. CLIPBOARD and PRIMARY are
separate. External xclip readers/writers verify actual cross-process data.
Payloads and native wait time are bounded; full NativeImage and bookmarks are
not implemented. `screen` reads actual monitor geometry/work area/scale and cursor
position, with native monitor-change events. Linux systemPreferences returns
GTK animation preferences and the current theme accent when available. Screen
rotation/color profiles/touch detection and platform-specific macOS/Windows
methods are outside this implementation.

The original MessageChannelMain/MessagePortMain wrappers use bounded queues,
structured data copying, ownership transfer, start and close semantics. Ports
can be transferred from main into an actual utility process. Queued messages
survive that transfer, old owners detach, and the child uses the original
MessagePortMain wrapper for bidirectional data. Serialization re-entrancy is
checked before ownership moves. Renderer and nested utility transfers remain
unsupported; rejected transfers retain ownership.

Utility children execute with the selected JavaScript backend, using a private
Unix socket and serialized structured values (cycles, typed arrays, Maps, Sets,
BigInts). Original utilityProcess and ParentPort sources supply public API
behavior. Stdio descriptors are moved into the original wrapper's Socket path;
cwd, environment, args, CJS/ESM entry, spawn/message/exit and kill are exercised.
Removing all parentPort message listeners permits normal child exit. The Linux
parent-death signal stops an owned utility even if its JavaScript cannot process
EOF. This covers that immediate child, not an arbitrary descendant tree or an
OS sandbox. Utility windows or a Chromium subprocess are never created.

Limits are 32 utilities, 64 transferred ports per utility, and 4 MiB/256 queued
messages per channel or paused inbox. There are no periodic delivery polls.
Authentication integration and platform-specific unsigned-library options fail
explicitly. Browser structured-clone types and automatic Electron-module support
inside utilities are not implemented. A Node application starts Node children;
a Bun application starts Bun children. Cross-engine serialized channels are not
claimed. Bun 1.4.2 needs explicit FD adoption in `utility-socket.cjs`; that
adapter is scoped to Weber's transport and the upstream utility wrapper's stdio
imports. Application net imports remain Bun's own implementation. Native
callback checkpoints must not deliver public spawn before the wrapper exists.
See `test-utility.cjs` and the real window/bundle fixture.

Original crashReporter and contentTracing modules can be imported by applications
that disable those optional services during startup. The inactive crash reporter
stores bounded string parameters and reports no uploads. Native dump collection
and uploading are not implemented: starting the reporter or enabling uploads
throws explicitly. This is not crash-collection compatibility.

Node contentTracing records actual PerformanceObserver marks and measures in
the `weber.main.user_timing` category and writes trace-event JSON. Capture is
bounded to 4,096 events/4 MiB and stops admitting events when full. The output
records dropped events and explicitly excludes renderers. Sampling, Chromium
categories, memory dumps and Bun recording are unsupported. There is no periodic
poll when tracing is inactive. See `test-startup-services.cjs` for real trace-file
and lifecycle checks; the Bun-specific path checks explicit unavailability.

Startup command-line values support append/read/remove before app ready, subject
to an explicit option allowlist. Locale selection is reflected in app locale
queries; it does not reconfigure Obscura's Intl implementation. VS Code's Chromium
tuning hints are retained for readback and reported with WEBER_ENGINE_OPTION
warnings because they have no Obscura effect. Proxy, certificate, arbitrary
JavaScript-engine and security changes are not silently accepted. Neither
`no-sandbox` nor its GPU variant bypasses the existing explicit development opt-in;
`app.enableSandbox()` continues to fail until OS isolation exists.

The original shell module delegates Linux external URI/file opening and trash
operations to `/usr/bin/gio` from `libglib2.0-bin`. Arguments are passed directly
without shell evaluation. `showItemInFolder` requests FileManager1.ShowItems
through `/usr/bin/gdbus`, falling back to opening the containing directory.
Desktop operations have a five-second deadline, bounded output and at most 32
active helpers. Application exit cleans up launcher helpers; successfully
launched external applications remain independent, as intended.
`test-shell-live.cjs` uses real GIO with private desktop registrations and files,
including special characters and retained trash contents. It exercises the
folder fallback; selection inside a real file manager is not yet an acceptance
pass. Beep, Windows shortcut-file operations and unsupported launch options
remain explicit errors.

Renderer IPC supports invoke/rejection plus send/on/once/listener removal,
webContents.send and event.reply through isolated preload contexts. Simultaneous
replies are batched up to 32 messages or 256 KiB (an individual reply is limited
to 768 KiB), with one native bridge entry per batch. A microtask flush adds no
polling timer. Stale, duplicate or invalid members are rejected before any ticket
in the batch is settled. Main-world contextBridge still transports JSON and
async function proxies; arbitrary callbacks and Electron's full structured-clone
contract are not implemented.

ContextBridge call/settlement traffic is also batched, up to 32 per context
entry. Native host event batches stay batched into the backend. Page commands
can enter the window worker queue directly when no earlier GTK operation forms
an ordering barrier. Small replies on an empty Unix socket output queue are sent
without waking the output writer; partial sends retain the bounded ordered path.
Fresh private JSON parse trees are validated in place. Application-owned values
still require strict copying that rejects accessors and unsafe serialization
hooks. Overflow, stale generations, timeouts and receiver failure remain tested.

Notification delivery, replacement, default click, close, silent hints and
absent-service failure are exercised on Node and Bun using a private D-Bus
protocol peer. The peer is test infrastructure; the runtime uses the real native
GDBus transport. Image-object icons, full custom actions, daemon restarts and
platform-specific notification behavior remain acceptance work. Native power
tests use real X11 idle queries and a D-Bus peer for power/suspend/resume/session
lock events. Shutdown inhibition is explicitly unsupported; Linux thermal state
can be unknown. These tests do not claim complete desktop-daemon coverage.

Tray, drag and drop, persistent sessions, transferred renderer and nested utility
message ports, an OS sandbox, full navigation history, general
WebContentsView embedding, production installers and VS Code acceptance remain
unimplemented. Unsupported binding operations fail explicitly. Many upstream
public methods are present because original Electron source is reused; presence
alone must not be counted as working compatibility.

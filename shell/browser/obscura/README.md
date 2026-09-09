# Obscura browser process and desktop host

The Chromium-free runtime target routes the fork's original Electron JavaScript
API modules through replacement native bindings to a GTK desktop host:

1. An application loads `electron` through `weber/electron-runtime` on Node.js
   or the implemented Bun CommonJS loader.
2. Original Electron `BrowserWindow`, `BaseWindow`, `WebContents` and internal
   API modules call the replacement bindings in `bindings.cjs`.
3. Bounded JSON requests reach `weber-desktop-host` in `desktop/main.cc`.
4. The GTK host owns native windows. Each window has a worker thread and an
   independent `weber-obscura-renderer` process running the Obscura C ABI.
5. The host presents Obscura pixels through Cairo and relays document events
   back to the original Electron API modules.

The desktop host and process proxy do not link Obscura or V8; those are linked
into the child renderer. This runtime target does not load Chromium `content`,
Blink or a Chromium renderer. The original C++ `electron::api::WebContents` and
upstream GN application target remain as reference code. Building that original
target still builds Chromium Electron. The GN targets in this directory compile
the transport; they do not replace the old native WebContents implementation.

## Process transport

The Linux/glibc proxy starts an absolute renderer executable with `posix_spawn`.
Its caller owns it on a worker thread: synchronous, bounded command calls do not
run on the GTK UI thread. A private socketpair is inherited as fd 3; other
descriptors above stdio are closed before exec. There is no shell, TCP/WebSocket
listener, executable search through PATH, or Chromium fallback.

A 16-byte big-endian header carries `WBR1` magic, sequence, kind and payload size.
Kinds are request=0, success=1, error=2 and ready=3. Startup returns ready,
sequence 0 and payload `1`. Requests are capped at 1 MiB and replies at 64 MiB
before allocation. Normal replies are JSON; `capturePng` returns diagnostic PNG
bytes, and `captureFrame` returns a raw frame. `captureFrameIfChanged` returns
that frame or zero bytes when unchanged. Errors are UTF-8 text.

There is one command in flight per proxy, with one deadline across send and
receive. Invalid frames, sequence mismatches, disconnects and timeouts close
the channel and terminate/reap that proxy's child. A reported engine error does
not itself corrupt the wire protocol; fatal runtime/bridge failures require
restart. The host uses a 30-second transport deadline.

## Frames, input and window lifetime

Raw replies contain `OBF1`, little-endian 32-bit width and height, then tightly
packed premultiplied RGBA8 pixels. The host converts them to Cairo's native
ARGB32 byte order. Obscura's retained layout, resources, scrolling and canvas
surfaces produce these pixels without a PNG encode/decode cycle. Raster size
currently follows the CSS viewport at scale 1; high-DPI rasterization remains
to be connected.

`captureFrameIfChanged` checks actual document/canvas/resource generations,
viewport changes, dirty retained caches and active CSS/Web Animations before
painting. Unchanged pages skip layout, rasterization and pixel transfer. At
most one frame waits for the GTK thread. The host checks updates about every
16 ms; the child independently offers its browser event loop a 2 ms cooperative
turn every 16 ms. These wakeups still exist, so frame suppression alone is not
an application-wide CPU or memory comparison.

GTK pointer press/release/movement, wheel and keyboard events reach corresponding
engine commands. The adapter reuses Obscura's CDP DOM event implementation, with
validated coordinates, focus, modifiers and DOM key names. Full pointer/hover
behavior, IME composition, physical-key layout mapping and complete
contenteditable editing are not implemented.

The native close button emits `close-requested` for the application binding.
An accepted close destroys the GTK window, wakes its worker and emits `closed`.
The worker rejects queued commands and destroys its proxy, terminating and
reaping its renderer. Completed workers and retained pixel buffers are collected
during application lifetime, rather than retained until the last window closes.
The full browser `beforeunload`/unload contract is not implemented. Closure of
the parent socket endpoint lets an idle child observe EOF.

## Navigation and isolation boundaries

Desktop mode defers author-requested document navigation, including startup
scripts. `navigation-requested` carries the destination, method, body and source
URL. The browser owner must authorize an explicit `loadURL`; the transport does
not silently follow it. The replacement bindings do not yet implement the full
Electron navigation-event/permission contract. Cross-origin HTTP redirects fail
before destination DOM parsing, preload installation and author execution.
The HTTP client may already have followed the network redirect: per-hop network
authorization is not provided. Ordinary headless callers retain their existing
navigation behavior.

The engine creates a separate preload V8 context with private dispatcher handles
and copied JSON messages. This implements an asynchronous subset of Electron's
context bridge, not its complete structured-clone or preload environment.
Process separation and a separate V8 context are not an OS sandbox. The host
requires `WEBER_UNSANDBOXED_DEVELOPMENT=1` for trusted development applications.
Windows/macOS hosts and OS sandbox policies remain unimplemented.

## Validation scope

Transport fixtures test malformed frames, deadlines, descriptor inheritance and
child cleanup. A separate real process test starts two Obscura renderers, checks
independent documents and PNG output, kills one, verifies the other still
responds and starts a replacement. These tests do not create GTK windows.

Additional actual-engine C ABI tests cover damage-aware frames and navigation
deferral. `weber/electron-runtime/test-live.cjs` instead launches an ordinary
Electron app against the GTK host and actual Obscura processes under a display
or Xvfb. It checks native draw completion, two windows, isolated preload,
context bridge/IPC, document operations and closing. Only a completed run of
that test establishes those GUI results; transport and source compilation
checks cannot substitute for it.

These tests do not establish broad Electron/VS Code compatibility or a
performance advantage. See `weber/electron-runtime/README.md` for build/run
instructions and the currently unsupported API scope.

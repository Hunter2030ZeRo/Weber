# Weber

Experimental GUI framework using **obscura-for-weber** as its web engine,
with Node.js, Bun, and native Rust application backends.

**Status: integration prototype, not an Electron fork or drop-in replacement
yet.** The Electron checkout under `upstream/electron` is a pinned reference,
not a runtime dependency. Importing Electron's source/history and replacing its
Chromium-dependent implementation remains outstanding. This branch must not be
represented as completion of that migration.

## Implemented source

- A Rust host using Obscura's `Page`, `winit` windows, and `softbuffer` presentation.
- One trusted local HTML window per process, resizing, basic left-button input,
  text input, IME commit forwarding, and root scrolling.
- A shared Node.js/Bun API: `app.whenReady`, `BrowserWindow`, `loadFile`, window
  visibility/title/close, synchronous-result JavaScript evaluation, and
  `ipcMain.handle`.
- Native Rust embedding through `weber_host::run_native`, with no Node/Bun
  process required.
- Promise-based `window.weber.invoke`, per-window channel allowlists, bounded
  messages, request deadlines, process-exit handling, and document-generation
  checks for delayed backend replies.

There is no Electron or Chromium fallback. A missing host or failed engine
initialization is an error.

## Build and run

Prerequisites: Rust stable plus Obscura's native build dependencies, a desktop
display, and Node.js 22+ or Bun for the JavaScript backend. Obscura brings V8;
removing Chromium does **not** remove V8.

```sh
git submodule update --init --depth 1 vendor/obscura
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --release -p weber-host --bins --examples

# Same application, two backend runtimes:
node examples/javascript/main.mjs
bun examples/javascript/main.mjs

# Native Rust application backend:
cargo run --release -p weber-host --example native
```

On PowerShell, set build variables with `$env:CARGO_INCREMENTAL='0'` and
`$env:CARGO_BUILD_JOBS='2'`, then run the `cargo build` command without the
inline variable assignments. Windows and macOS compilation are unverified.

The JavaScript package finds `target/release/weber-host` automatically. Set
`WEBER_HOST` to an absolute executable path when using another build location.
Published packages and bundled runtime installers are not available yet.

```js
import { app, BrowserWindow, ipcMain } from './packages/weber/index.mjs';

ipcMain.handle('greeting', () => 'Hello from the backend');
await app.whenReady();
const window = new BrowserWindow({ allowedChannels: ['greeting'] });
await window.loadFile('./index.html');
app.on('window-all-closed', () => void app.quit());
```

In the HTML document: `await window.weber.invoke('greeting')`.
Window operations return promises. Unsupported options fail explicitly.

## Validation

```sh
npm test
# After the native release build, on Linux:
xvfb-run -a node tests/native-smoke.mjs
```

The Node test suite checks the pipe protocol, API lifecycle, channel denial,
renderer bridge, malformed/oversized frames, deadlines and host crashes using
an explicitly identified host test double. **These tests do not prove that
Obscura builds, renders correctly, or supports real desktop applications.**
The separate native smoke test checks the real Obscura DOM and round-trip IPC.
See CI for native build results; do not infer a passing build from source alone.

## Current limits

- Native code and Bun execution need independent validation. The authoring
  environment had Node.js, but no Rust/Bun toolchain or desktop display.
- The presentation path encodes and decodes PNG frames at up to approximately
  30 ticks/second. This is a bring-up path, not the intended efficient renderer.
  No comparative performance or memory claims have been measured.
- GUI navigation and page execution currently share the main thread. Navigation
  can stall the window. Renderer workers/process isolation are not implemented.
- One window per host; no menus, tray, clipboard, drag/drop, packaging, DevTools
  attachment, complete keyboard editing, accessibility, or OS sandbox.
- Only trusted local applications. The bridge is in the page's own JavaScript
  realm, not Electron's `contextIsolation` or `contextBridge`. Channel checks do
  not make arbitrary remote content safe. `loadURL` is unsupported.
- Electron APIs, extensions, Node native addons in the renderer, and VS Code
  compatibility are not provided. Obscura web-platform compatibility also
  remains a separate constraint.

## Next integration gates

1. Obtain a native release build and run the real-engine smoke test on a display.
2. Import Electron source and history into a dedicated migration branch, keeping
   its MIT notices. Port the selected public API contracts to an engine boundary;
   its `content::WebContents` implementation cannot simply link against Obscura.
3. Replace the temporary PNG path with a raw pixel/dirty-region Obscura embedding
   API, and move page work off the GUI event loop.
4. Add isolated renderer processes, complete input/IME/accessibility, multiwindow
   lifecycle, OS integration, and cross-platform packaging.
5. Benchmark equal application workloads for memory, startup, input latency and
   rendering fidelity before making Electron/Tauri comparisons.

## Upstream

`vendor/obscura` is pinned to the user's `obscura-for-weber` repository, including
its vendored layout/font patches. `upstream/electron` is optional for the current
prototype and excluded from the runtime build. Both preserve their own licenses.
Weber's existing Apache-2.0 license remains in effect for its original code.

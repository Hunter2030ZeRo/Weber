# Weber

Experimental GUI framework using **obscura-for-weber** as its web engine,
with Node.js, Bun, and native Rust application backends.

**Historical prototype documentation.** The active Electron/Obscura runtime is
on [`codex/obscura-runtime`](https://github.com/Hunter2030ZeRo/Weber/tree/codex/obscura-runtime).
Use the [repository README](../README.md) for its current CMake/Cargo build,
Node/Bun/native backend selection and verified limitations. The instructions below
describe the earlier standalone Rust prototype; they are retained as history.

## Product acceptance goals

The [product goals and acceptance criteria](docs/product-goals.md) define the
required destination: minimally modified Electron apps including VS Code,
lower memory and higher performance as the top priority, native desktop
integration and installers, multiple windows, and process isolation/security.
These are release requirements, not implemented capabilities. Performance
comparisons must preserve equivalent functionality and security.

The [Electron compatibility ledger](docs/electron-compatibility.md) tracks actual
API behavior and remaining differences. Window IDs and registry lookups are now
synchronous; webContents supports synchronous getURL for explicit loadFile,
destruction state/events and did-finish-load. ipcMain.handleOnce consumes its
registration before invoking user code. These changes do not provide preload,
Electron module resolution, multiwindow support or VS Code compatibility.

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

Choose the backend in the project-root `weber.toml`:

```toml
schema = 1
backend = "node" # change to "bun" or "native"

[app]
frontend = "examples/javascript/index.html"
channels = ["system.info"]

[node]
entry = "examples/javascript/main.mjs"

[bun]
entry = "examples/javascript/main.mjs"

[native]
binary = "target/release/examples/native"
```

Build the launcher with `cargo build --release -p weber-cli`, then run
`./target/release/weber run` from the project directory. Alternatively install
it with `cargo install --path crates/weber-cli` and use `weber run`. The same
command works for all three backends. `weber run --backend bun` overrides the
setting for one launch, and `weber check` prints the resolved launch plan.
Use `--project DIRECTORY` when starting from a different directory.

Backend selection happens at startup, not while an application is running.
The Rust launcher requires neither Node nor Bun for the native backend. Node
and Bun can share an entry script, subject to their runtime compatibility;
native applications need a separately compiled Rust backend implementing the
same channels. Changing the setting does not translate JavaScript into Rust.
The launcher exports the shared frontend path and channel list for all backends;
both included examples consume those settings. Missing runtimes/binaries fail
explicitly instead of falling back to another backend.

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
The separate native smoke test checks nonblank pixels presented to the native
surface, the real Obscura DOM, and round-trip IPC.
See CI for native build results; do not infer a passing build from source alone.

Verified on Linux in [CI run 34347995911](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34347995911),
for code commit `ee4922ca8f770eba5a509a40b0e224fae6db4489`:

- Node.js protocol/API/bridge tests: 16 passed.
- Bun protocol/API/bridge tests: 16 passed.
- Rust manifest/launcher tests: 6 passed.
- TOML-only switching launched actual Node, Bun, and a compiled Rust process.
  The Rust process in this launcher test is a CLI probe, not a GUI test.
- Native host and Rust example: release build passed.
- Real Obscura native-window test: nonblank surface presentation, DOM access,
  JavaScript error propagation, renderer-to-Node round-trip IPC and window close
  passed. The IPC test also checks that a pending renderer timer cannot stall
  the host. A full GUI run of the Rust callback example and Bun GUI backend is
  not covered by this test.

Additional compatibility checks passed in [CI run 34351586089](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34351586089)
for code commit `6095fbe01aa1da8f5195931dd8de52e4242f34c9`:
Node and Bun each passed 21 tests, the Rust launcher passed its 6 tests and
three-backend launch smoke, and the Linux native smoke passed with added
synchronous identity/URL, load notification, destruction and sequential window
replacement assertions. This does not test concurrent native windows.

## Current limits

- Windows/macOS builds, real hardware input/IME, and broad application rendering
  still need independent validation. The passing Linux test uses Xvfb.
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

1. Import Electron source and history into a dedicated migration branch, keeping
   its MIT notices. Port the selected public API contracts to an engine boundary;
   its `content::WebContents` implementation cannot simply link against Obscura.
2. Replace the temporary PNG path with a raw pixel/dirty-region Obscura embedding
   API, and move page work off the GUI event loop.
3. Add isolated renderer processes, complete input/IME/accessibility, multiwindow
   lifecycle, OS integration, and cross-platform packaging.
4. Benchmark equal application workloads for memory, startup, input latency and
   rendering fidelity before making Electron/Tauri comparisons.

## Upstream

`vendor/obscura` is pinned to the user's `obscura-for-weber` repository, including
its vendored layout/font patches. `upstream/electron` is optional for the current
prototype and excluded from the runtime build. Both preserve their own licenses.
Weber's existing Apache-2.0 license remains in effect for its original code.

# Weber: Electron source with Obscura

Weber aims to run existing Electron applications with substantially lower resource
use, while preserving their developer experience and visible behavior. This branch
contains the original Electron source and ancestry. The new Linux runtime replaces
Chromium native bindings with an Obscura renderer and a GTK desktop host.

Electron's MIT license remains at the repository root; its README is
[README.electron.md](README.electron.md). Additional project licensing is under
`weber/`; individual source SPDX notices remain intact. Exact imported revisions are recorded in
[weber/UPSTREAM_REVISIONS](weber/UPSTREAM_REVISIONS).

## Executable implementation

The runtime compiles 41 Electron TypeScript source modules, including BrowserWindow, BaseWindow, WebContents, Menu, MenuItem,
Notification, powerMonitor, powerSaveBlocker, utilityProcess, ParentPort, globalShortcut, protocol,
clipboard, screen, systemPreferences, shell, safeStorage, crashReporter, contentTracing and
IPC helpers, main/utility networking and WebSocket. Two network source modules
carry scoped Weber fixes, recorded in the compiled source manifest. Their
implemented scopes differ; crash collection is still absent. A
replacement `process._linkedBinding` layer routes their native operations to a
separate GTK host. Each window has its own Obscura process. The build uses no
Chromium checkout, Content, Blink, Viz or Chromium renderer binary. Obscura and
the selected JavaScript backend still use their own JavaScript engines.

The original Chromium-dependent GN build and native Electron implementation remain
as migration reference in this source fork. Build Weber using the CMake/Cargo path
below; running the upstream GN build does not produce the replacement runtime.

[The power-inhibition lifecycle build](weber/packaging/results/95e9c87.json) passed
16 execution gates, extracted Node/Bun/native bundle checks, and the identical-app
Electron comparison. The build also runs an unmodified VS Code startup diagnostic;
that diagnostic is not a VS Code acceptance pass.

Verified paths include two independent native GTK windows with real X11 input,
menus and global shortcuts; isolated preload/contextBridge; invoke, send, reply
and renderer event listeners; native X11 clipboard/PRIMARY ownership; real monitor
geometry/cursor/system settings; and custom protocols used by document, CSS,
classic script, ES module and fetch requests. Main-process MessageChannelMain
supports queued structured data and ownership transfer between main-process ports.
Main-process ports can now move into a separate utility process and exchange
structured messages in both directions. Renderer transfers and nested utility
port transfers are still missing.

Linux notifications use the desktop D-Bus service. Power observation uses UPower,
logind and XScreenSaver; it does not add a periodic idle polling loop. Node and
Bun checks exercise the actual native transport with controlled D-Bus test peers.
Full desktop-daemon and operating-system acceptance remains separate.

Linux safeStorage now uses the real libsecret keyring, preserves Electron's sync
ciphertext and caches the derived key without recurring helper IPC or idle timers.
Electron 42.0.0, Node and Bun pass 18 cross-process read combinations using an
owned test keyring. Locked/unavailable storage fails closed. Async key migration,
KWallet and other operating systems remain unsupported.

Power-save requests now use native GNOME/freedesktop inhibition. Only effective
strength changes send IPC; queries and duplicate-strength requests add no OS
calls or recurring polling. Eighteen Node/Bun protocol scenarios verify priority,
failed-transition rollback, service loss, process death and delayed replies.
These use controlled desktop peers, not physical machine-sleep acceptance.

Download the [Linux development archive](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34464435416/artifacts/10147143811) and follow the
[packaging instructions](weber/packaging/README.md). Node/Bun executables are
external. The bundle record identifies the exact runtime commit and checksum.

## Build and run on Linux

Install Rust, Node.js 24, CMake, a C++17 compiler, pkg-config, GTK3, libpng,
XScreenSaver, libsecret-1 and fontconfig development headers, and nlohmann-json.
The CI workflow lists Ubuntu packages.

```sh
git submodule update --init --depth 1 weber/vendor/obscura
for patch in weber/patches/obscura/000*.patch; do
  git -C weber/vendor/obscura apply "$PWD/$patch"
done
cargo build --release --manifest-path weber/Cargo.toml -p weber-engine
cmake -S weber -B out/runtime -DCMAKE_BUILD_TYPE=Release -DWEBER_ENGINE_LIBRARY="$PWD/weber/target/release/libweber_engine.a"
cmake --build out/runtime --parallel 2
npm ci --prefix weber/electron-runtime
node weber/electron-runtime/build.cjs
node weber/electron-runtime/safe-storage/build.cjs
cargo build --release --manifest-path weber/runtime-config/Cargo.toml
```

Create `weber.toml` in the application's directory:

```toml
[backend]
kind = 'node'
entry = 'main.cjs'
```

Change `kind` to `'bun'` to run the same CommonJS main with Bun. Node also supports
ES modules. Native Rust applications use `kind = 'native'` and
`executable = 'target/release/my-application'`; they implement their main backend
with the [Rust API](weber/native-runtime). A JavaScript main is not automatically
translated into Rust. See the [selector documentation](weber/runtime-config/README.md)
and [native example](weber/native-example).

```sh
WEBER_UNSANDBOXED_DEVELOPMENT=1 weber/runtime-config/target/release/weber-backend run --project /path/to/app --runtime-root weber/electron-runtime
```

The explicit environment switch is required because OS sandboxing is not yet
implemented. Only run trusted development applications. It is never enabled by
the TOML selector automatically.

## Compatibility, security and performance work

The [binding scope](weber/electron-runtime/README.md) and
[VS Code compatibility matrix](weber/vscode-probe/COMPATIBILITY.md) distinguish
verified operations from missing behavior. The last full diagnostic (95e9c87) stopped at the missing `net` export.
The current source adds HTTP/HTTPS, streaming fetch, WebSocket and utility
authentication forwarding; a new whole-app diagnostic is required to identify
the next startup blocker. Workbench startup, editing,
terminal, extension hosting and full-app migration have not passed acceptance.
No compatibility percentage is claimed.

The [VS Code acceptance criteria](weber/vscode-probe/ACCEPTANCE.md) define success
in terms of the original application's editing, terminals, extensions, desktop
behavior and measured resource use. Utility-process execution is supporting
infrastructure; it is not yet a passing VS Code extension host.

The separate [Monaco diagnostic](weber/monaco-probe/README.md) runs upstream
Monaco 0.52.2 and passes construction, edits, undo, actual X11 keyboard input,
line rendering/capture and 1,000-line scrolling. Its worker-driven diff still
fails on Weber. Standalone editor success is not full VS Code acceptance.

The renderer now keeps Obscura's existing timer/network reactor alive and waits
for actual work. Idle GTK host workers also block on socket/eventfd readiness.
A frame deadline is armed only for damage or active animation. Frame delivery
keeps one pending presentation buffer, converts pixels in place, and writes
Rust-owned replies directly to the renderer socket. Concurrent IPC replies are
bounded and batched across both isolated contexts without a timer, with
document-generation validation before any reply is consumed. Queue-free small
socket replies avoid the output writer thread; ordered fallback and byte/time
bounds remain in force. Newly parsed private JSON trees are validated in place;
application-owned objects still undergo strict copying. Presentation and PNG
capture share immutable frames, with one pixel conversion and no second engine
rasterization for an unchanged capture. Unused CDP network-body retention is disabled by default;
normal page resources and application fetch results are retained as required.

The [recorded measurements](weber/benchmarks/results/README.md) include cases
where Weber is slower. The original small fixture is measured before a separate
workload with 64 simultaneous IPC calls and 2,000 row components across two
windows. Neither fixture predicts VS Code memory usage. A ratio measured in a
small application cannot be multiplied by VS Code's memory use: browser engine,
window surfaces, application DOM/JS, terminal and extension hosts have different
costs and scaling behavior.

Remaining work includes renderer MessagePorts and nested utility transfers, persistent
session storage and complete network semantics, full preload/structured-clone
behavior, general WebContentsView embedding, IME/contenteditable editing,
complete worker execution, tray, drag and drop, production installers and Windows/macOS.
Separate processes and private transport are implemented; an OS sandbox and
comprehensive origin/network policy are not. Obscura agent access should share
application page/input state with explicit application authorization.

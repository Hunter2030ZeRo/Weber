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

The runtime compiles and executes 19 original, unmodified Electron TypeScript
modules, including BrowserWindow, BaseWindow, WebContents, Menu, MenuItem and IPC helpers. A
replacement `process._linkedBinding` layer routes their native operations to a
separate GTK host. Each window has its own Obscura process. The build uses no
Chromium checkout, Content, Blink, Viz or Chromium renderer binary. Obscura and
the selected JavaScript backend still use their own JavaScript engines.

The original Chromium-dependent GN build and native Electron implementation remain
as migration reference in this source fork. Build Weber using the CMake/Cargo path
below; running the upstream GN build does not produce the replacement runtime.

[CI for commit 6688e3c](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34373027242)
passed the following actual execution checks:

- Two native GTK windows painted from Obscura raw frames, with real X11 mouse and
  keyboard input, independent DOMs, JavaScript/Promise evaluation and PNG capture.
- Original Electron API modules running the same CommonJS application under
  Node.js 24 and Bun 1.4.2, including separate preload contexts, contextBridge,
  ipcRenderer.invoke, rejection propagation and window closure.
- A Rust native application selected through project TOML, using the same native
  window/Obscura runtime without Node or Bun.
- Native V8 preload isolation and IPC checks, process transport failures, renderer
  crash containment, frame invalidation and backend argument/signal handling.

Newer commits additionally exercise TOML selection for the Node/Bun live tests,
navigation policy, IPC bounds and performance measurements. Consult their CI
results rather than treating the earlier passing commit as proof of later changes.
These checks establish a functioning development runtime, not full Electron or
VS Code compatibility.

## Build and run on Linux

Install Rust, Node.js 24, CMake, a C++17 compiler, pkg-config, GTK3 and fontconfig
development headers, and nlohmann-json. The CI workflow lists Ubuntu packages.

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

The current binding subset is documented in
[weber/electron-runtime/README.md](weber/electron-runtime/README.md). GTK menu
integration reuses Electron's template ordering, checkbox/radio policy and click
dispatch, with native accelerators and window ownership. Its native input check
must pass on the corresponding commit before it is considered verified. Popup
menus, icons, sublabels and several built-in roles remain unsupported. Tray,
clipboard, drag and drop, sessions, MessagePorts, extension hosting, installers,
Windows/macOS support and full navigation/IME behavior still need implementation.
Preload exposes copied JSON data and asynchronous function proxies; it does not
yet provide Electron's complete preload/structured-clone contract. Separate
renderer processes and private transport are implemented; a production OS sandbox
and comprehensive origin/network policy are not.

The [comparison harness](weber/benchmarks/README.md) runs identical application
files in pinned Electron and Weber, records all descendant processes' PSS/RSS,
startup, IPC, DOM/capture and idle CPU, and preserves results even when Weber is
slower. This small unsandboxed Linux fixture cannot establish VS Code performance.
The [VS Code probe](weber/vscode-probe/README.md) runs an unmodified official app
entry and records its first startup blocker; diagnostic completion is explicitly
not a VS Code acceptance pass. Neither a compatibility percentage nor a general
performance advantage is currently claimed.

The next compatibility target is a functioning VS Code workbench, followed by
editing, terminal, extension host, multiwindow and desktop integrations. Obscura's
agent capabilities should use the same page state and input paths, with explicit
application authorization rather than a separate uncontrolled browser endpoint.

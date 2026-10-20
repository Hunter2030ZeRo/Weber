# Weber

<p align="center">
  <img alt="Weber logo" src="logo.png">
</p>

Current priority: Servo/SpiderMonkey JIT beta and performance. Further Static
Hermes integration is deferred; the existing AOT path remains experimental.

Beta foundation and AOT performance gate: [delivery plan](docs/beta-plan.md).
Default builds are JIT-only; use `--features aot` for the existing native AOT path.
[Window lifetime / backend subscriptions / layer probe](docs/native-runtime.md).
[Compiled/native validation](docs/beta-foundation-validation.md).
[Window controls, state snapshots and resource validation](docs/platform-validation.md).
[App storage and Notes template](docs/app-storage.md).
[JIT CPU tuning and foundation validation](docs/foundation-validation.md).
[Local npm SDK/runtime distribution and installation](docs/npm-distribution.md).

Current development/build interface: [Vite and npm workflow, SDK 0.3](docs/vite-workflow.md).
Node-oriented backend code has an [optional Bun connection](docs/bun-backend.md),
shared by JIT and AOT UI apps. [Backend validation](docs/bun-backend-validation.md).
JIT and native AOT are separate build choices; Node runs development tools and is
not required by the packaged UI. [Workflow validation](docs/vite-workflow-validation.md).

JIT is the default general-purpose path. Native AOT is an optional optimization
track for startup/memory-sensitive applications, including a downstream desktop
environment; its cross-platform port must not block JIT platform support.
The default host build excludes Hermes and Weber's AOT bridge. The `aot` feature
explicitly includes them; JIT-only application output and a JIT-only host build
are distinct supported choices.

Binding implementation and preceding measured performance: [native byte bindings](docs/binary-dom-validation.md). Startup and memory goals remain unmet. The [beta foundation comparison](docs/beta-foundation-validation.md) measures the current Hermes-free JIT baseline; AOT remains slower and larger on that workload.

Cross-platform GUI framework in development, currently implemented and tested on
Linux Wayland: Rust + winit + Servo 0.7.0, with a Vite +
SolidJS + TypeScript application, with an optional experimental Static Hermes
native AOT path.
No Electron or Chromium runtime dependency.
The previous Electron tree was deleted at the user's explicit request.

The [experimental Weber SDK 0.2](docs/framework.md) adds reusable JS/TS application
entries, strict checks, native AOT modules, a build/run/package CLI and relocatable
user applications. It also binds inline CSS to Servo and removes redundant DOM
metadata/JSON conversions. See [framework validation](docs/framework-validation.md)
for the current evidence and limits; the older standalone milestone below is a
preserved baseline rather than the latest source revision.

The [complete standalone AOT desktop milestone](docs/standalone-plan.md)
[passed its validation](docs/standalone-validation.md). Its
[optimized comparison](docs/performance.md) currently shows higher memory use
and slower startup for AOT, with similar input/presentation timings.
The [fixed 2025-01 UI compatibility profile](docs/compatibility-target.md)
has 17 original WPT files and required application scenarios locked by hash
in `compatibility/`. `node scripts/profile-smoke.mjs` runs both actual Wayland
Servo and native Hermes AOT, writing `artifacts/compatibility-profile.json`.
The profile [passed its fixed completion gate](docs/profile-validation.md): 1,474
selected WPT subtests on each engine and 15 required scenarios. The runner exits
unsuccessfully if a later change introduces a failure or missing scenario.

## Runtime contract

- **Implemented baseline:** Servo's existing SpiderMonkey JavaScript engine.
- **Native AOT path:** Static Hermes compiles the DOM/application sources and
  pinned selector/CSS libraries into two core native objects
  linked into the host. A persistent Hermes runtime calls this logic through JSI.
  The default embedded desktop runs both its shell/navigation and application
  UI in this path, including signals, Show, keyed For, input, timers/rAF and
  disposal. `--web` runs the identical component in SpiderMonkey for comparison
  without initializing a Hermes heap. Generic DOM glue remains in SpiderMonkey.
  See [standalone validation](docs/standalone-validation.md).
  The compatibility runner additionally links original WPT as separate native
  units. See [live renderer reads, events and asynchronous APIs](docs/live-dom.md).
- **Experimental DOM binding:** AOT code creates a mounted subtree, updates text
  and attributes, receives click/input callbacks, and releases nodes/listeners.
  See [DOM binding API and evidence](docs/dom-binding.md). Servo DOM runs in SpiderMonkey.
  The [browser-shaped compatibility layer](docs/native-solid.md) adds document/Node/
  Element/Text objects, selectors, inline CSS, MutationObserver, tree mutation
  HTML parsing/templates/cloning, live collections and EventTarget semantics.
  A synchronous Servo extension returns native event cancellation before default
  actions. See [current validation and gaps](docs/native-solid.md).
  This is not a replacement of Servo's JavaScript engine or a complete Hermes DOM.
- **Optional compatibility path:** Bun for applications requiring Node.js APIs.
  The [backend connection](docs/bun-backend.md) uses an app-owned process and
  asynchronous bounded calls over private pipes. It is not required by apps
  without a backend, and it does not replace Servo's DOM engine. No zero-IPC
  or complete Node/Electron compatibility result is claimed.

## Build and run

Linux prerequisites: Rust/Cargo, C/C++ compiler, CMake, pkg-config, Python 3,
fontconfig/freetype, X11/Wayland and OpenGL development libraries, Node and pnpm.
The initial build is substantial because it compiles Servo and its dependencies.

```sh
bash scripts/bootstrap.sh
bash scripts/run.sh
```

The launcher opens the embedded demo without a development server. The optional
AOT-enabled build uses the existing native AOT demo path. `target/debug/weber-servo --web` opens the comparison desktop. To work
on the older development demonstration, alternatively
run `pnpm --dir app run dev` and `cargo run --locked -- http://127.0.0.1:5173` in
separate terminals. Vite and Node are build/development tools, not runtime
dependencies of the packaged desktop.

Build a relocatable Linux bundle with `cargo build --release --offline` then
`python3 scripts/package.py --profile release`. Run `target/package/weber/weber`.
An alternate target directory can be passed through `--binary`; this workspace's
optimized bundle is `target/package/weber-release/weber`. System glibc,
Wayland/EGL/GPU drivers and fonts remain prerequisites. No host installation is
performed. This is not a universal Linux binary.

Servo source is pinned to `aac43a3f31a259f04a574f5ec4e959c943ad7cc7` (v0.7.0).
`Cargo.lock` and `app/pnpm-lock.yaml` pin resolved dependencies. The `vendor/`
checkout and build outputs are excluded from the new repository. Bootstrap applies
the tracked observer, synchronous-host and time-origin patches in `patches/`. Its Rust embedding
API and the documented local extension are used directly, without inventing a C ABI.

## Verification

```sh
pnpm --dir app run build
cargo build --locked
cargo clippy --locked --no-deps -- -D warnings
cargo fmt --check --package weber-servo
target/debug/weber-servo --aot-self-test
target/debug/weber-servo --browser-contract-self-test
target/debug/weber-servo --solid-self-test
target/debug/weber-servo --scheduler-self-test
target/debug/weber-servo --lifetime-self-test
node scripts/standalone-smoke.mjs target/package/weber-release
node scripts/desktop-stress.mjs target/package/weber-release/weber
node scripts/desktop-input.mjs target/package/weber-release/weber
node scripts/desktop-benchmark.mjs target/package/weber-release/weber
node scripts/wayland-smoke.mjs
WEBER_DOM_TEST=1 node scripts/wayland-smoke.mjs
WEBER_BROWSER_TEST=1 node scripts/wayland-smoke.mjs
WEBER_SOLID_TEST=1 node scripts/wayland-smoke.mjs
target/hermes/bin/shermes -O -Xes6-block-scoping -exec aot/dom.js aot/dom.test.js
```

The current smoke test requires an active Wayland session. It unsets DISPLAY,
runs native AOT state tests, and checks programmatic DOM/AOT round trips.
Browser mode also executes 30 common contracts against the actual Servo DOM and
checks observer microtask ordering; the separate native entrypoint executes them
as Static Hermes AOT code.
Solid mode tests synchronous native default-action cancellation and a real
Solid TSX component compiled into the native AOT application unit, including actual
Servo timeout/interval/rAF delivery, pause/resume, microtasks and task disposal.
The older `native-smoke.mjs` is historical X11 baseline evidence and is not
compatible with the Wayland-only host.

Historical baseline test description:
Set `XDOTOOL` if it is not on PATH. It sends XTest mouse and keyboard events into
the real winit window; it does not invoke DOM `.click()` or set the input value
through injected JavaScript. DOM state is observed through the page title, which
Servo forwards to the native window. Screenshots and results go to `artifacts/`.
Software OpenGL under Xvfb is functional evidence, not a hardware performance
benchmark or a Wayland/macOS/Windows validation.

The test compiles a tiny X11 helper to send `WM_DELETE_WINDOW` directly; no window
manager is needed. The default test port is 5187 (`WEBER_TEST_PORT` overrides it).
Run tests sequentially because the evidence filenames are shared.

## Boundaries

The host owns one Servo instance and a set of native windows/WebViews. It sleeps on the event loop and wakes
on Servo notifications. Native events feed `WebView::notify_input_event`, frame
notifications request redraw, and redraw calls `paint()` and `present()`.
The demonstration covers click, text editing, scroll, CSS animation and rAF.
Key handling currently covers text and common editing/navigation keys; complete
physical-key codes/location and modifiers are forwarded. Complete shortcut
coverage, clipboard, dialogs and accessibility remain future work. The initial
window SDK adds same-app windows, title/list/close and independent lifetime. Media/WebGPU/
WebXR are not enabled in this minimal build.

The current target is Linux Wayland only. Measurements must identify the build,
display, workload and method; AOT is not assumed to use less memory or start
faster. Interactive desktop tests require an unlocked session. Automated tests
can use `dbus-run-session -- node scripts/headless-wayland.mjs SCRIPT [ARGS]`,
which creates and removes a separate GNOME Wayland compositor/configuration and
reports its virtual monitor separately from the user's desktop.
See [Wayland/AOT integration](docs/wayland-aot.md) for current boundaries and
[architecture](docs/architecture.md) for the original validation gates and
[validation](docs/validation.md) for the measured outcome of this run.

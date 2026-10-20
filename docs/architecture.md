# Architecture and evidence boundaries

This is the original baseline plan. Weber targets Linux, Windows and macOS;
the current native implementation and validation are Linux Wayland only.
See the [next Hermes-only DOM milestone](hermes-native-dom-plan.md) for the new
engine-port boundary and platform-specific work. In the existing implementation,
native Hermes AOT and a mounted two-engine DOM layer have since been compiled
and tested. See [current integration](wayland-aot.md), [DOM contracts](browser-dom.md)
and [platform work and remaining gaps](browser-platform.md).

## Baseline vertical slice

Vite compiles TSX to standard JavaScript; SolidJS creates normal DOM nodes. A
winit native window owns Servo's `WindowRenderingContext`. `ServoBuilder` creates
the engine; `WebViewBuilder` attaches the URL and delegate. The engine executes
JavaScript with SpiderMonkey. Rust does not render a screenshot or launch an
external browser.

Verified source API at pinned Servo revision:

- `components/servo/lib.rs`: public embedding sequence and re-exports.
- `components/servo/examples/winit_minimal.rs`: upstream window/context example.
- `components/servo/webview.rs`: `notify_input_event`, `resize`,
  `set_hidpi_scale_factor`, `set_focused`, `evaluate_javascript`.
- `components/servo/webview_delegate.rs`: frame/title/load callbacks and IME UI.
- `components/shared/embedder/input_events.rs`: native input structures.
- `components/servo/user_content_manager.rs`: script/style injection.

`evaluate_javascript` is asynchronous source evaluation in SpiderMonkey, not a
Hermes bridge. The public user-content manager exposes script/style insertion;
it does not provide a JavaScript engine replacement interface. An arbitrary
Rust function binding and Hermes object ownership cannot be inferred from those
APIs. The script/DOM implementation is coupled to SpiderMonkey bindings.

## Required AOT track, separate from DOM work

1. Pin a Static Hermes revision; build `shermes`. Compile a small application to
   a native executable, execute it, and record compiler/runtime revisions,
   binary linkage, startup, RSS and output. Require native code, not `.hbc`.
2. Prove Rust/native host calls, callback lifetime, asynchronous work and
   exceptions without DOM. Use the same host contract for applications and shell
   components. Do not restrict AOT to the shell.
3. Independently prototype one DOM creation, one text update, one event callback,
   and disposal through a Hermes/Servo bridge. Verify rooting, cycles, thread
   ownership, microtasks, promises and failure propagation before selecting an
   architecture. A source-evaluation proxy into SpiderMonkey must be labeled as
   a two-engine experiment, not native Hermes DOM execution.
4. Only after these results choose between a maintained engine abstraction/fork
   and an explicit bridge. Neither zero IPC nor equivalent web compatibility is
   assumed. Bun remains optional for Node ecosystem compatibility.

## Portability and performance gates

- Linux: first X11 software-rendered smoke, then real Wayland + GPU and IME tests.
- Windows: MSVC toolchain, native event loop, resize/DPI, keyboard/IME, clean exit.
- macOS: main-thread Cocoa window, backing scale, keyboard/IME, packaging/signing.
- Release measurements: process-tree RSS/PSS, cold/warm startup to first rendered
  frame, idle CPU, input-to-paint latency, frame-time distribution under load.
- Compare the same app and hardware against Electron/Tauri only after collecting
  equivalent release builds. Do not interpret this debug run as a performance win.
- Web standards: the interaction demo is a small compatibility probe; add WPT and
  representative application workloads rather than claiming universal coverage.

## Primary sources

- [Pinned Servo minimal example](https://github.com/servo/servo/blob/aac43a3f31a259f04a574f5ec4e959c943ad7cc7/components/servo/examples/winit_minimal.rs)
- [Servo embedding overview](https://book.servo.org/embedding/overview.html)
- [Static Hermes source](https://github.com/facebook/hermes/tree/static_h)
- [Static Hermes discussion](https://github.com/facebook/hermes/discussions/1137)

The milestone list above records the original validation gates. Current AOT and
mounted DOM evidence is in the linked documents; shared-heap Hermes/Servo DOM,
full web compatibility and release performance are not established.

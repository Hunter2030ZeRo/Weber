# Large application porting — Weber development direction

Source audit: 2026-11-09. This is a framework development plan and a bounded
compatibility workload, **not a completed VS Code or Electron port**.

The current priority is Weber as a general application framework. Further
Simulacrum feature work is deferred. Hyprland/layer-shell remains an optional
downstream integration; ordinary applications must not acquire that dependency.
Keep Servo/SpiderMonkey JIT as the UI runtime and keep Static Hermes off this
development path. Preserve Windows/macOS as framework targets without claiming
their native hosts are implemented.

## The porting boundary

VS Code separates its browser workbench from native application services and
extension hosts. Its local/remote extension hosts run Node.js; its web extension
host runs in a browser Worker. Supporting a browser workbench therefore does not
establish desktop extension compatibility. Microsoft's sandbox migration also
describes moving Node work out of the renderer and using message ports for IPC.

Use these existing boundaries when investigating a Code-OSS source port:

1. Servo renders the existing HTML/CSS/JS workbench. Do not rewrite an imitation
   editor and count it as a VS Code port.
2. A separate adapter implements the application's platform services against
   Weber. Keep this outside the general UI API; do not present an incomplete
   `electron` module as drop-in compatibility.
3. File, process, terminal and extension services live outside the DOM realm.
   Bun remains an optional backend. A Node-based extension-host adapter is a
   possible compatibility route to evaluate against actual dependencies, not
   a new mandatory UI runtime or a claim that Bun runs all extensions.

The current Rust host and Servo are in the same process. A capability token and
an app-owned Bun child do not provide renderer process sandboxing or recovery.
These remain separate framework requirements.

## Current gaps from the checked-out source

| Area | Current implementation | Work required for a large editor |
| --- | --- | --- |
| Frontend toolchain | Vite, TS and ordinary DOM frameworks; SDK forces one IIFE UI entry and owns Rollup input/output | Explicit ESM/multiple-chunk contract, workers and module resource resolution; test dev and packaged paths separately |
| Packaged resources | `src/assets.rs` validates and reads every asset during startup; each response clones its bytes; 16 MiB/file, 64 MiB total, 1,024 entries | Measured lazy resource loading with integrity/path guarantees, bounded caching and representative cold-start tests; raising quotas alone is insufficient |
| Browser primitives | Servo implementation exists, but the old selected profile excludes workers and broader browser APIs | Actual behavior tests for workers, transferable buffers/ports, modules, Wasm, storage, text geometry and editor dependencies |
| Backend transport | `sdk/backend.ts` / `src/backend.rs`: named JSON calls, subscriptions, bounded queues; invokes poll only while pending | Versioned binary/streaming transport, backpressure, ownership, cancellation and per-window teardown; browser MessageChannel passing is not native IPC support |
| Workspace files | Portal-selected UTF-8 files up to 256 KiB, JSON app store | Folder/workspace handles, binary/large files, directory operations, atomic writes, external watching and error/recovery semantics |
| Developer processes | One packaged Bun backend with named exports; its code can use process APIs | Public app-owned process service, stdin/stdout/stderr streams, cancellation/lifetime; PTY and LSP/debugger integration |
| Extension ecosystem | No VS Code extension host/API adapter or extension packaging acceptance | Distinguish web extensions from Node extensions, native addons and V8/Electron-specific dependencies; test representative real extensions |
| Reliability/platforms | Linux/Wayland alpha; no renderer recovery or accessibility certification | Failure containment, accessibility, focus/IME, output scaling, and Windows/macOS graphics/input/system/package implementations |

These are source findings, not fresh certification of older alpha features.
In particular, a successful small DOM demo or a static feature-presence check
does not establish Monaco or full workbench compatibility.

## Implementation sequence and acceptance

### 1. Renderer primitives and real Monaco workload

First run the fixed `weber-large-app-primitives-v1` workload in actual native
Servo windows at both an HTTP control origin and the packaged app origin.
Every required case must execute; missing results, exceptions, timeouts and
engine panics fail the strict gate. A baseline report may record failures but
must retain `passed: false`.

Then pin a published Monaco version and its dependency lock before adding the
actual editor workload. Require actual text entry and Hangul composition,
selection, undo/redo, scrolling, search, resize and JS/TS worker diagnostics.
Test both Vite development and relocated packages. Record startup, process-tree
memory, idle/typing CPU and repeated editor/worker disposal on the same workload.
No Monaco integration has been built or certified by the primitive test alone.

### 2. General workspace and transport services

Design the binary/streaming boundary before implementing it. Keep ordinary JS/TS
SDK calls simple and retain the existing JSON API for small values. Define size
budgets, backpressure, cancellation, ownership and shutdown behavior rather than
silently base64-encoding large files through the old call path.

Build a small real workspace workload with binary file roundtrips, directory
watching, atomic saves, external edits, process streams and a PTY. Demonstrate
LSP traffic and cancellation without blocking UI input. This is general Weber
functionality, not a mandatory IDE API for every application.

### 3. Fixed Code-OSS source-port experiment

Pin a Code-OSS commit only after the Monaco gate is usable. Identify each
platform-service adapter from that exact source tree. Require the real workbench
to open a local workspace, edit/save files, run a terminal and load a selected
extension. Report web and Node extension results separately. Do not equate a
remote web workbench or an editor-shaped test application with a desktop port.

This stage is an experiment to identify remaining framework gaps; it is not a
promise that an unmodified Electron binary can run in Weber.

## Primitive workload reproduction

The workload uses the checkout SDK and the existing pinned Vite/TS installation
in `app/node_modules`. It adds no browser API shim or external editor dependency.
It is independent of the previous dated WPT/AOT profile, which remains unchanged.

```sh
node scripts/large-app-workflow.mjs
cargo build --release --locked --features layer-shell --target-dir target/optimized --offline
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/large-app-native.mjs
```

Use `--record-baseline` on the final script only when deliberately recording an
incomplete/failed baseline. That mode does not turn the report green. The strict
default exits nonzero if any origin/case fails. The runner uses only its newly
created private GNOME/Wayland display and bus, with no host desktop input.

The profile and SHA-256 are under `compatibility/large-app/`; generated fixture,
manifest resource types and native results are in `artifacts/large-app/`.
The checks cover selected behavior: a 32 KiB buffer detach/roundtrip, port
ownership/close, worker messaging, module imports, an empty Wasm module,
IndexedDB transaction/binary roundtrip, Canvas 2D, live Range geometry and
ResizeObserver. They do not measure native IPC copying or certify arbitrary
Wasm modules, persistent database lifetime, rich editing or physical input.

## First increment: built and measured

2026-11-09, Linux x64, actual native Servo windows inside a newly owned headless
GNOME/Wayland session. Checkout SDK with Vite 7.1.12 / TypeScript 5.9.3; release
host built with `--locked --features layer-shell --offline`, no Hermes runtime.
This is a source increment, not a newly published npm release.

- Servo revision: `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`.
- Final source/build fingerprint: `de0919789bcb0d4cdfcb651decdcd07141706b300dad01670d694aede978518c`.
- Locked profile hash: `09e44afc18c06be6783d0be07e8abf03155b65762032c97aaa226ca9c0e04dec`.
- The final build fingerprint matches the checked-out source. The ordered Servo
  patches also apply to pristine pinned sources and reproduce the build tree.
- `artifacts/large-app/native.json` retains **`passed: false`** and the strict
  command exits 1. Both origins completed every case: **11/13 pass** each.

Implemented and verified:

1. `servo-message-port-lifetime.patch` makes closing an already detached port
   harmless. The sending object no longer belongs to its former global after
   transfer. The regression closes that sender repeatedly and verifies the new
   owner still receives messages. It also covers repeated cleanup and worker
   port transfer/echo.
2. The SDK now emits JavaScript MIME for `.mjs` and `application/wasm` for
   `.wasm`. Packaged dynamic/module-worker imports and Wasm streaming execute
   with those actual manifest types, using the same bytes as the HTTP control.

The existing unmodified runtime (`a2a7b1f8f9a04f1f37e10a1b58cafeb130f55301611c07ed8ae73b011cf6e50e`)
was rerun against the **same final profile and fixture**. Both origins panic at
`transferred-port-close`; later cases do not execute. That negative control is
preserved in `artifacts/large-app/before.json` and `before-*.log/jsonl`. It is not
reported as a completed compatibility run.

Passing cases: MessageChannel, 32 KiB buffer transfer/detach, transferred-port
close/ownership, classic Worker, Worker port transfer, module Worker with an
import, dynamic import, Wasm instantiation/streaming, Canvas text/pixels and
ResizeObserver delivery. These results do not certify native binary IPC.

Remaining failures, retained as requirements:

| Case | Observed result | Next implementation boundary |
| --- | --- | --- |
| `indexeddb-binary` | `indexedDB` is undefined on both origins; Servo's `dom_indexeddb_enabled` default is false | Design/test per-app origin and storage-directory isolation, persistence, deletion and upgrades before enabling it. The packaged document currently reports origin `null`; do not assume a stable durable origin. |
| `range-geometry` | Selected text reports zero bounds and no fragments while its containing element has real bounds `(20,20,100,23.27)` | Implement text-range layout queries using real text fragments, UTF-16 offsets and shaped glyph/line positions; test wrapping, bidi, transforms and scroll. Do not substitute a parent element's box. |

Source inspection explains the Range failure: `Range::client_rects` currently
asks for node border boxes and notes partial-text handling as a FIXME;
`Fragment::cumulative_box_area_rect` excludes `Fragment::Text`. This is a renderer
implementation gap, not evidence of a working rich-editor selection API.
Monaco, Code-OSS, extension hosts, PTY/workspace services and resource advantages
have not been implemented or measured by this increment.

## Primary references

- [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [VS Code web extensions](https://code.visualstudio.com/api/extension-guides/web-extensions)
- [VS Code process sandbox migration](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [Monaco ESM integration](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)
- [Code-OSS native service boundary](https://github.com/microsoft/vscode/blob/main/src/vs/platform/native/common/native.ts)
- [HTML MessagePort lifecycle](https://html.spec.whatwg.org/multipage/web-messaging.html#dom-messageport-close)

These links explain the architecture under investigation. Moving upstream
branches are not the locked source target for a completed port.

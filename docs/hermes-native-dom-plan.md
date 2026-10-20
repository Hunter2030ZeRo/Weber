# Next engine milestone: Hermes-only DOM execution

Deferred as of 2026-10-20 at the user's direction. Beta work now prioritizes
Servo/SpiderMonkey JIT, compatibility and CPU/startup/memory optimization. This
retained proposal is not the active next milestone. Revisit further Static Hermes
integration when upstream/integration changes justify a fresh feasibility and
performance review; no future benefit is assumed.

Status: implementation plan, not a compiled engine port. The existing JIT and
two-engine AOT paths remain the working baselines. This document retains a proposed
prototype boundary after the SDK 0.3 Vite workflow; it is currently deferred.

## Shared framework and platform boundary

Weber targets Linux, Windows and macOS. Linux Wayland is the first native
validation environment. A desktop environment using Weber is downstream work;
Hyprland/compositor APIs must not become prerequisites of the common app runtime.

JIT is the default general-purpose runtime. Static Hermes native AOT is an optional
optimization for startup/memory-sensitive applications, including the unnamed
downstream desktop environment. Supporting this optional path remains a project
goal; it is not mandatory for every application or every initial platform release.
The next Hermes DOM milestone starts on Linux and does not require Windows/macOS
AOT support first. Its intended benefit must be measured, not assumed.

Platform support should allow a JIT-only host build without Hermes or the AOT
compiler. That build separation is implemented in the beta foundation: the default Cargo
build excludes the Hermes runtime/compiler and Weber's CXX bridge. The `aot`
feature enables the existing AOT build, loader and dispatch paths. See
[native runtime](native-runtime.md). This removes that build dependency from
future Windows/macOS JIT work; those platforms still require their own ports. Each target still needs a native Weber
host and platform package; projects should eventually consume prebuilt hosts,
without rebuilding Servo for every application. The TS/JS app bundle remains
shared where platform APIs/assets permit, while native AOT units are target-specific.

Common layers: application TS/TSX, Solid integration, Vite/npm commands, DOM/WebIDL
semantics and the Hermes native binding/ownership model. Native AOT units are
built for each target OS, architecture and compatible runtime ABI; Linux ELF
units are not portable application binaries for Windows or macOS.

Currently platform-specific code verified in the checkout:

- `src/main.rs` imports the Wayland event-loop extension and forces `.with_wayland()`.
  Window/event-loop selection needs target-specific dispatch.
- `src/host.rs` uses the common raw-window-handle/Servo WindowRenderingContext
  interface. Pinned Servo delegates context/surface creation to surfman. Reuse
  the appropriate backend and verify it; changing to Metal or Direct3D is not an
  automatic consequence of selecting the target OS.
- `src/input.rs` maps winit input/IME events into Servo. Composition sequencing,
  candidate rectangle, shortcuts, scrolling, focus and scaling need native OS tests.
- `native/hermes.cpp` uses dlfcn directly. Windows needs a DLL loader/symbol lookup
  implementation; macOS can retain the POSIX loading API but needs its library
  layout/linking rules. Preserve runtime-before-unit-unload ordering everywhere.
- `sdk/build.mjs` invokes Linux shared-library compiler/linker options and writes
  `app.so`; `src/assets.rs` currently accepts that native-unit filename only.
  Unit format, exports, extension, ABI target identification and search paths
  need platform-specific contracts.
- `scripts/package.py` uses ldd/patchelf and ELF paths. Windows executable/DLL
  packaging and macOS app-bundle/library/signing/distribution handling are new work.

Upstream Servo has Windows/macOS build instructions; this does not establish
that Weber's pinned, patched engines or AOT loader compile on those systems.

## Verified engine coupling

`components/script_bindings/reflector.rs` owns SpiderMonkey JSObject/Heap pointers
and traces through JSTracer. `root.rs` and generated WebIDL/conversion code also
depend on SpiderMonkey. The public WebView API is not an engine-neutral DOM API.

The current `src/host.rs` query scope, byte transport and `src/dom_adapter.js`
still rely on Servo's SpiderMonkey-side Window/DOM binding machinery. Replacing
the wire format or disabling JIT does not make this a Hermes-only execution path.

## Implementation sequence and gates

1. **Extract the native DOM boundary and ownership contract.** Inventory script
   realm/thread/GC dependencies; specify an opaque handle and a native root set
   that retain real Servo nodes and maintain wrapper identity, listener closures,
   expandos and detached subtree reachability. Choose how Hermes runs with the
   script-thread lifecycle before exposing node calls. Raw DOM pointers must not
   be passed to the host thread as a substitute for ownership or synchronization.
   A registry disconnected from actual Servo nodes is not completion of this gate.
2. **Compile the smallest real native path.** Bind Document, Node, Element and
   Text creation/insertion/removal/text mutation directly to Servo implementations;
   add Hermes wrapper finalization/tracing and one native event callback. The
   prototype must present the resulting DOM in the actual Servo native window
   while no SpiderMonkey runtime is initialized. A separate synthetic DOM or a
   JavaScript adapter still running in SpiderMonkey does not pass.
3. **Extend binding semantics.** Implement the required WebIDL conversions,
   exceptions/prototypes, Attr/collections, event dispatch/cancellation/reentrancy,
   microtask checkpoints, promises, timers and animation-frame lifecycle. Expand
   from the native node prototype to the existing Solid app and locked browser
   compatibility tests. Remove duplicated topology/Attr state only when native
   ownership preserves retained detached nodes and wrapper identity.
4. **Validate and compare.** Run GC/cycle/detach/reinsert/listener/remount stress,
   the selected WPT profile and actual Wayland interactions. Compare equivalent
   optimized apps for startup, sampled and settled memory, idle CPU and latency.
   Keep SpiderMonkey JIT as an independent selectable baseline. Verify that
   Hermes-only mode initializes no SpiderMonkey runtime and invokes no
   SpiderMonkey DOM bindings. A Hermes-only link/build without mozjs dependencies
   is a separate, stronger evidence gate; a dual-backend binary can still contain
   the JIT backend even when its Hermes path does not use it.

Each gate requires compiled code and native test evidence before being marked
complete. The first success is a small actual Servo DOM vertical slice, not an
assertion of full browser compatibility or a finished engine replacement.

Existing evidence: [native binding boundaries](binary-dom-bindings.md),
[binding validation](binary-dom-validation.md),
[Vite workflow validation](vite-workflow-validation.md).

Platform sources: [Servo Windows build](https://book.servo.org/building/windows.html),
[Servo macOS build](https://book.servo.org/building/macos.html),
[Windows runtime DLL loading](https://learn.microsoft.com/en-us/windows/win32/dlls/using-run-time-dynamic-linking).

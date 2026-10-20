# Wayland and Static Hermes integration

The current host explicitly selects Wayland and builds winit without its X11
feature. The earlier X11 evidence is historical. Windows/macOS targets are no
longer part of this implementation.

Static Hermes is pinned to `17b37301da5da4a2cd55d78f9697c46c0fd96123`.
`bash scripts/build-aot.sh` builds shermes and its runtime plus the platform library
bundle. Cargo compiles the platform bundle and combined `aot/` application/DOM
sources into the exported `weber_platform` and `weber_logic` native units, with
`-O -Xes6-block-scoping -c`. The platform unit also uses `-Wc,-O0` for development
build speed. Both ELF objects are linked into Weber. The runtime enables matching
ES6 block scoping. Hermes runtime libraries currently use build-tree rpaths;
distribution packaging is not implemented.
Cargo tracks the AOT sources and platform lockfile/builder. Application sources
are recompiled when changed; an unchanged platform bundle reuses its native object.

The host creates a persistent Hermes runtime and initializes the exported native
units. CXX checks Rust/C++ signatures and converts C++ exceptions to Rust errors.
JSI invokes the AOT function; there is no runtime source evaluation in Hermes.
The integration is same-process, with separate Hermes and SpiderMonkey heaps.

The DOM experiment has this path:

1. A DOM link activation requests `weber://increment`.
2. The Servo delegate denies navigation and calls the AOT counter function.
3. Rust sends its integer result with Servo's asynchronous `evaluate_javascript`.
4. A DOM CustomEvent updates a SolidJS signal and the rendered counter/title.

This proves only a narrow action/value bridge. It does not bind arbitrary DOM
objects to Hermes, share garbage-collected objects between engines, implement
Hermes event listeners directly inside Servo, or replace SpiderMonkey. No zero
copy or general web compatibility claim is made. Further DOM work needs typed
commands, stable node handles, lifetime/disposal rules and callback scheduling.
The channel has since been extended with a mounted DOM subset; see
[DOM binding API, ownership and validation](dom-binding.md).
The [browser layer](browser-dom.md) and [current platform extension](browser-platform.md)
add mounted document objects, events, selectors, inline CSS and observers. The
Servo checkout now includes a tracked observer patch; the initial action/value
bridge described above is historical evidence, not the full current interface.

`--aot-self-test` exercises persistent AOT state through 1000 increments and a
second independent runtime. `scripts/wayland-smoke.mjs` launches the real Wayland
window with DISPLAY unset, drives programmatic DOM activation, and requires
three AOT results in the page title and clean native exit. This does not establish
physical Wayland keyboard/mouse behavior, IME, release performance, arbitrary
DOM mutation coverage or memory safety of upstream native libraries.

The original build/validation notes in `docs/validation.md` describe the earlier
SpiderMonkey/X11 baseline, not validation of this new integration.

## Observed results, 2026-10-19

- Static Hermes Release compiler/runtime build: passed.
- `logic.o`: ELF x86-64 relocatable, exported `sh_export_weber_logic` verified.
- Wayland/AOT host build: passed.
- Native AOT state: 1000 increments and independent runtime reset passed.
- Real Wayland session with DISPLAY unset: three DOM/AOT round trips passed;
  page title and captured screen both show `AOT count: 3`; native close exit 0.
- Invalid Wayland socket with DISPLAY still available: exited 1 with
  `Could not find wayland compositor`, confirming no X11 fallback.
- Strict TypeScript check and Vite build: passed.
- Host Clippy with `--no-deps -- -D warnings` and Rust formatting: passed;
  upstream Servo/Hermes warnings remain visible in build logs.
- [Machine-readable result](../artifacts/wayland-aot.json),
  [rendered Servo output](../artifacts/wayland-aot.png).

Physical Wayland input remains unverified in this run. The DOM action in the
test is activated programmatically. Existing Servo storage/profiler warnings
remain in `artifacts/wayland-native.log`. The CXX foreign declarations are the
only Rust unsafe boundary; this run does not provide Miri proof for native C++.

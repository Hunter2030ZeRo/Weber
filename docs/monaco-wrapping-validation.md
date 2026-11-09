# Actual Monaco and emergency text wrapping

Linux x64 source increment, 2026-11-09. Final native regressions: **all seven suites passed**, strict exits 0.
This is a real Monaco workload in Weber/Servo, not a VS Code or Electron port.

## Implemented

`servo-overflow-wrap.patch` adds emergency line breaking to Servo's existing
text layout. ICU grapheme boundaries select views into the same shaped glyph
buffer; glyphs and DOM text are not copied into another renderer. The normal
word-breaking path remains intact. `overflow-wrap:anywhere` participates in
min-content sizing; `break-word` keeps the original min-content size. `nowrap`
suppresses emergency wrapping. Text cursors advance through each segment once,
without rescanning its prefix for every word.

The locked original Range workload is unchanged. A separate wrapping fixture
covers long words, normal/nowrap overflow, fitting words, combining/ZWJ clusters,
RTL, inline boundaries, min-content differences, zero-width containers and resize.
This is selected CSS behavior, not full CSS Text conformance, all shaping/ligature
boundaries, float-constrained lines or every script/writing mode. The implementation
follows the [CSS Text overflow wrapping contract](https://drafts.csswg.org/css-text-3/#overflow-wrap-property).

`compatibility/monaco` pins **Monaco 0.57.0**, Vite 7.1.12 and TypeScript 5.9.3
with a committed npm lock. The actual package identifies Monaco commit
`d61824269f1377111d34306e4a47172327777083` and Code-OSS source reference
`6a598d4a13031703d483d103c1d934a36ad27971`. No Monaco dependency is added to
ordinary Weber applications. The package source and worker bundles are unmodified.

The normal checkout SDK builds its UI entry, CSS and dedicated editor/TypeScript
workers. The UI remains an IIFE and workers use Vite's ES worker output; this does
not add a general multi-entry ESM contract to the SDK. The native runner compares
identical built bytes over HTTP and a relocated packaged app, and separately runs
the live Vite development server through checkout SDK bindings. TypeScript's
language definition and feature registration are both imported explicitly for
this version. See [Monaco's Vite integration](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md).

The first real editor launch exposed missing `crypto`. Weber now enables Servo's
actual `webcrypto` Cargo feature. Native UUID, random-array fill and SHA-256 are
exercised; there is no JS crypto shim. `pkcs1` is locked to `0.8.0-rc.4`, matching
the pinned Servo lock, because `rsa 0.10.0-rc.18` fails against released pkcs1 0.8.0.
The feature adds 66 locked packages without replacing existing dependency versions.
This is not full WebCrypto algorithm/conformance certification.

## IME compatibility fix

Real Fcitx5 typing initially produced `한글글 ` from `한글 `. The captured event
trace showed Monaco rewriting its backing textarea during `compositionend`,
followed by Servo inserting the committed character again as a default action.
Composition input events were also queued after the composition ended.

The host now delivers the committed string as the final composition update.
`servo-ime-event-order.patch` tracks the composition session separately from the
DOM range, since JS editor callbacks can rewrite value/selection and invalidate
that range. A composition end finalizes an active session instead of inserting
its text again. Composition input is dispatched after its DOM update and before
the following end notification; ordinary text input keeps its queued path.
The relevant [UI Events ordering](https://w3c.github.io/uievents/#events-composition-input-events)
is tested with actual trusted events.

These are general host/Servo fixes; production code contains no Monaco-specific
IME branch. Acceptance sends OS keycodes and does not synthesize DOM composition
or input events in JS. Tests observe editor model changes rather than sending a
snapshot key that can activate Hanja conversion.

## Build and evidence

- Final source/build SHA-256: `00ebd2225e2b6e5ed986520d3dc485c24a9b1c4b20e59eb5f1a57cce66c165ca`.
- Servo: `aac43a3f31a259f04a574f5ec4e959c943ad7cc7` (v0.7.0).
- Release, `--locked --features layer-shell --offline`; SpiderMonkey JIT,
  `aotAvailable: false`. No Hermes runtime is initialized.
- Source SDK/runtime version remains `0.6.0-alpha.5`; no npm release is published.
- All 17 ordered Servo patches reproduce the vendor files from pristine pinned sources.
- Root Rust regression tests: **29 passed**, including direct commit and clear/commit order.

| Final native workload | Result | Evidence |
| --- | --- | --- |
| Original browser primitives | 13/13 HTTP + 13/13 packaged | `artifacts/large-app/native.json` |
| Original text Range geometry | 13/13 HTTP + 13/13 packaged | `artifacts/range/native.json` |
| Added wrapping regressions | 13/13 HTTP + 13/13 packaged | `artifacts/wrapping/native.json` |
| Persistent app storage | 12/12 process launches | `artifacts/browser-storage/native.json` |
| Existing native Hangul/Solid Workbench | 13/13 | `artifacts/ime-native.json` |
| Native contenteditable regression | 14/14 | `artifacts/editing-native.json` |
| Actual Monaco | 8/8 API checks and native input on **HTTP, live Vite, relocated package** | `artifacts/monaco/native.json` |

All seven native artifacts record the final build SHA above. The combined six-suite run passed; contenteditable was also run separately on
a fresh private display. The latest display result records normal compositor
lifetime before cleanup in
`artifacts/headless-wayland-result.json`. `artifacts/monaco/verified-results.json`
checks the native artifacts' fingerprints against the final build.

The existing primitive, Range and storage profiles are unchanged. New profile
SHA-256 values are `0ff9784aac5758be349152c2ecdf0fab3199114bc06aa62c181cf1e43ee2d870`
(wrapping) and `084ae1c97a1a872e8bdbaf42a47aae5b141be04a77260c4628c45fbfc269a847`
(Monaco).

Monaco's eight API checks cover native crypto, an actual rendered editor view,
model edits/undo/redo, selection geometry, search widget creation, programmatic
scrolling over 500 lines and resizing, TypeScript semantic diagnostics, and
three temporary-editor disposal cycles. Diagnostic code 2322 is observed in an
actual Worker RPC response and disappears after fixing the model; merely creating
a worker or falling back to the main thread cannot satisfy this check.

Each native input path additionally types ASCII through OS keycodes, runs native
undo/redo, composes `한글 ` with Fcitx5, replaces a selected document with `가 `,
and deletes the final Hangul jamo. Trusted composition events are recorded, and
composition input after an end event fails acceptance. Every app must present a
native frame and exit normally. Missing results, worker errors and exceptions fail.

All native tests use a newly owned headless GNOME/Wayland display, private D-Bus
and disposable XDG directories. One earlier run aborted on a closed private
compositor connection; its GJS log included IBusAttrList lifetime errors. That
failed run is retained under `artifacts/monaco/ime-order-compositor-disconnect.*`.
No OS root cause is claimed from those warnings. The headless runner now records
compositor exit state separately from application exit before cleanup.

Earlier negative controls are retained in `artifacts/range/wrapping-before.json`,
`artifacts/wrapping/before.json`, `artifacts/monaco/before-crypto.json` and
`artifacts/monaco/before-ime-order.json`. Failed runs are not counted as successes.
Temporary event-order instrumentation has been removed from source.

## Run it

From the Weber checkout, install the pinned validation dependency once and build:

```sh
npm --prefix compatibility/monaco ci --ignore-scripts --no-audit --no-fund
node scripts/monaco-workflow.mjs
cargo build --release --locked --features layer-shell --target-dir target/optimized --offline
```

Launch the actual editor through the ordinary SDK/Vite development workflow:

```sh
WEBER_HOST="$PWD/target/optimized/release/weber-servo" npm --prefix compatibility/monaco run dev
```

Use the new source runtime explicitly: older prepared runtime packages lack
WebCrypto and the IME correction. The demo runs its checks, then leaves the real
editor focused. F6 clears its model; F12 closes the test window.

```sh
node scripts/large-app-workflow.mjs wrapping
python3 scripts/check-servo-patches.py
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/large-app-native.mjs --suite=wrapping
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/monaco-native.mjs
```

The Monaco runner defaults to all three paths. `--mode=http`, `--mode=vite-dev`
or `--mode=packaged` selects a single debugging path and records that selection.
Read `artifacts/monaco/native.json`, native logs/traces and workflow manifest.

## Limits and next boundary

This is initial editor compatibility, not all Monaco behavior, human physical
keyboard/Hanja reconversion, pointer/wheel interactions, accessibility, live HMR,
DPI/multiple outputs, all languages, repeated worker-memory reclamation or other
compositors/platforms. Startup, CPU and memory advantages have not been measured
for this workload; do not transfer older small-app measurements to it.

There is no Code-OSS workbench, extension host, PTY/LSP service or workspace-file
adapter in this increment. Next work uses this actual editor as the workload for
resource measurements and general workspace services. The
[transport policy](transport-policy.md) still applies: direct calls/shared data
in-process, shared memory or file mappings for large isolated payloads, pipes for
small controls. This increment adds no native IPC service or zero-copy transport.

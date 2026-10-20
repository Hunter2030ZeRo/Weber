# JIT performance and persistent app foundation — 2026-10-20

## Delivered scope

This bundle keeps the JIT-only Servo host as the default. No further Hermes DOM
integration is implemented. It adds small-document scheduling in the pinned
Servo fork, opt-in timing diagnostics, a bounded app storage worker, an SDK
storage module and a Notes template using the existing Vite/npm workflow.

`src/storage.rs` owns filesystem work. The UI thread validates/enqueues requests
and consumes results. Windows share a queue within one app; window close and
navigation discard their replies. The worker is lazy and has bounded queues.
`@weber/sdk/storage` provides app paths and JSON get/set/remove/list operations.
See [the API contract](app-storage.md) for quotas, cancellation, atomic replacement
and the lack of cross-process transactions.

## Scheduling change

The measured wrapped animated demo has 205 DOM nodes when native control shadow
trees are included. Repeated style/layout work can cost more to distribute across
workers than to run serially for a document this small. The new heuristic scans
at most 257 nodes by default, including shadow trees. At 256 nodes or fewer it
passes no Rayon pool to style traversal and layout; otherwise it preserves the
existing parallel pool and its job thresholds. It re-evaluates at each relevant
reflow so growing and shrinking documents switch paths. No DOM operation, layout
phase, CSS feature, update frequency or render frame is removed.

The patch is retained as `patches/servo-small-dom-scheduling.patch` and applied
by bootstrap. `WEBER_SERIAL_DOM_LIMIT=0` selects the previous pool scheduling
path in the same binary. Values 1..4096 override the threshold for tuning; invalid
values use 256. `WEBER_LAYOUT_THREADS` is a diagnostic 1..16 override; its default
remains Servo's three threads. A threshold based on node count is a heuristic,
not a universal complexity or performance guarantee.

A global one-thread setting was rejected: although it reduced CPU in the small
workload, it slowed a large DOM mutation/layout workload. Servo wake coalescing
was also tried and rejected because its CPU advantage was not demonstrated.
Neither is part of the delivered default. Full-window background clearing,
WebRender buffer-age handling and compositor-driven animations remain separate
potential work; no damage-aware renderer implementation is claimed here.

## Timing diagnostics

`WEBER_TIME_PROFILE=/absolute/report.tsv` enables Servo's existing time profiler.
`WEBER_FRAME_PROFILE=1` with `WEBER_TELEMETRY` records bounded paint/present/spin
samples. Frame samples contain wall milliseconds and, on Linux, current-thread
CPU milliseconds. These diagnostics are disabled by default. They are separate
from the uninstrumented CPU comparison.

The diagnostic run found context binding around 0.006 ms CPU per paint, painting
around 0.4–0.5 ms and presentation around 0.1–0.15 ms on this machine; these are
local measurements, not portable latency guarantees. Servo profiler spans are
wall time, not CPU utilization. Perf call-graph sampling remained unavailable
with current kernel permissions; no kernel setting was changed.

## Native functional verification

The final JIT package is run in an isolated GNOME Wayland session, using a
960×720 virtual monitor at 60 Hz. The user's desktop is not automated.

- TypeScript checks and actual npm/Vite builds pass for the Notes and storage
  contract fixtures. SDK initialization includes the new `notes` template.
- The native textarea Save/Reload and New window behavior passes with Korean,
  emoji and multiline text. Closing and relaunching the app restores the value.
- Separate app ids use distinct paths; multiple windows share the app's data.
- Nested JSON, missing keys, config/data isolation, removal, invalid inputs,
  pending queue saturation, ordered writes and cancelled result rejection pass.
- Another window cannot poll a parent's request id. Closing a child with 16
  abandoned requests releases its pending slots; the parent can fill all 32 again.
- Native checks confirm stored Unix file permissions are 0600.
- The existing embedded desktop smoke passes: signal updates, Unicode input
  events, scrolling, keyed lists and remount behavior.
- A native document grows past the threshold, shrinks, adds a large shadow tree
  and removes it. Trace output confirms both scheduling branches execute; DOM
  and shadow CSS assertions pass.
- The locked original WPT files are rerun in actual Servo JIT: all 17 files and
  1,474 subtests pass. This is **not** a rerun of the entire dual-engine profile
  or its 15 additional mandatory scenarios.

These input scenarios use programmatic DOM events. Physical keyboard/IME,
Windows/macOS, actual Hyprland integration, accessibility devices and prolonged
production use are not established by this milestone.

## Results

Final source fingerprint: `1cea5a4f43beb969299562891d15dcff7c7f716e3776e9198c2f7d5ff0cfb6ef`.
JIT executable SHA-256: `8ac094eace56dfc5a74bca888cdccc86dd749588bc1c3ccbcb4820b3bd647354`.
Release host, `aotAvailable: false`, `storageProtocol: 1`,
`layoutPolicy: serial-small-dom-v1`; ten private libraries, no Hermes/JSI runtime.

### Same-binary CPU comparison

Three 6-second measurements per policy, alternating order, after 2 seconds of
initial application runtime and 1.5 seconds of variant warmup. The original Solid
demo, text updates, transform updates and visible layout are unchanged. No other
builds or tests run during these samples. Both policies use the same executable
and three-thread pool configuration; only `WEBER_SERIAL_DOM_LIMIT=0/256` differs.

| Policy | Weighted CPU | Individual runs | rAF callbacks/s |
| --- | ---: | --- | --- |
| Previous pool scheduling | 29.06% | 27.74%, 31.33%, 28.11% | 59.82–59.99 |
| Adaptive small-DOM scheduling | 21.87% | 21.42%, 23.12%, 21.07% | 59.66–59.99 |

The final comparison is **24.7% lower process CPU** for this workload.
100% means one logical CPU, not the entire 22-logical-CPU machine. CPU includes
Weber's user and system time across threads; compositor, GPU execution and Bun
are excluded. rAF callbacks are not a physical display FPS measurement.

The preceding complete run, before the storage-path namespace adjustment, found
24.96% versus 21.93% (12.1% lower) with the same scheduling algorithm. Baseline
utilization varies between sessions/builds; the final 24.7% is not a portable
promise or a confidence interval. There are only three independent runs per
policy in the final sample set. Do not compare these percentages directly against
older sessions' 23.4% as if the test environment were constant.

### Large DOM and idle

The large stress case changes 1,000 text nodes and alternates a container's width,
then forces layout of the last row. It has over 4,000 DOM elements. Each process
runs five warmups and 30 measured batches. The original animation is paused for
this separate stress test. Times are DOM mutation + synchronous layout wall time,
not input-to-present latency, and the batches within a run are correlated.

| Policy | Run | Batch p50 | Batch p95 |
| --- | ---: | ---: | ---: |
| adaptive | 1 | 147.49 ms | 207.34 ms |
| upstream | 1 | 60.29 ms | 120.86 ms |
| upstream | 2 | 69.73 ms | 195.76 ms |
| adaptive | 2 | 60.06 ms | 185.44 ms |
| adaptive | 3 | 58.60 ms | 112.12 ms |
| upstream | 3 | 159.71 ms | 180.26 ms |

Results are highly variable and do not establish a large-DOM speedup or a broad
absence of regressions. The adaptive path retains parallel scheduling above the
threshold, with native branch-transition and WPT evidence. This extreme batch
workload can still take tens or hundreds of milliseconds; it is remaining work,
not a claim that every large GUI is now smooth.

The unchanged Notes app, after first storage use and a 3-second settle, detects
zero additional CPU ticks in each of two 10-second idle windows. A `WeberStorage`
thread is confirmed present. This demonstrates that the worker/SDK do not keep
polling continuously while idle in this test; finite clock resolution does not
prove zero CPU forever. No startup or memory advantage over earlier host binaries
is claimed by this bundle.

### Build and artifact checks

Six Rust tests, release Clippy with project warnings denied, formatting, SDK
TypeScript checks and npm/Vite builds pass. The preserved AOT feature also passes
`cargo check`; a new AOT executable, AOT storage run and AOT performance comparison
are **not** claimed. App manifests, all retained fixture assets, the executable
and all ten private libraries are verified against their hashes.

Raw evidence: [native app checks](../artifacts/foundation-native.json),
[scheduling transition](../artifacts/foundation-policy.json),
[JIT WPT](../artifacts/foundation-wpt-jit.json),
[CPU](../artifacts/foundation-cpu/adaptive-results.json),
[large DOM](../artifacts/foundation-cpu/large-adaptive-results.json),
[idle](../artifacts/foundation-idle.json),
[artifact audit](../artifacts/foundation-audit.json).


## Relocatable application package

`npm exec -- weber package dist <checkout>/target/package/weber-notes` produces
a self-contained Notes application plus the JIT host/private libraries. The test
moves that package to another directory, mounts Notes with a nonexistent tools
PATH, confirms the correct app identity and no Node/Bun child process, then
restores the package location. Save/Reload behavior is covered by the separate
native fixture. See [the relocation record](../artifacts/foundation-relocation.json).

The in-checkout fixture's default `npm run package` output was rejected by the
existing guard against packaging into non-target source paths. The successful
package check uses an explicit `target/package` output; default in-checkout
packaging is not claimed to pass. No host installation or publishing occurs.

## Reproduction

```sh
rtk proxy env CARGO_TARGET_DIR=target/optimized cargo build --release --locked --features layer-shell
rtk proxy python3 scripts/package.py --profile release --binary target/optimized/release/weber-servo --output target/package/weber-foundation-jit
rtk proxy node scripts/foundation-workflow-smoke.mjs
rtk proxy dbus-run-session -- node scripts/headless-wayland.mjs artifacts/foundation/gate.mjs
```

Set `WEBER_NPM_ONLINE=1` only when the fixture's npm cache needs initial fetching.
Workflows and fixtures remain under `artifacts/foundation/`; no temporary source
asset disappearance is required to reproduce this bundle. Benchmark scripts are
diagnostic artifacts rather than production runtime code. Run comparison cases
sequentially, after builds and other tests finish.

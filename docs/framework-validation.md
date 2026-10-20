# Weber framework foundation validation — 2026-10-19

Historical SDK foundation results (source 7539). Its prepared host now lives at `target/package/weber-framework-7539-baseline/`. Current results: [native byte bindings](binary-dom-validation.md).

The SDK 0.2 foundation is implemented and tested. Independent JS/TS apps compile
to real native AOT modules and run in the same Servo host. CSS uses native Servo
bindings; redundant command-layer topology and serialization work are removed.
Remaining mirrored DOM state, JSON transport and SpiderMonkey are explicit limits.

Source SHA-256:
`7539ab4b3082704b6c2d582cee3389759ee4c0ee567a6d7c480ef89fe5c486c6`.
Servo `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`, Hermes
`17b37301da5da4a2cd55d78f9697c46c0fd96123`.
Native ABI `54c8b2957e4e5823f4b52eca6c5538346d7e2b50fe396b4c63b1e0ce31069ea9`.
The [audit](../artifacts/framework-milestone.json) checks report source/revisions,
both package executables, all private libraries and compiled app resource hashes.

## Implemented and executed

- **CSSOM:** 18 identical assertions in actual Servo and native Hermes AOT pass:
  declaration identity/prototype, property/priority, Attr identity, invalid values,
  custom properties, shorthand, indexing/enumeration, expandos, detached nodes,
  clone independence, argument conversion and observer oldValue/counts. The
  native path does not initialize cssstyle. Standalone tests keep a lazy fallback.
  [Release evidence](../artifacts/native-style.json).
- **Fixed compatibility:** all 17 locked original WPT files, 1,474 subtests per
  engine and 15 mandatory scenarios pass; build/types/lint/format pass. The same
  source was tested in debug and O3 release. Auxiliary legacy renderer checks in
  the profile runner use the same-source debug host; separate release renderer
  checks below also pass. [Debug report](../artifacts/framework-compatibility-profile.json),
  [release report](../artifacts/framework-release-compatibility-profile.json).
- **Generic SDK:** strict TypeScript checks and Vite/native O3 compilation pass
  for a Solid counter and a plain DOM notes app. Both separately loaded modules
  pass AOT/web state, Unicode input dispatch, CSS and remount checks. ABI, module
  hash and path mismatches are rejected before execution.
  [Independent application results](../artifacts/framework-smoke.json).
- **Module environment:** document globals, detached-node CSS and document time
  origin are available before native user-module evaluation and stay valid across
  remount. A precision regression was reproduced: parsing/formatting the initial
  clock in Rust shifted an epoch timestamp by one binary64 step in some runs.
  Initial module setup and every host request now use original wire bytes.
  [Ten fresh-process checks](../artifacts/framework-module-clock-final.json)
  pass; pre-fix traces are retained under `artifacts/framework-validation/clock-before/`.
- **Packaging/tooling:** a complete app package moved to a temporary directory
  runs both modes with cwd `/tmp` and without developer library/module paths.
  A project created outside framework sources builds and runs successfully.
  A type error preserves the preceding native module, and an unrecognized output
  directory is preserved. An invalid ELF with an otherwise matching manifest hash
  fails with a nonzero process exit. [Evidence](../artifacts/framework-package-validation.json).
- **Release renderer:** the relocated full desktop still passes navigation,
  remount, counter, Unicode signal and native scroll callback checks in both
  modes. [Evidence](../artifacts/framework-standalone-smoke.json).
- **Ownership:** 35 cohorts of 500 detached node/text/listener cycles, retained
  node reuse and 20 complete remounts pass in both modes. AOT ends with 249 native
  handles/wrappers, zero low-level duplicate topology entries, and an 8MiB Hermes
  heap. Last-20 mutation cohorts grow PSS by -52KiB AOT / 312KiB web. This bounded
  workload uses forced collection and is not a universal leak-freedom proof.
  [Evidence](../artifacts/framework-desktop-stress.json).
- **Real desktop input:** GNOME Wayland/Fcitx Hangul composition/commit, editing,
  Tab/Shift-Tab, trusted native Enter activation and PageDown/PageUp pass in both
  engines. This uses OS input injected into the owned window. It is separate from
  SDK example tests, which use programmatic DOM events, and from human physical
  keyboard/mouse testing. [Evidence](../artifacts/framework-desktop-input.json).

## Performance

Same complete Solid desktop workload, actual GNOME Wayland desktop, optimized
release binaries. One warmup then 12 alternating AOT/web starts per build;
40 process-tree PSS/RSS samples and 40 native Enter/presentation samples per
engine. Builds are measured in separate runs, not randomized across builds.
Startup excludes ELF loading and ends at a post-ready native presentation.
Input timing is a next-present proxy, not optical latency. GPU memory is excluded.
These measurements use the built-in desktop; independent SDK app loading was
functionally validated but has not received an equivalent latency benchmark.

| AOT metric | Original release, remeasured | Framework foundation |
|---|---:|---:|
| Startup median | 236.49ms | **212.85ms** |
| Startup p95 | 247.66ms | 226.67ms |
| Process-tree PSS median | 161.13MiB | 159.15MiB |
| Process-tree RSS median | 209.39MiB | 206.15MiB |
| Input proxy median | 13.25ms | 12.62ms |
| Input proxy p95 | 16.26ms | 16.38ms |
| Native present interval p95 | 8.78ms | 8.77ms |

Startup improves about 10.0%. The observed roughly 2MiB PSS difference is small;
this is **not achievement of the low-memory goal**. Input/presentation timing is
similar, without a speedup claim. In the new build web measures 190.90ms startup
and 134.05MiB PSS, so AOT still adds about 21.9ms and 25.1MiB over web.

At the recorded first ready point, Hermes heap capacity changes 12→8MiB and
allocatedBytes changes 6,768,024→4,298,568 bytes. These are not resident process
memory or live-after-GC sizes. Supplementary interleaved smaps probes from the first-pass 8207 source (before module-init refinements) show roughly 4.6MiB less
AOT anonymous memory; file/code mappings offset much of that benefit.

[Current measurements](../artifacts/framework-desktop-benchmark.json),
[original executable remeasurement](../artifacts/framework-original-baseline-desktop-benchmark.json).
The original binary hash matches the preceding standalone milestone exactly.

A copied baseline executable showed materially lower resident file/code mappings
despite identical file bytes, including in its web control. Fully reading the
files before launch did not eliminate that observation. That copied-file run is
retained as `framework-baseline-desktop-benchmark.json` but excluded from the
headline comparison. The actual original package was remeasured instead, and its
web control is close to the new build's web control. Raw interleaved mappings are
preserved in `framework-{warm-,original-,}memory-maps.json` and their smaps files.
The underlying OS mapping/cache-layout mechanism was not established; no
specific kernel cause or large RAM improvement is claimed.

## Artifacts and reproduction

- Host: `target/package/weber-framework/weber`.
- Complete counter application: `target/package/weber-counter/`;
  run `./weber --app ./application` inside it.
- Archives: `target/package/weber-framework-0.2-linux-wayland-x86_64.tar.gz`
  and `target/package/weber-counter-0.2-linux-wayland-x86_64.tar.gz`, about 71MiB
  each. SDK/source use is described in [framework.md](framework.md).
- The prepared-checkout renderer suite is
  `artifacts/framework-validation/renderer-suite.mjs`; invoke through
  `dbus-run-session -- node scripts/headless-wayland.mjs ...` for the isolated
  GNOME renderer. Native desktop input/benchmark scripts require an unlocked
  actual session. `WEBER_REPORT_PREFIX` preserves preceding milestone reports.
- `artifacts/framework-validation/audit.py` verifies report/package consistency.

The next structural work is a canonical native node-handle facade and a typed
wire protocol. The current browser facade still stores topology and attributes
beside Servo, and JSON/UTF-8 copies still cross the engine boundary. This version
does not claim that all DOM duplication/string transfers are solved or that
SpiderMonkey, browser conformance gaps and Node runtime compatibility are gone.

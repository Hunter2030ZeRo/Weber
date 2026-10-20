# Native byte bindings validation — 2026-10-19

The byte transport, native text/form reads, native selectors and Servo batch
cloning are implemented, compiled and exercised. They advance the bindings and
framework work. **The startup/low-memory goal is not achieved.** Full native DOM
ownership and removal of SpiderMonkey remain unimplemented.

The [final audit](../artifacts/bindings-milestone.json) verifies source hashes,
release reports, executables, all private libraries, app assets and the actual
executables inside both archives.

Current source SHA-256: `84ff6d1396bc5eda869a746fa23daaadf289ad1319e1c35b936564cd34234ac2`.
Servo `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`;
Static Hermes `17b37301da5da4a2cd55d78f9697c46c0fd96123`.
Both application and shell logic use native AOT; the Servo DOM adapter and its
Window/WebIDL/GC bindings continue to use SpiderMonkey.

## Executed validation

- Debug and optimized release builds succeeded. Actual Uint8Array/JSI ArrayBuffer
  integration is compiled. Previous engine patches plus the new byte patch
  reproduce every modified Servo file; see
  [engine patch reproduction](../artifacts/binary-binding-validation/engine-patch-reproduction.json).
- The optimized host passes the locked 17 original WPT files, 1,474 subtests per
  engine, 15 mandatory scenarios, types, lint and package-scoped format checks.
  [Release profile](../artifacts/bindings-release-compatibility-profile.json).
  Its auxiliary legacy Wayland helpers use the same-source debug build; separate
  optimized renderer tests below cover the release package.
- Native binding tests pass 10 shared assertions and one additional AOT storage
  assertion. Servo changes real character data and form values, then the retained
  AOT wrappers read those changes. Native clone preserves those values, template
  depth, fragments, comments, wrapper/Attr independence and detached handles.
  JSON functions are disabled in both realms during the main exchange. Three
  malformed host packets are rejected and a subsequent valid call succeeds.
  [Binding results](../artifacts/binary-native-bindings.json).
- The same 18 native CSSOM assertions pass in both engines. Native mode does not
  initialize the local CSS parser.
  [CSS results](../artifacts/binary-native-style.json).
- Two independent SDK native modules pass AOT/web tests and remount; invalid ABI,
  hash and path inputs are rejected. Ten fresh notes-module processes preserve
  top-level document, detached CSS and timeOrigin through remount.
  [SDK apps](../artifacts/binary-framework-smoke.json),
  [module initialization](../artifacts/binary-module-clock-final.json).
- The relocated complete desktop passes both engines, navigation, remount, input
  signals, native scroll and identical initial layout.
  [Relocation](../artifacts/binary-standalone-smoke.json).
- Ownership stress passes 35 cohorts of 500 node/text/listener cycles, retained
  node reuse and 20 remounts. AOT ends with 249 handles/wrappers and an 8MiB Hermes
  heap; last-20 mutation cohorts grow PSS by 1,520KiB AOT / 303KiB web. These finite
  forced-collection checks are not proof of universal leak freedom or normal
  steady-state memory behavior.
  [Stress](../artifacts/binary-desktop-stress.json).
- Actual GNOME Wayland/Fcitx OS input passes Hangul composition/commit, editing,
  Tab/Shift-Tab, trusted Enter activation and native PageDown/PageUp in both
  engines. This is injected OS input to the owned native window, not human
  physical-keyboard testing.
  [Input](../artifacts/bindings-desktop-input.json).
- The new default SDK host and complete counter package are tested after
  relocation with cwd `/tmp` and without developer library/module paths. An
  external project initializes, strictly checks, compiles and runs; a type error
  preserves its preceding native module and unrecognized output is preserved.
  An invalid ELF with a matching manifest hash exits nonzero.
  [Tooling/package checks](../artifacts/bindings-package-validation.json).
- Rust wire validation tests pass. JavaScript codec checks cover UTF-16, binary64,
  negative zero, offset views, every truncation of a sample packet, size/cycle
  rejection and prototype-key safety. The wire preserves lone surrogate code
  units; the pinned Servo DOM itself normalizes them to U+FFFD. These are distinct
  boundaries, not a claim of complete DOMString conformance.

## Performance

Same complete Solid desktop, same optimized executable in AOT/web modes, actual
GNOME Wayland, 960×720 logical viewport. One warmup and 12 alternating starts per
engine. Startup is Rust main to a distinct native present after app readiness;
ELF loading is excluded and files are warm. PSS/RSS use 40 process-tree samples
at 200ms; GPU memory is excluded. Input is 40 OS Enter-to-next-present proxy
samples, not optical latency. Distinct presentation intervals are not scan-out
timestamps. The web mode does not initialize a Hermes heap, although its library
remains linked in the same executable. These latency figures use the built-in
desktop; independent SDK module loading was functionally tested separately.

| Metric | Hermes AOT | SpiderMonkey, JIT enabled |
|---|---:|---:|
| Startup median | 224.21ms | 187.15ms |
| Startup p95 | 234.45ms | 199.98ms |
| Sampled PSS median | 168.15MiB | 130.59MiB |
| Sampled RSS median | 217.95MiB | 176.21MiB |
| Input proxy median | 13.16ms | 13.47ms |
| Input proxy p95 | 16.59ms | 16.61ms |
| Native present interval p95 | 8.73ms | 8.72ms |

AOT is still slower to start and uses more sampled process memory. Input/frame
results are similar, without a speedup claim. Compared with the preceding SDK
foundation's observed 212.85ms / 159.15MiB AOT, this milestone is also worse in
these measurements. **Byte transport is not automatically a performance win.**
These are separate build runs; cross-build file/code residency can change, as
already documented in the preceding milestone. The same-build AOT/web gap is
measured directly.

AOT sampled PSS rises from 161.26 to
172.80MiB in the sampling interval; a settled plateau
was not established. Forced-GC ownership stress and the Hermes heap capacity do
not establish that natural-GC process memory is low. Allocation/GC behavior and
resident native code need further isolated investigation; no specific leak or
single cause of the PSS gap has been established.

[Final benchmark](../artifacts/bindings-desktop-benchmark.json).
The original current executable inode was preserved when promoting its containing
package to the default SDK path; the old measurement path remains a symlink.

## Regression found and corrected during this work

The first byte implementation (source `aa61e20e91473fb73ac417d351d1e2c461e027c5163cf45c8341f096fcbf2ab3`)
measured 242.00ms AOT startup and 161.95MiB PSS, with a 190.15ms / 130.92MiB web
control. That package is preserved at `target/package/weber-binary-stage1-aa61/`.
[First byte benchmark](../artifacts/binary-desktop-benchmark.json).

An independent instrumented native module mounts the existing compiled desktop.
It found 58 individual native text/form reads during template cloning: 63 total
synchronous queries. Servo batch clone removes those value round trips; the same
probe now makes five synchronous queries. Median instrumented mount changes
42.56→27.83ms. The wrappers themselves add overhead, styling and launch path
are diagnostic rather than the benchmark workload, and nested timings overlap;
these are not app-startup measurements and their totals must not be added.
[Before probe](../artifacts/binary-binding-cost-probe.json),
[after probe](../artifacts/bindings-binding-cost-probe.json).

Batch clone recovers startup relative to the first byte version, but it does not
recover the preceding foundation's startup or sampled memory. No overall
performance improvement is claimed.

## Ready artifacts and remaining work

- Current default SDK host: `target/package/weber-framework/weber`.
  Measurement alias: `target/package/weber-binary-bindings/`.
- Complete counter: `target/package/weber-counter-bindings/`; run
  `./weber --app ./application` inside it.
- Archives: `target/package/weber-bindings-linux-wayland-x86_64.tar.gz` and
  `target/package/weber-counter-bindings-linux-wayland-x86_64.tar.gz`.
- Previous SDK foundation package is preserved, without copying its executable,
  at `target/package/weber-framework-7539-baseline/`. Original 0.2 archives and
  the original pre-framework release remain available.
- Prepared-checkout reproduction scripts are under
  `artifacts/binary-binding-validation/`; native helper tests need a Wayland
  compositor and actual desktop input/benchmark needs an unlocked desktop.

The remaining canonical node-handle/Attr ownership, native parser materialization
and engine/GC port are described in [binary-dom-bindings.md](binary-dom-bindings.md).
The new transport still copies buffers and decodes schemas. Parent/child links
and Attr state remain in the facade. Disabling `js_jit` would not remove
SpiderMonkey or its DOM reflectors. Browser conformance beyond the locked
profile, Node/Bun compatibility and other OS backends are not delivered here.

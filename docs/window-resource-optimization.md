# Native window resource lifetime optimization

Linux Wayland, Servo/SpiderMonkey JIT, SDK 0.5.0 — 2026-10-20.
This changes internal resource ownership; it adds no application SDK requirement.
The public SDK API/version, Vite workflow and default JIT engine are unchanged.
Static Hermes and Windows/macOS are outside this validation.

## Finding and change

The 200/1000-window workload showed continuing native heap growth. Servo's
existing asynchronous memory-report API separated JS GC space, native heap,
WebRender and DOM reports. The main growth was not explained by accumulating
closed DOMs or retained WebRender display lists in these snapshots.

A diagnostic gperftools allocation comparison then identified two Stylo TLS
allocations: 200 sharing-cache buffers retaining 6,184,000 bytes and 200 Bloom
buffers retaining 820,800 bytes. Together they account for 35,024 bytes per
short-lived styling thread. The pinned Stylo source intentionally uses
`Box::leak` for stable cache addresses, because traversal guards can outlive
worker TLS and be dropped by a parent thread. Repeated native windows expose
the cost of that lifetime choice; freeing the cells unconditionally is unsafe.
The gperftools experiment used tcmalloc only in the owned diagnostic process
tree, not as Weber's default allocator. Its call-site counts are attribution
evidence, not default-allocator PSS or CPU measurements.

The patch leases stable-address caches from two process pools. A TLS destructor
returns a cell only if an exclusive borrow check proves no traversal guard is
outstanding. If a guard outlives TLS, the cell keeps the original intentional
retention behavior. Cells are never freed out from under static references.
Existing Stylo traversal destructors clear DOM/style state before releasing the
guards. No global GC, allocator cap, periodic task or extra hot-path mutex was
introduced: pool locking happens on TLS checkout/return, not selector matching.
Pool storage retains the cache concurrency high-water mark; this is reuse, not
full cache destruction on every close or a proof that all lifetime cases free.

The [helper](../native/stylo_cache_pool.rs) is included verbatim in the
[Stylo patch](../patches/stylo-reusable-tls.patch). Two ownership tests cover
repeated thread exit/reuse and a guard deliberately held by a parent after its
worker exited. The latter must prevent recycling and remain usable.

## Measured result

The same installed SDK app, static 80-row document/input and storage workload
ran in private GNOME headless Wayland at 960x720@60. Each child leaves 31 owned
storage results, and the parent verifies cleanup and cross-window isolation.
1000 lifetimes exercise 31,000 abandoned child requests. Checkpoints wait for
quiescence before requesting reports. No forced GC is used in this workload.

The baseline engine counters came from a diagnostic-only derivative of the
previous `b6d1433` implementation, before applying the cache patch. It is not
claimed to be that commit's released package. Its source fingerprint is
`cecf1df00de0bdf70d239466e5e6df8b8d3e39a084875cca987aa26517a97da3`. The final source is
`df0d61ebb0d3f9a28ea56f7cddf4a0c9eb7f778a31bc58f6e5c828682c89c5ad`. A first fixed run used
`5272eb0866cc8f176caa39f88e7f2fc92792d0567d93c8f267d74a9543e15f82`; an intermediate repeat used
`db05a63f4527340c8cdf42261a144daa148cf53ed62be277ae6bff3798578a0e`. The final run
includes the explicit regression budget and keeps diagnostic labels outside the
hot native wake message. The cache helper is unchanged between fixed runs.

| Measurement after 1000 child windows | Before | Fixed, first run | Fixed, final repeat |
| --- | ---: | ---: | ---: |
| Added system-heap-allocated | 39.42 MiB | 6.12 MiB | 6.08 MiB |
| Added process-tree PSS | 69.67 MiB | 22.90 MiB | 23.56 MiB |
| Additional system heap, cycle 200→1000 | 29.81 MiB | 3.07 MiB | 3.00 MiB |

These are increases relative to each process's settled initial checkpoint,
not total application memory reductions. Final PSS was 121.81→145.37 MiB.
The native heap counters are Servo/glibc allocator accounting, not a direct
reachability census; they can include allocator effects. Engine counters may
overlap and must not be added to PSS. GC decommitted capacity is not resident RAM.
External compositor/GPU allocations are excluded. Diagnostic reporting itself
perturbs allocation/timing; these are short lifecycle observations, not a
cross-framework comparison or all-day endurance proof.

The provisional regression budget permits at most **8 MiB additional native
heap from cycle 200 to 1000**, after warmup. The final run used
3.00 MiB. The recorded pre-fix run would exceed the same budget.
This budget detects a recurrence of the large growth; it is not a zero-leak gate.
File descriptors stayed 28→28; final-run threads were 50→51, including the existing lazy
reclamation worker. Static idle checkpoints added zero CPU ticks at the sampling
resolution. This does not imply zero CPU for an animated GUI.

Local raw reports/traces: `resource-before-1000.json`,
`resource-fixed-first-1000.json`, `resource-1000.json`, `resource-comparison.json`
and `heaptrace/delta-stacks.json` under `artifacts/`.
The intermediate fixed repeat is retained as `resource-fixed-second-1000.json`.

## Animation CPU and startup screen

A separate comparison used the released pre-change `b6d1433` bundle (source
`5b2a43bbea9228deea0fcb31fc77a6a0d96e463c4110232c9129cd07971bd1d3`)
and the final source above, with memory profiling disabled. Both rendered the
same 77-element SolidJS animated screen in private GNOME Wayland. Each had one
unscored warmup and four fresh scored processes, interleaved after/before/before/
after/before/after/after/before. Owned bundle copies received identical file-cache
advice; no global cache drop or CPU-policy change was used. No builds or other
native suites ran alongside the scored processes.

| Screen | Before | Final |
| --- | ---: | ---: |
| Mean process CPU, one logical core = 100% | 12.01% | 12.45% |
| CPU range across four processes | 11.59–12.54% | 12.14–12.74% |
| Median Rust-main → first app presentation | 222.14 ms | 227.26 ms |
| Startup range | 213.60–230.79 ms | 213.12–240.27 ms |

CPU windows cover five seconds after first presentation plus 1.5 seconds settling;
they exclude compositor/external GPU CPU. Frame interval medians remain about
16.66 ms. This small screen shows **no CPU or startup improvement** and a somewhat
higher mean CPU sample; four repeats do not establish a universal regression or
prove equivalent performance. Startup here omits process creation/loader time.
Representative startup/idle/input measurements and CPU attribution remain next
work, rather than declaring a CPU win from the memory result. Raw data and build
fingerprints are in `artifacts/style-cpu.json` and its eight JSONL traces.
An earlier intermediate diagnostic implementation showed a larger CPU difference;
its result is retained in `style-cpu-wide-wake.json`. The final rerun does not by
itself prove that the message-size change caused the difference.

## Validation and source preparation

- Release build and 19 Rust tests, including both cache lifetime tests, passed.
- Fifty native windows alternated 80/600-row documents, distinct colors and
  margins; computed-style isolation passed with diagnostics disabled.
- The existing JIT ownership stress passed: 35 mutation cohorts and 20 remounts,
  including its forced-GC checks. That forced GC belongs only to this separate
  diagnostic stress workload, not production or the 1000-window comparison.
- The seven ordinary Linux integration gates passed on the final source:
  clipboard/default shortcuts, portal files, close decisions, persistence,
  50/200 lifetimes, installed SDK/runtime, packaging/relocation and Vite HMR.
- Project Clippy, formatting and source/package integrity checks passed.
- Eight Servo patches still match the pristine pinned checkout. The separate
  Stylo preparation check matches all 318 prepared files to the pinned archive
  plus the reviewed patch and unit-tested helper.

Stylo is kept at 0.22.0, registry archive SHA-256
`7a255e46af2478628c48daab3774090caabd7812b1dd3ca98801c2b9c53491ed`.
`prepare-stylo.py` verifies this checksum, uses the Cargo cache when possible and
materializes the patch into ignored `vendor/stylo`. It never modifies the shared
Cargo cache and rejects an unexpectedly edited prepared tree. Bootstrap runs
this preparation automatically. The runtime records the version and hashes the
actual prepared sources into its source fingerprint. Distribution contains the
MPL notice and complete patch/helper source; no new runtime download is needed.

With a prepared release JIT host and local npm SDK/runtime packages:

```sh
python3 scripts/prepare-stylo.py --offline --check
node scripts/resource-workflow.mjs --cycles=1000
dbus-run-session -- node scripts/headless-wayland.mjs scripts/resource-native.mjs --cycles=1000
node scripts/resource-workflow.mjs --cycles=50 --styles
dbus-run-session -- node scripts/headless-wayland.mjs scripts/resource-native.mjs --cycles=50 --styles --disabled
dbus-run-session -- node scripts/headless-wayland.mjs scripts/desktop-stress.mjs target/package/weber-clipboard-jit/weber
node scripts/preview-audit.mjs
```

The full build's first preparation can download the checksum-pinned archive;
`--offline` requires that archive in Cargo's cache or `target/source-archives`.
The seven functional/package gates must also run before `preview-audit.mjs`.
That audit covers functional provenance, not a general performance certification.

`WEBER_MEMORY_PROFILE=1` plus `WEBER_TELEMETRY` explicitly enables the diagnostic
reporter. Only primary-window telemetry labels can request a report, at most
one report is in flight, and engine callbacks queue data without blocking on
formatting/I/O. Labels use one coalesced control slot; native wake messages stay
at most 16 bytes, enforced at compile time. Normal apps receive no new private engine JS capability. With
the flag absent, the diagnostic requests in the fixture produce no reports.

## Remaining work

Growth is reduced, not eliminated. The system-font service still keeps
painter-specific font/key caches after removal; its measured footprint rises
from about 0.11 to 1.67 MiB in the 1000-window workload. That is a separate
cleanup target. JS heap/caches, graphics/allocator fragmentation, longer runs,
physical keyboard/IME, output changes and clean-machine packaging also remain.
The locked WPT profile, Windows/macOS and Hermes were not rerun here.

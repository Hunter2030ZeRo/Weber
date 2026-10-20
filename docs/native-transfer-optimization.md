# Native document transfer optimization — SDK 0.5.0

This changes host internals, without changing the public SDK API or its version.
The default runtime remains Servo/SpiderMonkey JIT. Static Hermes, a Hermes-only
DOM, Node compatibility and new platform backends are not part of this change.

## Implementation

The JIT host already parses and authenticates the native request envelope. It
now transfers the parsed request to native dispatch, instead of serializing it
back to a temporary string and parsing it a second time. File/storage workers
receive ownership of the request; clipboard writes move their string into the
worker operation. Storage set/get also move values rather than cloning large
values immediately before dropping the source container.

Quota checks count exactly the bytes emitted by serde_json through a counting
writer, without building a temporary serialized buffer. Canonical byte counts
are reused for queued storage reservations. The optional string/AOT entry keeps
its raw transport limits and separately charges canonical JSON bytes, including
numeric spellings that expand on serialization. Its unit-tested dispatch is not
evidence of a compiled or improved Hermes runtime.

Existing capability, focus, owner, pending-slot, queued-data and document-size
checks remain in force. Reading a value removes it only from the freshly loaded
in-memory map, never from the persistent store. The file's atomic replacement
and durability operations are unchanged.

## Comparison method

The benchmark uses the same installed SDK app and pinned Servo on both hosts.
Each host runs four fresh processes in alternating order. Each process tests a
small Unicode value, exactly 1 MiB encoded ASCII JSON, and exactly 1 MiB escaped
JSON. Each phase warms once, then performs 32 sequential durable set/get pairs,
checking equality after every read. CPU is process user+system time, including
threads; peak process-tree PSS is sampled every 50 ms. Anonymous and file-backed
PSS are recorded separately. One-second idle guards bracket CPU snapshots.

Both supplied bundles are copied through the same I/O path. Only the owned,
unused copies receive POSIX_FADV_DONTNEED, followed by identical hash/read and an
unscored animated warmup. The system cache is never dropped. This matters:
an exploratory comparison had about 14 MiB of extra executable file-backed PSS
on one side; normalizing the copies/cache removed that discrepancy. That earlier
comparison is not used as the final memory result.

All runs use one private GNOME headless Wayland session with a 960x720@60 virtual
monitor, isolated from the user's desktop. A separate embedded SolidJS animation
is compared in before/after/after/before order: two five-second CPU observations
per host, beginning 1.5 seconds after actual presentation. Native presentation
intervals must continue throughout each run. CPU percentage means one logical
core equals 100%. External compositor CPU and GPU memory are excluded.

The local report is `artifacts/native-transfer-benchmark.json`. Per-run traces
contain all pair timings. These are short, warm local workloads, not a
cross-framework, cold-start, physical-input or endurance comparison.

## Recorded result — 2026-10-20

Before source: `83e7fb3232f46e2e709c41be483757403fd819cbe1895c0f887848f9b4225f72`.
After source: `5b2a43bbea9228deea0fcb31fc77a6a0d96e463c4110232c9129cd07971bd1d3`.
CPU: Intel(R) Core(TM) Ultra 9 185H. Both are release JIT-only hosts with the same
Servo pin. The app's SDK is 0.5.0 on both sides.

CPU and peak PSS below are means across four fresh runs per host. Pair latency
is the pooled median of 128 verified set/get pairs per phase and host. PSS is
the largest sampled value in each run, not an exact instantaneous peak.

| Phase | CPU per 32 pairs, before → after | Pair latency, before → after | Mean sampled peak PSS, before → after |
| --- | --- | --- | --- |
| 13-byte Unicode value | 82.5 → 102.5 ms | 17.47 → 17.59 ms | 102.07 → 101.92 MiB |
| 1 MiB ASCII JSON | 972.5 → 975.0 ms | 46.36 → 46.28 ms | 197.66 → 195.30 MiB |
| 1 MiB escaped JSON | 2145.0 → 2030.0 ms | 87.02 → 80.86 ms | 245.98 → 243.29 MiB |

The escaped-document sample used 5.4% less CPU and had a 7.1% lower median pair
latency. ASCII CPU/latency were essentially unchanged. Mean sampled peak PSS
fell by 2.35 MiB for ASCII and 2.69 MiB for escaped JSON; anonymous PSS explains
most of that change. The small-request CPU observations were 82.5 → 102.5 ms
per 32 pairs, despite nearly equal pair latency. This is a small absolute cost,
not evidence of a universal CPU improvement.

The document app's first-presentation median was 187.4 → 239.6 ms, with ranges
166.1–248.7 and 218.3–272.4 ms. The separate two-run animated screen used about
22.5% → 24.3% of one core; native presentation medians remained near 16.7 ms.
These observations do not support a startup or rendering-speed improvement.
An additional alternating repeat is recorded separately below; neither startup
nor animation results should be replaced with the document-transfer gain.

### Additional animation/startup repeat

An additional private session ran four fresh processes per host in
`after/before/before/after/before/after/after/before` order, with no simultaneous
project builds or native suites. Each run verified the same 77 app elements and
continued native presentations. The source fingerprints match the comparison
above. Five-second CPU windows used the same 1.5-second settling interval.

Mean animated CPU in this block was 28.8% → 24.7% of one core,
with ranges 26.1–31.0% and 23.1–26.1%. This reverses the direction of the
first block's difference, so it does not establish a stable general rendering
CPU gain or regression. Presentation medians stayed near 16.7 ms.

This animated app's first-presentation medians were 339.7 → 352.7 ms;
ranges were 286.9–488.6 and 312.5–1691.9 ms. The after-first 1,691.9 ms outlier is
included, not discarded. These are different app/startup observations from the
document fixture and are not pooled with it. No startup improvement is claimed.
Local details are in `artifacts/jit-repeat.json` and its eight traces. The
tracked benchmark's animated phase reproduces the workload; this follow-up
changes the process order and number of repetitions only.

## Functional verification and retained memory

The current source passed the release build, 17 Rust tests, project Clippy with
warnings denied, formatting, eight pinned-engine patch checks and the seven
Linux integration gates in `artifacts/preview-audit.json`. Those gates cover
installed SDK/runtime packaging and relocation, Vite HMR, native clipboard
shortcuts and independent GTK clipboard, actual portal file open/save/cancel,
close decisions, 50/200 window lifetimes, abandoned requests and persistence.
The normal Notes bundle and local npm runtime match the tested source.

The 200-cycle run retained 23.38 MiB of settled PSS
(133.71 → 157.09 MiB). This is still unresolved; the document-transfer
improvement does not fix window-lifecycle retention. Settled file descriptors
were 28 → 28, and threads were 49 → 50. The static final idle sample
added 0 process CPU ticks over 3.894 seconds, a finite-resolution observation,
not zero CPU for animated applications. No physical keyboard/IME, clean-machine,
Windows/macOS or AOT validation is implied.

## Reproduction

Preserve the older prepared bundle before rebuilding the optimized host. Build
the release JIT host and its local npm packages, then:

```sh
node scripts/native-transfer-workflow.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/native-transfer-benchmark.mjs \
  target/package/weber-before-memory/weber target/package/weber-clipboard-jit/weber
```

The script makes its own normalized copies under `artifacts/native-transfer-hosts`.
The ordinary Linux acceptance suites and `scripts/preview-audit.mjs` validate the
current host/runtime packages independently of this performance comparison.

## Limits

A lower arena-count experiment reduced retained memory in one short window test,
but also increased CPU and window-cycle costs. No allocator override was made a
default. This optimization removes avoidable host work; it does not eliminate
all JS/host JSON transport, store-file rewriting, or retained memory after
repeated windows. It does not establish a general improvement in startup or
animated-rendering CPU, or qualify Weber as a completed Linux beta.

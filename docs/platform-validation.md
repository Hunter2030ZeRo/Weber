# Window controls and resource validation — 2026-10-20

This milestone extends the Linux developer beta foundation with native window
controls and bounded state snapshots. It is not a completed beta or a Hermes-only
DOM port. Windows/macOS and actual Hyprland integration remain unverified.

## Implementation

- `@weber/sdk/window`: logical-pixel resizing, maximize, borderless fullscreen,
  resizable and `onWindowsChanged`. Existing create/list/title/close remain.
- Native window protocol 2; strictly reject malformed IDs/booleans/dimensions,
  missing/closed windows, more than 64 queued mutations and invalid capabilities.
- A watch receives an initial app-wide snapshot and later changed state. It
  coalesces intermediate states, with one evaluation in flight per watching
  window and no idle polling. At most 64 SDK listeners share each window's native
  watch. Generation checks reject stale deliveries and acknowledgements.
- Close/navigation detach watches. Native state only refreshes for relevant
  window changes and commands; the preceding host rebuilt size/scale JSON on
  every window event, including redraw/input. This removes unnecessary repeated
  host work; it is not by itself proof of a measurable memory improvement.
- Native wakeups are coalesced behind one pending event. Read-only SDK requests
  no longer unconditionally enqueue redundant host wakeups.
- Page titles are truncated at a UTF-8 boundary to 1024 bytes, bounding snapshots
  consistently with explicit title requests. No graphics caches or browser
  features are disabled to lower resource measurements.
- AOT callbacks still travel through the existing SpiderMonkey DOM adapter to
  Static Hermes and back. JIT-only hosts continue to exclude Hermes/JSI.
- On Linux/glibc a lazy background worker returns unused allocator pages after
  window close, coalescing close bursts and canceling pending work on shutdown.
  It uses the MT-safe `malloc_trim` API; no allocator counters, forced JS GC,
  global allocator replacement or graphics-feature reductions are used by the
  production policy. See [the policy and opt-out](native-runtime.md#memory-after-window-teardown).

## Tests and measurements

Both optimized release hosts build and execute the native controls and resource
gates. Source SHA-256:
`6dc75527fadf7f2bc5bc1f546cd3fd01cd55c62a635215aee537353e790b6f04`.
Servo remains `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`, Static Hermes remains
`17b37301da5da4a2cd55d78f9697c46c0fd96123`; the native-unit ABI is unchanged.

The workflow builds four actual Vite/Solid/TypeScript applications through the
SDK: controls and resources, each with JIT-only and AOT output. The controls run
checks the DOM viewport as well as native snapshots. The resource run uses
80/1000 list rows, four simultaneous windows and 15 additional open/close cycles.
Process-tree PSS/RSS are sampled independently of the app, with no Bun enabled.
The small workload has 327 DOM elements in JIT and 331 with the AOT adapter;
the large workload has 4007/4011. Three additional windows each render their own
80-row app, while the primary keeps the 1000-row list. The root also has an input,
counter/button, scrolling area and CSS animation. These are separate fixtures
from the preceding 123.5MiB embedded desktop benchmark.

Both engines pass real resizing and DOM viewport agreement, maximize/unmaximize,
960×720 fullscreen and restoration, resizable changes, targeting a second window,
membership updates after close, ordered snapshot revisions, unsubscribe/re-subscribe,
five malformed-request rejections and the 64-listener bound. An initial snapshot
is followed by no additional callback during the 350ms unchanged-state check.
The native queue and stale-ack behavior have separate Rust unit coverage.

### Reclamation comparison

The same final binaries and app packages run with the policy enabled and with
`WEBER_RECLAIM=0`. Each configuration is one execution per engine, enabled first,
disabled second, on separate isolated GNOME Wayland sessions. PSS/RSS are sampled
every 150ms; phase medians use the 1.0–3.2s settled interval after each app marker.
These observations within a run are correlated, not independent launch trials.
They exclude compositor/system services and separately unaccounted GPU memory.
The initial enabled JIT run overlaps the final build/check activity; these runs
are not controlled input/frame-latency measurements or statistical proof.

| PSS median | JIT policy off | JIT on | AOT off | AOT on |
| --- | ---: | ---: | ---: | ---: |
| Initial 80 rows | 120.6MiB | 120.9MiB | 147.2MiB | 146.5MiB |
| 1000 rows | 169.2MiB | 167.3MiB | 214.3MiB | 212.9MiB |
| Four simultaneous windows | 214.1MiB | 213.7MiB | 295.1MiB | 296.1MiB |
| After closing three | 210.1MiB | 176.6MiB | 256.7MiB | 222.6MiB |
| After 15 additional open/close cycles | 254.4MiB | 188.5MiB | 318.3MiB | 231.5MiB |
| Back to 80 rows | 246.1MiB | 182.5MiB | 317.8MiB | 231.8MiB |

At cycle 15 this is 25.9% lower JIT PSS and 27.3% lower AOT PSS on this workload.
The policy primarily reduces retained memory after teardown, not initial memory
or the cost of simultaneously live windows. It does not establish leak freedom:
even after reclamation, later large-list measurements remain above their first
large-list phase and returning to a small DOM does not restore initial PSS.
JS heaps, caches and partially occupied allocator pages still need longer tracing.

Eighteen native window creation resolutions are timed per run (first three plus
15 cycles). JIT off/on medians are 47.36/47.96ms and AOT 36.70/37.30ms; p95 is
64.28/61.27ms and 74.74/49.51ms respectively. SDK resolution means creation,
not loaded app or first paint, and AOT's clock is its adapter-backed scheduler.
Compare policy configurations within an engine, not these timings across engines.
No input-latency or frame-time non-regression claim follows from this small test.
Enabled runs record 16 reclamation batches each; maximum worker duration is
4.52ms JIT and 4.99ms AOT. Moving the call off-thread does not eliminate allocator
contention. The single-window startup path creates no housekeeping worker.

A separate instrumented JIT diagnostic with one extra sampling thread returned
already-free pages once near the last phase: PSS fell from 243.8 to 173.3MiB.
Its `mallinfo2` counters are approximate/main-area diagnostics, not an accounting
of all live JS/GPU memory. The preload helper is an artifact only and is not
linked into or shipped with Weber. This motivated the compiled lifecycle policy;
the final comparison above uses no preload helper or allocator tuning variables.

### Initial embedded-demo comparison

An independent screen compares the preserved foundation JIT host with the final
JIT host on the same embedded 77-element Solid desktop. Eight alternating warm
launches per host and three separate steady runs per host (30 samples each)
produce the following results in the current isolated GNOME session:

| Metric | Preserved JIT host | Current JIT host |
| --- | ---: | ---: |
| Spawn to first native app presentation, median | 350.9ms | 386.3ms |
| Median of the three per-run settled PSS medians | 111.8MiB | 125.6MiB |

This screen reports approximately 10.1% longer startup and 12.4% higher initial
PSS. It does **not** demonstrate an initial-startup/memory improvement; it remains
an unresolved regression for further profiling. The old historical 230.3ms /
123.5MiB run used an earlier session and must not replace these contemporaneous
paired results. Startup has a wide distribution (old p95 437.5ms, current 462.7ms),
so this small screen does not establish the exact causal latency increase.

Both snapshots have the same 77 elements, input/counter/list state and layout;
all ten private library hashes are identical. The housekeeping worker is lazy
and never starts in this single-window workload. Two follow-up mapping diagnostics
also observe higher current PSS, with variation in allocator-retained heap.
In the final one, executable `r-xp` pages total 47.9MiB in the old process and
59.6MiB in the new process; file-backed `r--p` pages total 15.3/17.2MiB. Anonymous
and heap RSS are lower in the new process in that diagnostic. The executable's
total `.text` grew by only about 37KiB and `.rodata` size is unchanged, so resident
code-page differences are not equivalent to adding 12MiB of code. Exact hot
functions/link layout/kernel fault-around behavior have not been isolated.
These mapping observations identify where memory is resident, not why each page
became resident. No lazy-metadata or linker workaround was introduced on speculation.

Reclamation after window teardown and initial process cost are therefore distinct
results. AOT remains experimental; the new resource results do not satisfy or
replace its startup-and-memory product gate.

### Verification records

CPU utilization was not part of the original milestone run. A subsequent
[direct CPU measurement](../artifacts/cpu-validation/README.md) records two
10-second runs per engine in each condition: paused motion observes no CPU tick
increase; continuous rAF state/DOM updates average 23.41% JIT / 33.65% current AOT,
normalizing one logical CPU to 100%. These exclude the compositor and Bun and
do not establish equal FPS, power or long-duration behavior.

- [Enabled native controls/resources](../artifacts/platform-native.json)
- [Same binaries, reclamation disabled](../artifacts/before-reclaim-platform-native.json)
- [Compiled Vite/JIT/AOT fixtures](../artifacts/platform-workflow.json)
- [Before/after embedded JIT comparison](../artifacts/platform-benchmark.json)
- [Final package/source audit](../artifacts/platform-audit.json)
- [Fixture audit saved while temporary apps were present](../artifacts/platform-audit-at-validation.json)
- [Bun multi-window/subscription regression](../artifacts/platform-bun-native.json)
- [Initial mapping diagnostic](../artifacts/platform-validation/initial-memory.json)
- Rust unit, format and both-feature Clippy logs: `artifacts/platform-unit.log`,
  `platform-clippy-jit.log`, `platform-clippy-aot.log`; JS syntax checks pass.

Four Rust unit tests pass. Five standalone AOT contracts (AOT/browser/Solid/
scheduler/lifetime) pass on the final host. The existing three-window Bun test
also passes on both final hosts: ordered events/end, error delivery, unsubscribe,
blocked-UI overflow, completed-subscription slot bounds, owning-window pending
call/stream cleanup, backend death and last-window child reaping. Its app is built
fresh through the npm/Vite SDK; previous foundation report files are preserved.

After an execution interruption, the temporary `/tmp` fixture directories were
no longer available for a repeat asset audit. The successful earlier fixture
audit is retained separately. The final audit rechecks retained host/library
hashes, current source identity and completed report identities, explicitly
records unavailable temporary fixtures and does not claim to revalidate their
missing files. Re-running the fixture workflow creates fresh test apps.

The initial native test attempted a forced size while GNOME had auto-maximized
the initial window. The corrected test explicitly unmaximizes before requesting
the target size, respecting the documented compositor-controlled contract.

The compositor can restore a different size after exiting fullscreen. The test
records the returned size, requires the DOM to match it, and then explicitly
requests 640×480. On isolated GNOME, one observed restore returned 640×515,
including a 35px height difference whose exact cause was not established. The SDK does
not promise restoration to an exact former size. This is separate from the
successful fullscreen-size and explicit-resize requirements.

## Reproduction

Package the two current hosts before running fixtures. Keep the preceding
foundation hosts intact for the before/after benchmark.

```sh
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --features layer-shell
python3 scripts/package.py --profile release --binary target/optimized/release/weber-servo --output target/package/weber-platform-jit
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --features aot,layer-shell
python3 scripts/package.py --profile release --binary target/optimized/release/weber-servo --output target/package/weber-platform-aot
# First install if the temporary npm cache is empty:
WEBER_NPM_ONLINE=1 node scripts/platform-workflow-smoke.mjs
# With the cache populated:
node scripts/platform-workflow-smoke.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/platform-native-smoke.mjs
WEBER_RECLAIM=0 WEBER_PLATFORM_VARIANT=before-reclaim dbus-run-session -- node scripts/headless-wayland.mjs scripts/platform-native-smoke.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/platform-benchmark.mjs
CARGO_TARGET_DIR=target/optimized cargo test --release --locked --features layer-shell --bin weber-servo
```

`WEBER_CONTROLS_ONLY=1` on the native test selects the shorter functional gate.
`WEBER_NPM_CACHE` overrides the fixture's temporary npm cache location.
Native gates require private compositor/socket permission and do not use the
user's desktop session. These are programmatic UI tests, not physical keyboard,
Korean IME, accessibility, scaled-output, GPU-memory or long-duration validation.

Clipboard/file dialogs/application paths, recovery and broader platform APIs
remain subsequent beta work. The locked browser profile and cross-framework
benchmarks are not part of this milestone.

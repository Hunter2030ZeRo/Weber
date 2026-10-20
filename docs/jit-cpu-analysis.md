# JIT CPU investigation — 2026-10-20

## Decision

Prioritize Servo/SpiderMonkey JIT for the developer beta. Further Static Hermes
integration, including a Hermes-only DOM port, is deferred. The existing compiled
experimental AOT/SpiderMonkey-adapter implementation and its evidence remain.
The current measurements do not establish an AOT advantage; this does not prove
that every future AOT implementation must lose.

## Uninstrumented workload isolation

Prepared release JIT host: `target/package/weber-platform-jit/weber`.
Source fingerprint: `6dc75527fadf7f2bc5bc1f546cd3fd01cd55c62a635215aee537353e790b6f04`.
Executable SHA-256: `d88200132021fe41936cc6c283800f8b8e3067d7f8c02870324c427e932a6035`.
No production code or demo behavior was changed for this investigation.

Isolated GNOME headless Wayland, 960×720 virtual monitor at 60 Hz. The existing
built-in Solid desktop is loaded through file wrappers referencing its unchanged
assets. Each variant starts a new process, warms the application for 2 seconds
and the variant for 1.5 seconds, then measures for 6 seconds. Five variants run
in forward and reverse order, twice each. CPU is process user + system time from
`/proc`, including all Weber threads; 100% means one logical CPU. The host has
22 logical CPUs. Compositor, GPU execution time and Bun are excluded. There is
no Bun child in these cases.

Existing Servo logs identify **Mesa Intel Arc Graphics (MTL), OpenGL 4.6,
Mesa 26.2.4-arch3.1** for every run. This investigation did not fall back to a
software GL renderer. This finding does not identify the renderer in older runs.

| Workload | CPU, weighted across two runs | Individual runs | rAF callbacks/s |
| --- | ---: | --- | --- |
| Original Solid counter + timestamp + orb transform | 28.09% | 28.49%, 27.70% | 59.99, 59.99 |
| Original animation paused; rAF callback increments an internal counter only | 1.16% | 1.17%, 1.16% | 33.16, 33.33 |
| Original animation paused; raw JS updates orb transform only | 17.50% | 19.19%, 15.82% | 59.99, 59.99 |
| Original animation paused; raw JS updates existing counter/timestamp text nodes only | 22.78% | 23.20%, 22.36% | 59.99, 59.66 |
| Original animation paused; CSS transform animation only | 18.98% | 19.76%, 18.19% | Not measured |

The CSS variant checks that computed transforms actually change. rAF callback
frequency is not a measurement of physical scanout or unique displayed frames.
The no-DOM-change rAF runs at about 33 Hz, so its CPU cannot be treated as a
60 Hz equivalent. CSS interpolation and raw JS variants also differ from the
original Solid workload. These are diagnostic isolation cases, **not equivalent
optimizations, additive cost components, or a production speedup**.

The original workload uses about 4.61–4.75 aggregate CPU milliseconds per rAF
callback. That is total process CPU time across threads, not UI latency or frame
wall time. The original full workload was 23.4% in the preceding session;
28.1% here is a different session and short sample set, not proof of a code
regression. The preceding fully paused test detected no CPU ticks over two
10-second windows per engine; see [its method](../artifacts/cpu-validation/README.md).
Zero detected ticks does not mean zero CPU indefinitely.

## Where CPU time accumulates

Thread deltas during the original full workload, averaged by total elapsed time:

| Thread / group | CPU in one-core percent |
| --- | ---: |
| Main `weber` thread | 9.00% |
| `Script#1` | 8.42% |
| WebRender render backend | 2.58% |
| WebRender scene builder | 2.42% |
| Two style threads combined | 3.75% |

Thread names locate broad work, not individual functions. Script-thread time
includes browser/DOM/layout work and is not synonymous with JS bytecode/JIT.
Ticks on threads that start/exit between snapshots may be omitted. Even with
CSS-only animation the main thread consumes about 9.24% and Script about 2.50%.
Merely moving the animation to CSS has not removed the rendering cost here.

The evidence supports prioritizing frame invalidation, style/layout and
rendering/presentation work. It does not establish JIT compilation as the main
cause, and it does not quantify a specific avoidable renderer cost yet.

## Source inspection and limits

- The Solid demo updates two text outputs and a transform each rAF in
  `app/src/compatibility-app.tsx`; it is an active 60 Hz DOM workload.
- `src/host.rs` paints and presents on a native redraw request. The event loop
  uses `ControlFlow::Wait`; this is not an unconditional busy-render loop.
- Servo `components/paint/painter.rs::render` clears the background and calls
  WebRender `render(size, 0 /* buffer_age */)` on each paint. Damage-aware
  presentation/buffer-age handling is a concrete investigation candidate, not
  an implemented optimization. The cost of the clear itself is not measured.
- Both the host redraw path and Servo painter call `make_current`. This is a
  potentially redundant operation; its actual cost is not established and it
  was not changed speculatively.
- Servo's default Baseline and Ion JIT preferences are enabled; the host uses
  the Servo `js_jit` feature. This is not a JIT-disabled comparison.

`perf record` could not collect a call graph: software-event attachment,
hardware-event attachment and direct-child hardware recording were denied by
current kernel permissions. A simple `perf stat` count on `/usr/bin/true` worked,
which does not establish access to sampling. No kernel setting was changed.
See [profiling status](../artifacts/jit-cpu-analysis/profile.json). **No function
profile or built-in Servo timing trace was collected.** A diagnostic build with
Servo's existing time profiler is the next available path if sampling remains
unavailable; its wall-time spans must not be reported as CPU percentages.

## Follow-up boundary

Keep the original workload, frequency and assets as the comparison gate. First
measure render/present and style/layout phases, then evaluate unnecessary
invalidations and damage-aware rendering. A production fix must be compiled and
compared against the same workload with native interaction and idle checks.
Changing to a cheaper animation, reducing update frequency, or hiding the window
must be reported as a workload change, not a framework performance improvement.
No equivalent-workload CPU reduction has been demonstrated in this investigation.

## Reproduction and raw evidence

From the repository root:

```sh
rtk proxy dbus-run-session -- node scripts/headless-wayland.mjs artifacts/jit-cpu-analysis/measure.mjs
```

The helper is diagnostic material outside the production source fingerprint.
[Results](../artifacts/jit-cpu-analysis/results.json) retain the build identity,
per-run totals, actual renderer, per-thread deltas and telemetry trace paths.
The optional `profile` argument attempts direct-child `perf record`; failures
are recorded separately and must not be mistaken for completed profiling.

# Renderer font lifetime optimization

Linux Wayland, Servo/SpiderMonkey JIT, SDK 0.5.0 — 2026-10-20.
Continuation of the [Stylo cache work](window-resource-optimization.md).
No application API or SDK version changes; Static Hermes remains deferred.

## Cause and implementation

Servo's system-font service retained renderer-specific font keys, font-instance
keys and two batches of unused keys after the renderer's last WebView closed.
The pinned code explicitly recorded the missing removal as a TODO.

The [patch](../patches/servo-font-lifecycle.patch) groups all four caches by
`PainterId`. The constellation registers the renderer before starting layout,
and removes its cache after the last WebView using that renderer closes.
Auxiliary/window.open creation registers before releasing its waiting script.
Several WebViews may share a renderer, so closing one must not retire the others.

Late layout requests during shutdown receive namespace-correct dummy keys, using
the same convention as Servo Paint's existing missing-renderer handling. They
cannot create a new cache or request another batch from Paint. There is no
accumulating set of retired identifiers, global GC or periodic cleanup task.
System font discovery and shared font data remain cached normally. The outer
map may retain capacity for peak concurrent renderers, rather than the number
of all previously closed windows.

## Measured native lifetime result

The preserved installed SDK fixture creates and closes 1000 actual child windows,
uses an 80-row document/input, abandons 31 owned storage requests per child and
checks parent cleanup and isolation. Private GNOME headless Wayland uses
960x720@60; no forced GC or allocator substitution is used. Measurements request
Servo's existing diagnostic reports after quiescence. This is the same workload
as the previous Stylo increment, with its fixture unchanged for the comparison.

Before: `e4fc3e6`, source
`df0d61ebb0d3f9a28ea56f7cddf4a0c9eb7f778a31bc58f6e5c828682c89c5ad`.
After source:
`38dfc3415af9355d1041b93899b12fb17dad309a68d722e4ff7790623eaa8423`.
Both are release JIT builds at the same Servo/Stylo pins. An earlier fixed run
(`5163265a6355528a4e60e2db657bee0ae60f2c1e593fbbe1034f88a76c819eb1`, before
strengthening test activation waits) also kept the font counter flat at
112,196 bytes and added 4.53 MiB native heap across 1000 windows. The production
font patch is identical between the two fixed runs.

| Measurement | Before | After |
| --- | ---: | ---: |
| System-font service, initial → settled | 112,072 → 1,756,200 B | 112,164 → 112,164 B |
| Additional font-service bytes, cycle 200→1000 | 1,282,816 B | 0 B |
| Added native system heap, initial → settled | 6.08 MiB | 4.46 MiB |
| Added native system heap, cycle 200→1000 | 3.00 MiB | 1.75 MiB |
| Added process-tree PSS, initial → settled | 23.56 MiB | 21.50 MiB |

The font service stayed at 112,164 bytes at every recorded checkpoint. The new
regression budget allows at most 256 KiB font-service growth after cycle 200;
the recorded baseline would exceed it. The existing 8 MiB native-heap budget
also passed. These are provisional workload budgets, not zero-leak certification.

PSS after the change was 121.79→143.28 MiB. PSS varies with allocator, driver,
shared mappings and diagnostic effects; this small comparison does not establish
an exact total-memory saving for every app. Engine counters overlap and must
not be added to PSS. External compositor/GPU memory is excluded. Other native
and JS growth remains; a flat font counter is not a claim that Weber as a whole
has no leaks. File descriptors stayed 28→28. Threads were 50→51 before and
49→50 after; that one-thread starting difference is another reason not to read
the PSS difference as an exact cache allocation count. Settled static
checkpoints recorded zero CPU ticks at the sampling resolution.

Raw local evidence: `artifacts/font-resource-comparison.json`,
`font-before-resource-1000.json`/`.jsonl`, `font-first-resource-1000.json`/`.jsonl`
and `resource-1000.json`/`.jsonl`.

## Functional and input validation

The release build, 19 Weber Rust tests, seven font tests (including the new
retirement/channel test), project Clippy and formatting passed. The font test
makes 64 late request rounds after retirement and checks that another painter
still receives real keys; no late request reaches Paint or recreates a cache.
The nine ordered Servo patches match the pristine pin and the compiled checkout;
the existing Stylo archive/patch preparation also matches.

Native checks passed on the final source: 1000 lifetimes, 50 alternating
80/600-row windows with serif/monospace, varying sizes/weights and Unicode, the
55-checkpoint JIT ownership stress, and all seven ordinary functional/package
gates (files/clipboard, close decisions, storage/restart, 50/200 lifetimes,
installed npm SDK/runtime, relocation and Vite HMR). The normal Notes package
contains no preview probe. These native cases use distinct window renderers;
there is no dedicated shared-rendering-context or window.open native case here.

One preview attempt and the first input benchmark initially timed out obtaining
compositor focus. A fresh-session retry passed the preview. The test helper now
waits for current native focus before attempting Alt-Tab, can dismiss Overview
only on the private test display, and checks the latest focus state rather than
an old positive event. The preview's initial activation uses the same helper.
Final input runs passed with the focus guard enabled before every injected key;
no input assertion was skipped. This is a test-activation fix, not a claim that
application activation tokens or physical IME are complete. Initial failure logs
are retained under `artifacts/font-first-focus-failure-*` and
`font-first-font-desktop-benchmark-session.log`.

## Animation, startup and input screen

The unchanged built-in SolidJS animation/input/scroll screen ran in release JIT
mode; the alternating CPU screen checks 77 app elements in every process. The
tracked desktop benchmark now supports a JIT-only host without inventing an AOT
result. Twelve scored warm-filesystem launches per host followed one warmup;
these two startup batches are sequential, not an interleaved causal experiment.
Forty trusted OS Enter events per host changed the counter to its exact expected
value, with a native presentation after the DOM acknowledgement.

| Screen | Before | Final |
| --- | ---: | ---: |
| Median parent spawn → first native app presentation | 239.21 ms | 230.01 ms |
| Startup range, 12 processes | 229.49–271.45 ms | 217.55–246.27 ms |
| Median host input → acknowledged native presentation | 26.36 ms | 26.29 ms |
| Input p95 | 32.74 ms | 33.24 ms |
| CPU during one eight-second animated memory screen | 12.00% | 11.54% |

CPU is process user+system time, with one logical core = 100%; compositor and
external GPU work are excluded. Input begins at the host event, not physical
key travel, and presentation is not optical scanout. The app/assets and update
frequency are unchanged. These numbers do not establish a universal startup or
CPU improvement.

A separate interleaved four-process-per-host CPU repeat gave **13.75→14.59%**
(means; ranges 13.19–14.73% and 13.33–15.52%). The first fixed-build repeat had
given the opposite direction, **14.19→13.36%**. No CPU affinity/frequency policy
was fixed. CPU improvement is **not established**, and the higher final repeat
must not be hidden by selecting the favorable single eight-second trial.

A separate opt-in instrumented run put about 4.0 one-core percent on Script,
3.8 on the main thread and 2.8 on WebRender backend/scene threads during its
settled five-second window. Its phase samples, including startup, averaged
0.60 ms main-thread CPU for paint, 0.114 ms for present and 0.0049 ms for the
outer make-current call. The inner Servo make-current is not isolated. These
instrumented spans and thread windows cover different periods and are not
additive percentages. They support investigating rendering and script/layout
work rather than claiming that deleting the outer context call will solve CPU.

Raw data: `artifacts/style-cpu.json`, `font-first-style-cpu.json`,
`font-desktop-benchmark.json`, `font-before-desktop-benchmark.json`,
`font-frame-profile.json` and their traces. The instrumentation is separate
from the uninstrumented alternating comparison. No function-sampling profile
or new kernel profiling permission was obtained.

## Normal packaged Notes: idle and unresolved initial PSS

The unmodified production Notes assets were loaded by both hosts; no preview or
polling probe was injected. Four interleaved fresh launches per host gave
parent-spawn → SDK DOM-ready medians of 212.55 ms before and 215.62 ms after.
These are **DOM-ready**, not first-native-presentation timings or a guarantee
that persisted app data has finished loading. The existing post-ready first-app
presentation marker was absent from one earlier static baseline launch, so it
was not silently replaced by DOM ready under the same metric name.

Three focused ten-second idle windows per host (one initial pair, followed by
before/after/after/before repeats) recorded zero process CPU ticks. The clock
has 10 ms resolution; this is no detected CPU use in these intervals, not zero
CPU indefinitely, physical keyboard/IME validation or a focused-caret test.
All six measured idle windows had a first-app-present event.

**Initial total PSS did not improve.** Per-window median PSS was 101.19–107.67 MiB
before and 113.81–115.29 MiB after across those three runs per host. The detailed
repeat separated anonymous PSS (before 32.11/37.99 MiB, after 32.04/32.22 MiB)
from file PSS (before 68.81/69.34 MiB, after 82.50/82.61 MiB).

A follow-up streamed both complete executables/private libraries into file cache
identically, without dropping global caches, then measured another five-second
focused idle window each. PSS was 107.31→114.42 MiB; anonymous PSS was
38.14→32.12 MiB and file PSS 68.83→82.02 MiB. Private library hashes match exactly.
The executable's grouped mapping PSS was 65,332→78,284 KiB, although the new
executable itself is about 20 KiB smaller. The file-mapping difference therefore
must not be dismissed as simply an increased executable file size or declared
solved by cache warming. Code layout/page-fault behavior and executed paths have
not been isolated as causes.

The retained-cache improvement and this single-window resident-file increase
are different observations. Do **not** promote this increment as a general
lower-memory framework result or a passed overall performance gate. Investigate
initial executable residency next, before wider memory claims or beta promotion.
The current implementation remains a development snapshot. Raw evidence:
`artifacts/font-notes-initial.json`, `font-notes-repeat.json`,
`font-notes-warm.json`, `font-notes-warm-cache.json` and their traces.

## Reproduction

After bootstrap and release preparation, with local npm SDK/runtime artifacts:

```sh
python3 scripts/check-servo-patches.py
python3 scripts/prepare-stylo.py --offline --check
CARGO_TARGET_DIR=target/optimized cargo test --release --locked --offline -p servo-fonts --tests
node scripts/resource-workflow.mjs --cycles=1000
dbus-run-session -- node scripts/headless-wayland.mjs scripts/resource-native.mjs --cycles=1000
node scripts/resource-workflow.mjs --cycles=50 --styles
dbus-run-session -- node scripts/headless-wayland.mjs scripts/resource-native.mjs --cycles=50 --styles --disabled
WEBER_REPORT_PREFIX=font- dbus-run-session -- node scripts/headless-wayland.mjs scripts/desktop-benchmark.mjs target/package/weber-clipboard-jit/weber
```

The ordinary functional/package gates are also required before preview-audit.
This increment does not establish Windows/macOS, physical Korean IME,
Hyprland integration or clean-OS packaging support.

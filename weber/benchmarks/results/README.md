# Recorded development comparisons

These are actual measurements, including regressions. They are not estimates of
general application compatibility or production performance.

## Final verification: 56cfe40

[CI run 34433240209](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34433240209)
passed all 13 runtime gates, all three extracted backends and evidence
collection. Runtime and benchmark source are unchanged from ebc3f31; this commit
adds observation of Monaco's actual module-worker error. The differing timings
are another runner sample, not evidence of another implementation speedup.

| Median metric | Electron 42.0.0 | Weber |
| --- | ---: | ---: |
| Small fixture process-tree PSS | 373.945 MiB | 174.117 MiB |
| Startup to paint and capture | 465.365 ms | 204.172 ms |
| JavaScript round trip | 0.246 ms | 0.344 ms |
| IPC observed through executeJavaScript | 0.424 ms | 0.822 ms |
| Warm renderer-originated IPC | 0.175 ms | 0.288 ms |
| Small DOM update, two frame callbacks and PNG capture | 48.634 ms | 44.156 ms |
| 64-call IPC burst | 2.389 ms | 3.766 ms |
| 512 updates, two frame callbacks and both captures | 49.818 ms | 73.246 ms |
| Extended process-tree PSS | 414.795 MiB | 222.344 MiB |
| Small and extended idle CPU, one core | 0.000 % | 0.000 % |

Small capture was faster in this run; serial IPC, concurrent IPC and larger
component updates remained slower. Their Weber/Electron time ratios were
approximately 1.65, 1.58 and 1.47. The previous run's near-parity burst result
did not persist. The goal of matching Electron is still unmet across workloads.
Both development runs show substantially lower synthetic process-tree PSS;
neither establishes VS Code memory or performance. Capture timing includes frame
callbacks and PNG encoding, not just UI business logic or input-to-display delay.

[56cfe40-summary.json](56cfe40-summary.json) contains exact values and the raw
artifact link. Three launches per framework, identical app code, unsandboxed
Xvfb and CPU tick resolution have the same limitations described below. Monaco
passes seven individual checks but its worker fails with `Unexpected token
'export'`; the whole VS Code entry still stops at missing `crashReporter`.

## IPC/frame optimization build: ebc3f31

[CI run 34432683003](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34432683003)
passed 13 runtime gates and Node/Bun/native execution after archive extraction.
The same application ran three times per framework, with both the existing
workloads preserved and a final renderer-originated IPC measurement added.

| Median metric | Electron 42.0.0 | Weber |
| --- | ---: | ---: |
| Small fixture: process-tree PSS | 376.510 MiB | 175.297 MiB |
| Startup to paint and capture | 638.257 ms | 250.819 ms |
| JavaScript round trip | 0.305 ms | 0.511 ms |
| IPC observed through executeJavaScript | 0.561 ms | 1.245 ms |
| Warm renderer-originated IPC | 0.248 ms | 0.486 ms |
| Small DOM update, two frame callbacks and PNG capture | 48.996 ms | 49.595 ms |
| Small fixture idle CPU, one core | 0.000 % | 0.000 % |
| Extended: 64-call IPC burst | 5.101 ms | 5.402 ms |
| Extended: 512 updates, two frame callbacks and both captures | 65.308 ms | 96.111 ms |
| Extended process-tree PSS | 416.450 MiB | 219.735 MiB |
| Extended idle CPU, one core | 0.480 % | 0.000 % |

Warm IPC is measured inside a single renderer script, with 200 warm-up invokes
and 500 timed sequential invokes through the same isolated preload API. The
report aggregates the three per-trial means; it does not compare a minimum with
Electron's median. The original IPC metric remains and includes an additional
executeJavaScript request/completion around every invoke.

Small capture and burst traffic were close in this run. Serial IPC still took
about 1.96 times Electron's time even after excluding evaluation transport;
the larger component phase took about 1.47 times as long. This does **not** meet
the target of matching or beating Electron across these workloads. A prior
successful run of the JSON/frame changes, `d1c97ab`, measured component and burst
ratios around 1.44 and 1.91 respectively. Shared-runner variation prevents
claiming stable burst parity from the latest run alone.

Changes reduce context entries, host event serialization, output thread hops,
private JSON tree copies and duplicate capture/presentation buffers. The tests
retain actual document changes, frame waits, PNG output and input/result checks.
There is no same-run ablation that assigns a precise speedup to each change.

The synthetic PSS ratios are 46.6% and 52.7%. They cannot be multiplied by VS
Code's memory use. Idle zero means below CPU tick resolution in the short
sampling interval. All results remain development Xvfb measurements without
an OS sandbox. [ebc3f31-summary.json](ebc3f31-summary.json) records exact values
and links to raw process trees, executable hashes and samples.

## Native compatibility and wake-driven runtime: a4cf783

[CI run 34424348801](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34424348801)
passed all 12 runtime gates and all three extracted backend checks. The original
small-fixture comparison and the added concurrent IPC/component workload each
completed three trials per runtime. Both used the same application files under
Xvfb without an OS sandbox. The VS Code diagnostic remained a recorded failure
to start the application, not an acceptance pass.

| Median metric | Electron 42.0.0 | Weber |
| --- | ---: | ---: |
| Small fixture: process-tree PSS | 378.616 MiB | 179.749 MiB |
| Startup to paint and capture | 614.744 ms | 295.491 ms |
| JavaScript round trip | 0.266 ms | 0.505 ms |
| IPC round trip | 0.477 ms | 1.165 ms |
| DOM update and PNG capture | 48.608 ms | 56.918 ms |
| Idle CPU, one core | 0.000 % | 0.000 % |

The second workload runs after the original idle samples, so the larger DOM and
IPC bursts are not mixed into the small-fixture PSS result. Each window contains
1,000 row elements. Each component update changes 256 elements per window,
waits two animation frames and captures both windows. Each IPC burst issues
32 concurrent invokes per window and verifies all 64 results.

| Extended workload median | Electron 42.0.0 | Weber |
| --- | ---: | ---: |
| Process-tree PSS after workload | 418.683 MiB | 224.814 MiB |
| 64-call IPC burst | 3.361 ms | 7.585 ms |
| 512 component updates and two captures | 66.373 ms | 101.666 ms |
| Idle CPU, one core | 0.000 % | 0.000 % |

Zero CPU means below the per-process CPU tick resolution in roughly two seconds
of sampling. All three Weber baseline trials recorded no added CPU ticks. The
previous f574b9e baseline measured about 1.98% of one core. The runtime now waits
for actual work instead of periodically polling, but this short fixture does
not establish zero idle cost for arbitrary applications.

Memory remained lower than Electron in both workloads. The PSS ratio increased
from about 47.5% in the small fixture to 53.7% in the component workload, so a
fixed percentage should not be extrapolated to VS Code. The earlier Weber
baseline was 181.9 MiB; the current small-fixture result is 179.7 MiB, a modest
change rather than a new large memory reduction.

IPC and component-update latency still lag Electron. There was no same-build
unbatched control trial; the new batching mechanism reduces transport messages
and native bridge entries, but this comparison does not isolate its speedup.
Shared CI runner timings also vary, so absolute differences between separate
runs must not all be attributed to implementation changes. Full raw samples,
process trees and executable hashes are in the linked artifact.

[a4cf783-summary.json](a4cf783-summary.json) records exact values and artifact
links. Older reports below remain available as evidence, including regressions.

## Initial Release comparison: 45f90ac

[CI run 34376507472](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34376507472)
completed all six benchmark trials. Both frameworks ran identical application
files with two windows under Xvfb, without an OS sandbox. C++ and Rust used
Release builds. Startup includes loading, first-render readiness, showing the
windows, two animation frames and PNG captures. OS caches were not flushed.

| Median metric | Electron 42.0.0 | Weber | Weber / Electron |
| --- | ---: | ---: | ---: |
| Whole process tree PSS | 396,883,968 bytes | 192,269,312 bytes | 0.484 |
| Whole process tree summed RSS | 923,574,272 bytes | 299,454,464 bytes | 0.324 |
| Startup to paint and capture | 645.010 ms | 334.581 ms | 0.519 |
| JavaScript round trip | 0.263 ms | 0.976 ms | 3.707 |
| IPC round trip | 0.464 ms | 2.289 ms | 4.937 |
| DOM mutation and PNG capture | 32.813 ms | 40.391 ms | 1.231 |
| Idle CPU, percent of one logical core | 0.479% | 10.305% | 21.515 |

PSS apportions shared mappings. Summed RSS can count shared mappings several
times, so PSS is the principal memory comparison. This fixture showed lower
memory and startup time, but worse IPC, capture and idle CPU results. It does
not establish a general performance advantage, Tauri-level resource use or
VS Code performance.

[45f90ac-summary.json](45f90ac-summary.json) contains the exact summary extracted
from the CI log. The linked Actions artifact contains the full samples, binary
hashes and process trees. The overall workflow failed its separate GTK menu
input test; benchmark completion is not misrepresented as a fully passing build.

The observed idle regression motivates removing empty preload dispatcher work
and repeated retained-style scans. Subsequent results must identify their exact
commit and retain the original measurements above.

The network/authentication continuation is recorded in
[1219c94-summary.json](1219c94-summary.json). Its small-fixture median IPC remains
slower on Weber (1.207 ms versus Electron 0.542 ms), while DOM update and capture
are close (50.17 ms versus 48.90 ms). These are three-trial fixture measurements,
not VS Code measurements or evidence of whole-app equivalence.

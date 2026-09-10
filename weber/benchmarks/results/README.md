# Recorded development comparisons

These are actual measurements, including regressions. They are not estimates of
general application compatibility or production performance.

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

# Recorded development comparisons

These are actual measurements, including regressions. They are not estimates of
general application compatibility or production performance.

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

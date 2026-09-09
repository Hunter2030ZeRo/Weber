# Reproducible Electron / Weber comparison

The app in `app/` is executed unchanged by both frameworks. It creates two
visible 768 x 512 windows containing 100 DOM rows each, loads the same isolated
preload script, and runs the same JavaScript, IPC and DOM/capture operations.
Functional assertions verify results and that captured pixels change after
document updates. There is no assertion that Weber must win.

Electron **42.0.0** is pinned. Its npm release was verified before adding this
benchmark; the harness also checks the running executable's actual version.
Install it separately from the framework checkout, then pass its real executable:

```sh
npm install --prefix /tmp/weber-electron-baseline electron@42.0.0
node /tmp/weber-electron-baseline/node_modules/electron/install.js
xvfb-run -a node weber/benchmarks/compare.cjs \
  --electron /tmp/weber-electron-baseline/node_modules/electron/dist/electron \
  --node /absolute/path/to/node \
  --bootstrap "$PWD/weber/electron-runtime/bootstrap.cjs" \
  --output "$PWD/weber-benchmark-result.json"
```

Set `WEBER_DESKTOP_HOST` and `WEBER_OBSCURA_RENDERER` to the built executables
before running. The harness opts both frameworks into the same **unsandboxed
development comparison**: Electron receives `--no-sandbox`, the common app uses
`sandbox: false`, and Weber receives its explicit development opt-in. Neither
result represents a production sandbox configuration.

The explicit installer is required because [Electron 42 removed its postinstall
download](https://electronjs.org/blog/electron-42-0). Measurements start the actual
binary after installation, so downloading is excluded from startup timings.

Three launches per framework are run sequentially, alternating order. OS page
caches are not flushed. The output contains every sample, executable versions,
the observed process trees, medians and Weber/Electron ratios. Ratios below one
mean less time, memory or idle CPU for this workload; they are not a general
performance result.

The report also records `GITHUB_SHA` when actually provided, SHA-256 and byte
size for both framework executables, Node, the GTK host and Obscura renderer,
and hashes for every application file, the bootstrap and compiled Electron
source manifest. Nearby `CMakeCache.txt` files supply the actual
`CMAKE_BUILD_TYPE`; a missing cache, missing entry or empty build type is
reported explicitly. A release build is never inferred from its filename.
Hashes are computed before the timed trials, which can warm the filesystem
cache; these measurements are not cold-cache startup measurements.

Between trials the runner verifies its detached process group, allows a short
normal shutdown interval, and then uses bounded SIGTERM/SIGKILL escalation if
needed. PID start times prevent signaling a reused process group without proof
of ownership. The directly spawned child must be reaped before the next trial.
Previously observed children that move outside the group cause the comparison
to fail; they are not searched for or signaled as arbitrary external processes.
Cleanup status is included with each successful trial.

Metrics:

* Startup: parent process spawn until both documents load, emit `ready-to-show`,
  are shown, pass two animation-frame callbacks and complete PNG capture. Both
  runtimes use the same sequence. It includes application/preload initialization.
* JavaScript: 30 serial Promise evaluations through `executeJavaScript`.
* IPC: 15 serial renderer-to-preload-to-main invocation round trips, observed
  through `executeJavaScript`.
* DOM/capture: ten changes to visible text and geometry, each followed by capture.
* Idle: after 500 ms of settling, five process-tree samples 500 ms apart. CPU
  totals process user/system ticks; 100% means one logical CPU. Results are
  omitted when the observed process set changes.
* Memory: `/proc/PID/smaps_rollup` for the **entire application descendant tree**,
  including Weber's Node process, GTK host and every Obscura renderer, and
  Electron's browser, renderers and other child processes. PSS apportions shared
  mappings; summed RSS can count shared mappings multiple times. Missing samples
  are recorded as errors rather than silently counted as zero.

The display server is external to both process trees. Kernel/driver allocations,
GPU memory, packaging size, peak memory and cold-cache startup are not measured.
Xvfb and a shared CI runner differ from an interactive desktop. This small HTML
workload cannot establish VS Code performance, general web compatibility or
production security. Keep raw results even when they show regressions.

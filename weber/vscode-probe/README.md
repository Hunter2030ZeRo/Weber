# VS Code startup diagnostic

This downloads the pinned official Linux x64 VS Code 1.136.2 distribution,
extracts only its `resources/app` directory and runs its unmodified application
entry through Weber's Electron-source bootstrap. It records the first actual
startup exception, timeout or exit. It does not run the bundled Electron binary
and does not mark VS Code as working.

```sh
WEBER_UNSANDBOXED_DEVELOPMENT=1 xvfb-run -a python3 weber/vscode-probe/run.py \
  --output out/vscode-startup.json
```

Run after building the real GTK host/Obscura renderer and compiling
`weber/electron-runtime`. The usual `WEBER_DESKTOP_HOST` and
`WEBER_OBSCURA_RENDERER` overrides apply. Python 3.12+ and Node.js are required.
The initial example disables extensions and uses fresh temporary user-data and
extension directories. It does not patch VS Code sources, supply fake APIs or
swallow application errors.

Before starting VS Code, the probe recompiles the original Electron source files
into a separate temporary directory. It compares source hashes, manifests and
compiled JavaScript digests against the installed Weber modules. This prevents a
stale or substituted compilation from being mistaken for the current source.

`pin.json` records the official release-note URL, tag commit and the Microsoft
archive URL resolved from its download link. The extracted package version and
product commit must match that pin. The archive SHA-256 is recorded after
download for reproducibility; it is not misrepresented as an independently
verified publisher checksum.

The output always has `ready: false` and `readiness_checked: false`. Exit code 0
means the startup diagnostic ran to completion and produced evidence, including
expected incompatibility evidence; it is not an acceptance-test pass. Exit code
2 means setup, source provenance, download or extraction prevented the app from
being tested. CI should upload the report as a diagnostic artifact and keep it
separate from actual runtime acceptance results.

The startup deadline defaults to 30 seconds, process output is bounded, and the
probe cleans its entire subprocess group. Download and extraction also have
size limits. Distribution files and the temporary profile are deleted after
the report is written; only hashes and bounded error/stack excerpts are kept.

The historical [45c56bb probe](../packaging/results/45c56bb.json) advanced past
`crashReporter`, `contentTracing`, `shell`, `safeStorage`, `powerSaveBlocker`,
`net` and `desktopCapturer` imports, then stopped resolving `@vscode/spdlog`
inside `node_modules.asar`. Its expanded-dependency diagnostic reached
`setPermissionRequestHandler`, as described below. All 16 runtime gates
and extracted Node/Bun/native examples passed in that run. The original modules
are connected to scoped runtime behavior: inactive crash metadata with explicit
collection errors, actual bounded Node main-process timing traces, and real
GIO file/URI launch and trash. Native crash capture is not implemented and Bun
tracing remains explicitly unavailable. None of these import-stage advances is
a running-workbench acceptance pass. The report also inventories
named Electron imports from the pinned application. See
[COMPATIBILITY.md](COMPATIBILITY.md) for their current scope and the remaining
workbench, editing, terminal, extension and multiwindow acceptance work.

Revision `72f2c8d` compiles 43 original Electron modules and provides bounded
[ASAR loading](../electron-runtime/ASAR.md), session permissions, webRequest
policy and the original [nativeTheme module](../electron-runtime/SESSION.md).
A direct check loaded the pinned distribution's unmodified ASAR-backed
`@vscode/spdlog`, including its original unpacked native addon. The local new-feature
suites report 69 passes on Node and 50 passes with five skips on Bun; the
runners count subtests differently.

Current validation: [72f2c8d](../packaging/results/72f2c8d.json) passed all 16
runtime gates in [CI run 34503083387](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34503083387),
including 11 engine tests, actual GTK nativeTheme changes, Node/Bun protocol and
browser-clipboard permission fixtures, and extracted Node/Bun/native bundles.
The [2b8adbd failed result](../packaging/results/2b8adbd.json) is retained: it
passed 13 of 16 gates, with obsolete `original-fs === fs` assumptions failing the
Node/Bun/bundle fixtures before those checks were corrected.

The strict original-layout VS Code 1.136.2 run now passes ASAR loading and session
configuration and reports `Weber has not implemented powerMonitor shutdown inhibition`,
the same failure as the separate expanded-dependency run.
Both application processes exit 1 without timing out and both reports retain
`ready: false`. The earlier [71ac31a strict run](../packaging/results/71ac31a.json)
failed to resolve `node_modules.asar/@vscode/spdlog/index.js`; that startup
composition failure is resolved in this verified run. A running workbench is
still not established.

The independent [Monaco diagnostic](../monaco-probe/README.md) passes seven core
checks in `72f2c8d`, including real editor input, edits/undo and a 1,000-line
document. Its original worker/diff check still fails with
`Unexpected token 'export'`, separately from this whole-app import failure.

## Optional ASAR layout diagnostic

In the historical 45c56bb build, the strict probe stopped at `@vscode/spdlog`,
whose JavaScript package resides inside the distribution's `node_modules.asar`.
That build lacked ASAR filesystem/module loading. Revision `72f2c8d` reads the
existing archive and declared unpacked entries without changing the layout;
the full unmodified application now passes that dependency and reaches
powerMonitor shutdown inhibition. The optional expansion remains a separate
diagnostic and must not substitute for the strict original-layout result.

`--expand-dependencies` runs a separate diagnostic. In its temporary application
tree, it expands the authentic archive entries into `node_modules`, including
native binaries declared in `node_modules.asar.unpacked`. It validates paths,
size/offset bounds, links, symlink ancestors and collisions before writing;
existing dependency files must be byte-identical. It does not rewrite application
source, install replacement dependencies or substitute API implementations.

The report kind becomes `vscode-expanded-dependency-diagnostic`; it records
`app_modified: true` for the expanded package layout, `source_files_modified: false`, archive/file hashes, copied bytes and native-addon count. `ready` remains
false. This can reveal later startup failures, but is neither an unmodified-layout
pass nor a transparent ASAR implementation. CI retains both reports independently.

The historical [45c56bb run](../packaging/results/45c56bb.json) reached session
configuration after expansion and stopped at `setPermissionRequestHandler`.
The verified [72f2c8d expanded run](../packaging/results/72f2c8d.json) advances
to the explicit powerMonitor shutdown-inhibition error. It remains an altered
dependency-layout diagnostic, not an unmodified VS Code workbench pass.
The log parser now recognizes VS Code's timestamped `[main ...]` error prefix;
it was checked against the archived stderr and regression tests.

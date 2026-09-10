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

The latest verified probe has advanced past `crashReporter`, `contentTracing`
and `shell`, `safeStorage`, `powerSaveBlocker` and `net` imports and stops at
missing `desktopCapturer` in the full native run 1219c94. All 16 runtime gates
and extracted Node/Bun/native examples passed in that run. The original modules
are connected to scoped runtime behavior: inactive crash metadata with explicit
collection errors, actual bounded Node main-process timing traces, and real
GIO file/URI launch and trash. Native crash capture is not implemented and Bun
tracing remains explicitly unavailable. None of these import-stage advances is
a running-workbench acceptance pass. The report also inventories
named Electron imports from the pinned application. See
[COMPATIBILITY.md](COMPATIBILITY.md) for their current scope and the remaining
workbench, editing, terminal, extension and multiwindow acceptance work.

The independent [Monaco diagnostic](../monaco-probe/README.md) now exercises
real editor input, edits/undo and a 1,000-line document. Its unresolved original
worker/diff check is recorded separately from this whole-app import failure.

## Optional ASAR layout diagnostic

The strict probe now advances past the desktopCapturer import and stops at
`@vscode/spdlog`, whose JavaScript package resides inside the distribution's
`node_modules.asar`. Weber does not yet provide transparent ASAR filesystem or
module loading.

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

The verified [45c56bb run](../packaging/results/45c56bb.json) reached session
configuration after expansion and stopped at `setPermissionRequestHandler`.
The log parser now recognizes VS Code's timestamped `[main ...]` error prefix;
it was checked against the archived stderr and regression tests.

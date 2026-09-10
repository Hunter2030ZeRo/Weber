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

The latest verified probe has advanced past `protocol`, `clipboard` and
`systemPreferences` imports and now stops at missing `Notification`. Those APIs
were implemented with native behavior and separate execution checks; no empty
exports were added to suppress the startup error. The report also inventories
named Electron imports from the pinned application. See
[COMPATIBILITY.md](COMPATIBILITY.md) for their current scope and the remaining
workbench, editing, terminal, extension and multiwindow acceptance work.

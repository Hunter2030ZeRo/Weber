# Project backend selection

`weber-runtime-config` reads `weber.toml` without requiring a JavaScript runtime.
Its `weber-backend` binary starts the Electron-derived Weber bootstrap through
Node.js or Bun, or starts a compiled native application directly. All three
receive the same desktop host and Obscura renderer paths. The selected backend
therefore reaches the actual GUI runtime instead of launching an Electron main
script in an unmodified system Node environment.

This integration does not imply complete Electron compatibility: the bootstrap
and native host currently implement a subset, and the OS sandbox is not yet
implemented. The development runtime requires the explicit environment variable
`WEBER_UNSANDBOXED_DEVELOPMENT=1`; the selector never enables it automatically.

For Node.js:

```toml
[backend]
kind = 'node'
entry = 'main.cjs'
args = ['--application-option']
```

Changing `kind` to `'bun'` selects Bun with the same entry point. An optional
`executable` replaces the default `node`/`bun` executable. A bare runtime name is
looked up on PATH; `./tools/node`, `tools/node`, and absolute paths name explicit
files. Optional `runtime_args` precede the JavaScript entry point. `args` follow
it and are passed as individual application arguments.

For a compiled Rust/native backend:

```toml
[backend]
kind = 'native'
executable = 'target/release/my-application'
args = ['--application-option']
```

Native applications run directly without Node/Bun. `entry` may replace
`executable` as a shorthand, but specifying both is an error. The native binary
must already be built. On Windows, specify its `.exe` filename. All relative
entry and native executable paths are resolved from the project directory,
independently of the launcher's working directory. Absolute paths are accepted.
This configuration is trusted application startup configuration, not a sandbox.

`schema = 1` is optional at the top level. Invalid backend names, unknown keys,
ambiguous native entries, empty paths and missing files fail explicitly. A
missing runtime never silently falls back to a different backend.

```sh
cargo test --manifest-path weber/runtime-config/Cargo.toml
cargo build --release --manifest-path weber/runtime-config/Cargo.toml
weber/runtime-config/target/release/weber-backend check --project path/to/app --runtime-root weber/electron-runtime
weber/runtime-config/target/release/weber-backend run --project path/to/app --runtime-root weber/electron-runtime -- --flag 'one argument'
```

Build the GUI host, renderer and `weber/electron-runtime` first. `--runtime-root`
names the directory containing `bootstrap.cjs` and its compiled original
Electron modules. `WEBER_RUNTIME_ROOT` or an `electron-runtime` directory beside
the launcher can supply the same path. Host and renderer binaries are selected
from absolute `WEBER_DESKTOP_HOST` / `WEBER_OBSCURA_RENDERER` overrides, a runtime
bundle's `bin/`, or the source checkout's `out/runtime/` build directory.
Native programs can run with just the two binary environment variables.

For Node/Bun the argument order is runtime options, `bootstrap.cjs`, project
directory, then application arguments. `WEBER_ENTRY` provides the resolved
JavaScript entry to that bootstrap. Native executables receive only application
arguments. This arrangement preserves a common application directory and host
protocol while allowing the JavaScript runtime to change through `kind`.

`check` resolves and prints a launch plan without executing application code.
`run` inherits standard input/output and sets `WEBER_PROJECT_DIR` and
`WEBER_BACKEND`. No shell is invoked or shell expansion performed. Application
arguments after `--` retain their OS string representation, including non-UTF-8
arguments on Unix. Unix uses `exec`, preserving backend signals and exit status;
other platforms wait for the child and propagate its numeric exit code.

Library callers use `load_runtime_plan` and `LaunchPlan::command` to run GUI
applications. `load_plan` is the lower-level backend-only plan used by tests and
embedders that explicitly supply their own bootstrap. The Rust example in
`weber/native-example` demonstrates native host communication without Node/Bun.

Tests compile a tiny Rust probe executable to verify actual launch arguments,
working directory, environment, exit status, native selection, and Unix signal
propagation. Node/Bun selection tests use that explicit executable override;
they do not claim to test Node/Bun's Electron compatibility.

# Native Rust backend example

This executable starts the actual Weber desktop host and Obscura renderer,
creates a GTK window, loads `index.html`, changes and verifies its DOM, then
closes the window and quits. It uses no Node.js or Bun process. This is a small
GUI integration example, not an Electron compatibility claim or a general Rust
GUI API.

```sh
cargo build --release --manifest-path weber/native-example/Cargo.toml
export WEBER_DESKTOP_HOST=/absolute/path/to/weber-desktop-host
export WEBER_OBSCURA_RENDERER=/absolute/path/to/weber-obscura-renderer
export WEBER_UNSANDBOXED_DEVELOPMENT=1
weber/runtime-config/target/release/weber-backend run --project weber/native-example
```

Linux needs a graphical session, or `xvfb-run -a` around the launcher in CI. The
explicit development variable acknowledges the current missing OS sandbox;
this example should load only its own trusted local document. The
example fails if window creation, page loading, DOM evaluation or shutdown fails.
It prints one success JSON record only after all operations have succeeded.

The main process communicates through the desktop host's stdin/stdout JSON-line
protocol. The host path and renderer path must be absolute, existing files. The
renderer path is passed as the host's first positional argument. Stderr remains
available for diagnostics. Requests have a 30-second deadline and responses are
bounded to 1 MiB; this example does not request screenshots or raw frame payloads.

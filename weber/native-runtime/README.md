# Weber native Rust runtime

This crate provides a small main-process API for the same desktop host and
Obscura renderer used by Weber's Node/Bun bootstrap. It starts no JavaScript
backend and links no Chromium or GUI toolkit into the Rust caller.

```rust,no_run
use std::time::Duration;
use weber_native_runtime::{Runtime, WindowOptions};

# fn main() -> Result<(), Box<dyn std::error::Error>> {
let runtime = Runtime::from_env()?;
let window = runtime.create_window(WindowOptions {
    title: "Native Weber application".into(),
    ..Default::default()
})?;
window.load_file("index.html")?;
let title = window.evaluate("document.title")?;
window.wait_for_frame(Duration::from_secs(10))?;
window.close()?;
runtime.quit()?;
# Ok(())
# }
```

`Runtime::from_env()` consumes `WEBER_DESKTOP_HOST` and
`WEBER_OBSCURA_RENDERER`, normally configured by the TOML backend launcher.
`Runtime::spawn(host, renderer, timeout)` supplies explicit absolute paths and a
request timeout. Both start an owned host and validate its protocol-1 Obscura
handshake. The current Linux host still requires the explicit development
unsandboxed opt-in; the library does not silently set it.

Runtime and window handles share the host. Dropping the last handle closes the
input channel, waits for graceful host/renderer cleanup and reaps the host;
`quit()` explicitly closes the application even if window handles remain.
Closing a window is idempotent. Handles are intentionally bound to their owning
thread; calls block the native main-process caller, while GTK and the renderer
run in their separate processes.

`Runtime::next_event(timeout)` returns queued or newly received events.
`Duration::ZERO` polls without waiting. `Event::FramePresented` and
`Event::Closed` have typed fields; other host events retain their JSON payload
in `Event::Other`. Poll regularly: the event queue is bounded to 64 messages and
overflow fails the connection explicitly. `Window::wait_for_frame` observes the
first frame actually painted by GTK and retains the event for subsequent polls.

Requests and responses are limited to 1 MiB each. The request deadline covers
both blocked stdin writes and response reads. Host-reported page errors leave
the connection usable; malformed responses, mismatched IDs, output closure and
request timeouts terminate the owned host. Idle event/frame waits may time out
without invalidating a healthy connection.

```sh
cargo test --manifest-path weber/native-runtime/Cargo.toml
cargo build --release --manifest-path weber/native-example/Cargo.toml
```

Protocol tests use a compiled fake child to exercise failures and ownership;
they are not browser or GUI coverage. `weber/native-example` separately checks
the actual GTK window, Obscura document/evaluation and frame presentation using
this public API. This initial Rust API is a subset, not full Electron parity.

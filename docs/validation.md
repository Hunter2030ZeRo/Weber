# Historical SpiderMonkey/X11 baseline — 2026-10-19

This document records the initial prototype before Wayland-only and native AOT
work. For current results, see [Wayland/AOT](wayland-aot.md),
[browser DOM contracts](browser-dom.md) and [platform extension](browser-platform.md).
The limits below refer to that earlier baseline, not the current implementation.

## Environment and actual build

- Linux 7.2.11-1-cachyos, x86_64; Rust 1.99.0; Node 26.10.0; pnpm 11.25.0.
- Servo v0.7.0, revision `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`.
- New independent Rust host built with `cargo build --locked`: **passed**.
- `cargo clippy --locked --no-deps -- -D warnings`: **passed** for the new host;
  upstream dependency warnings remain visible.
- `cargo fmt --check --package weber-servo`: **passed**.
- TypeScript strict check and Vite 7.1.12 production build: **passed**.
- SolidJS 1.9.9; TypeScript 5.9.3; vite-plugin-solid 2.11.10.
- Bundled frontend: JS 12.48 kB (gzip 5.35 kB), CSS 2.10 kB.
- Native executable: approximately 339 MiB, unoptimized debug build. Not a release
  size claim. Servo source, Cargo artifacts and node_modules are excluded from Git.

## Native-window evidence

Both the production Vite preview and the Vite development server were loaded by
the **locally compiled Weber binary**, using Servo + SpiderMonkey in a winit
window. Xvfb + software OpenGL were used. No Chromium test renderer was used.

| Scenario | Production preview | Vite development server |
|---|---|---|
| HTML/CSS/JS and SolidJS mount | Pass | Pass |
| Native mouse click updates counter | 0 → 1 | 0 → 1 |
| Enter activates focused button | Not run in first production pass | 1 → 2 |
| Native input + Backspace | `Weber 123` → `Weber 12` | Same |
| Native wheel moves overflow container | 152 px | 152 px |
| requestAnimationFrame advances | 60 → 90 | 60 → 90 |
| CSS animation changes rendered pixels | Pass | Pass |
| Pause stops reported frame count | Pass | Pass |
| Resize | 960×720 → 720×800 | Same |
| Native close protocol | Exit 0 | Exit 0 |

Observed values from one run each, **not statistical performance benchmarks**:

| Metric | Production preview | Development server |
|---|---:|---:|
| Spawn → first app title observed | 324 ms | 325 ms |
| Native process RSS after interaction/pause | 351,292 KiB (~343 MiB) | 356,716 KiB (~348 MiB) |
| Threads at sample | 88 | 88 |

Readiness measures the title callback, not the first displayed frame. Memory is
one process's RSS, not PSS, idle steady state or total system impact. The runs used
an unoptimized binary and software rendering, with a concurrent static check.
These numbers do not establish Weber's low-memory/low-latency target.

Evidence:

- [Production results](../artifacts/production/native-smoke.json)
- [Development results](../artifacts/native-smoke.json)
- [Rendered app after interaction](../artifacts/interaction.png)
- [CSS motion capture](../artifacts/motion.png)
- [Resized native window](../artifacts/resized.png)
- Local detailed logs: `artifacts/build.log`, `artifacts/clippy.log`,
  `artifacts/native.log`, `artifacts/production/native.log`.

The first smoke attempt timed out on close because `xdotool windowquit` sends an
EWMH request to a window manager, and Xvfb had none. The test now sends the normal
`WM_DELETE_WINDOW` protocol directly. It does not force-kill the app to pass close.
The first screenshot was also taken before paint; the corrected test waits for
animation frames before recording it.

## Known limits and upstream diagnostics

Servo's disabled optional features produce upstream unused-import warnings; the
new host does not suppress them. Runtime logs include a temporary ClientStorage
SQLite initialization warning followed by Servo's in-memory fallback, occasional
empty hit tests/texture-upload warnings, and profiler-disconnection warnings at
shutdown. These remain visible in logs. Persistent storage is not verified.

The initial Rust compile caught `NamedKey::Space` being unavailable in this Servo
version; space is correctly sent as `Key::Character(" ")` in the compiled host.

Real Wayland/GPU, Windows, macOS, hardware input latency, Korean IME, clipboard,
screen readers, production packaging and broad web-standard coverage are not
validated. Native AOT compilation with Static Hermes and Hermes-to-Servo DOM
integration are **not implemented or compiled in this baseline**. Bun is not
integrated. Those boundaries are intentional and documented separately from the
working SpiderMonkey vertical slice.

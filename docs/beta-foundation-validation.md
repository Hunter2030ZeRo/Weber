# Beta foundation validation — 2026-10-19

The first beta foundation bundle is compiled and tested. It adds a real
Hermes-free JIT host, per-window lifetime and Bun subscriptions, with a separate
layer-shell rendering proof. This is not a completed beta or desktop environment.

Final source SHA-256:
`62d0d88eb66ab8c8f34b41d9f525d07f3c9c1b5fa67d949b04f4d8d66c7d0201`.
Servo: `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`.
Static Hermes: `17b37301da5da4a2cd55d78f9697c46c0fd96123`.
Both prepared hosts are optimized release builds of that source. The native-unit
ABI remains `54c8b2957e4e5823f4b52eca6c5538346d7e2b50fe396b4c63b1e0ce31069ea9`.

## Compiled and executed

- Cargo defaults to JIT. `cxx`/`cxx-build` and the Hermes build, loader and DOM
  dispatch are feature-gated behind `aot`. The default build succeeds with both
  `vendor/hermes` and `target/hermes` temporarily unavailable. This reuses cached
  Servo dependencies; it is not a clean-room full toolchain bootstrap. Both
  directories are restored in finally. JIT build-info reports no AOT ABI/runtime,
  and its ELF dependencies contain neither Hermes nor JSI.
- `target/package/weber-beta-jit` has 10 declared private libraries, while
  `target/package/weber-beta-aot` has 14. Native-unit manifests and AOT self-tests
  are rejected explicitly by the JIT host. SDK packaging also rejects an AOT
  app paired with that host and preserves the preceding output.
- One Servo instance owns separate native windows/WebViews and rendering contexts.
  Actual native tests open three same-app windows on both UI engines, close them
  in order 1, 3, 2, and verify that the second continues running after the primary
  closes. Invalid sizes/capabilities fail; title/list/open/close APIs execute.
- The common SDK subscription API delivers ordered finite events into the real
  DOM, handles natural end, unknown methods and invalid values, and cancels on
  unsubscribe. Window close cancels both an active stream and a pending call;
  backend state confirms their finally cleanup before the surviving window
  continues. Backend failure reaches the remaining subscriber and final window
  shutdown reaps the Bun child.
- A 400ms blocked UI and a fast producer exercise explicit event overflow.
  One delivery per window stays in flight until its JS evaluation finishes;
  backlogs cannot simply migrate into an unlimited Servo evaluation queue.
  A separate 129-subscription burst checks that completed streams retain their
  delivery slots until acknowledged, with no more than 64 accepted at once.
- The `layer-shell` feature builds a separate probe with a fresh role-bearing
  Wayland surface. On isolated KWin virtual output, Servo presents a 960×48 top
  panel with a 48px exclusive-zone request. Configure, frame callbacks, a
  programmatic button activation, CSS width, rAF and a real Servo screenshot
  pass. A QPainter compositor attempt did not complete frame presentation;
  the successful run uses KWin OpenGL and software client EGL. No compositor
  setting on the user's desktop was changed.
- Existing Bun/npm packaging and actual native invocation regression tests pass,
  including selected Node filesystem/crypto/process APIs, semver 6.3.1, timeout,
  queue exhaustion, crash, package/source separation, normal shutdown and Linux
  parent-death during an infinite backend loop. Bun is 1.4.2.
- Existing no-backend Vite workflow and native tests pass: JIT/AOT packages,
  validation failures, button/input/style/remount, CSS/TSX HMR and development
  process cleanup. Five standalone AOT contract entrypoints also pass. Rust
  format, Clippy with warnings denied for Weber on both features, and JS syntax
  checks pass; upstream engine warnings remain.

## Performance gate

The comparison uses the same source, embedded Solid desktop, resources and
viewport, with the Hermes-enabled AOT host versus the actual Hermes-free JIT
host. Neither application enables Bun. Process creation/loader time is included
in parent-pre-spawn to first native app presentation, measured using native
telemetry timestamps. Rust-main startup is recorded separately.

There is one warmup and 12 alternating launches per engine, plus 40 settled
process-tree PSS/RSS/private-memory samples per engine at 200ms intervals. The
filesystem is warm. These are virtual-compositor measurements, not optical
scanout, cold-cache startup or GPU-memory totals. Startup peak memory and idle
CPU are not measured by this run.

The initial combined input benchmark could not activate the owned window in the
isolated GNOME session. No new native-input latency result is claimed. The final
resource-only run disables input injection and records input measurements as
absent; it still requires actual app readiness and native frame presentation.

Measured medians:

| Metric | Hermes-free JIT | Native AOT | AOT / JIT |
| --- | ---: | ---: | ---: |
| Spawn to first app presentation | 230.3ms | 264.3ms | 1.148× |
| Settled process-tree PSS | 123.5MiB | 155.3MiB | 1.258× |

Startup p95 is 241.1ms for JIT and 274.6ms for AOT. PSS p95 is
124.0MiB and 157.4MiB respectively. These PSS observations are correlated samples
of one settled run per engine, not 40 independent application trials.

AOT is approximately 14.8% slower and uses 25.8% more PSS on this workload.
It fails the eligibility screen; the default remains JIT. No AOT performance
improvement or promotion is claimed. Remaining dual-engine/DOM-adapter costs
are explicit architectural work, not a measured component-by-component cost
breakdown in this run.

The provisional screen requires at least 5% lower median startup AND settled
PSS. It is an eligibility screen for this workload only, not a general statistical
performance claim or automatic runtime promotion. Hermes-only DOM is not
implemented; the AOT path still pays for Hermes plus Servo's SpiderMonkey DOM
adapter. See the raw measurement report and audit for the actual screen result.

## Artifacts and reproduction

- [Native windows/subscriptions](../artifacts/beta-native.json)
- [Actual build without Hermes directories](../artifacts/beta-no-hermes.json)
- [Layer-shell proof](../artifacts/layer-shell.json) and
  [rendered panel screenshot](../artifacts/layer-probe.png)
- [Optimized AOT/JIT measurements](../artifacts/beta-desktop-benchmark.json)
- [Final source/package audit](../artifacts/beta-audit.json)
- Existing workflow regression reports are saved under
  `artifacts/beta-validation/regression/`. The preceding raw artifact paths were
  restored after saving this run; preceding hosts remain unchanged.
- Build/check logs: `artifacts/beta-jit-build.log`, `beta-aot-build.log`,
  `beta-no-hermes-build.log`, `beta-clippy-jit.log`, `beta-clippy-aot.log`,
  `beta-format.log`, plus native/benchmark session logs and traces in artifacts.

Prepared-checkout commands (package JIT before the AOT build replaces the binary):

```sh
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --features layer-shell
python3 scripts/package.py --profile release --binary target/optimized/release/weber-servo --output target/package/weber-beta-jit
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --features aot,layer-shell
python3 scripts/package.py --profile release --binary target/optimized/release/weber-servo --output target/package/weber-beta-aot
node scripts/beta-workflow-smoke.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/beta-native-smoke.mjs
dbus-run-session -- node scripts/layer-shell-smoke.mjs
WEBER_REPORT_PREFIX=beta- WEBER_BENCH_INPUT=0 WEBER_JIT_HOST=target/package/weber-beta-jit/weber dbus-run-session -- node scripts/headless-wayland.mjs scripts/desktop-benchmark.mjs target/package/weber-beta-aot/weber
```

Native runs need permission to create private compositor sockets. Test projects
need the prepared SDK/toolchain, Bun and populated `/tmp/weber-vite-npm-cache`.
They do not use or unlock the user's desktop session.

## Remaining beta scope

Windows/macOS have not been built or run. Clipboard, file dialogs, application
data APIs, broader window controls, accessibility, real keyboard/IME regression,
output hotplug/scaling and prolonged stability testing remain. Layer-shell input,
AOT integration into that surface and actual Hyprland IPC/panel/launcher behavior
remain downstream integration work. No lock-screen security result is claimed.

The locked 1,474-subtest browser profile was not rerun in this milestone. Selected
app regressions and native AOT contract tests are not a substitute for complete
browser or Node/Electron compatibility. The beta is not declared complete.

See [native runtime usage](native-runtime.md) and [beta plan](beta-plan.md).

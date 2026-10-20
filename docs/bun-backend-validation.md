# Bun backend validation — 2026-10-19

The optional Bun backend is implemented, compiled and exercised through actual
Servo windows. Both SpiderMonkey UI and the existing Static Hermes AOT UI call
the same backend through `@weber/sdk/backend`. This milestone does not replace
Servo's SpiderMonkey DOM adapter or complete Hermes-only DOM integration.

Source SHA-256: `b4729d86b405dd530321343a2c6933c0e438df1bd88f2577f0f3239785030c87`.
Servo: `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`.
Static Hermes: `17b37301da5da4a2cd55d78f9697c46c0fd96123`.
The host is an optimized release build with backend protocol 1, SDK workflow
0.3.0, and the preceding native-unit ABI unchanged. Actual backend tests use
Bun 1.4.2; tooling uses Node 26.10.0 and npm 12.0.2.

## Implemented and executed

- Fresh `init ... node`, real npm dependency installation, UI type checking,
  `npm run package` and `npm run package:aot` succeed. The app installs and uses
  the real npm dependency semver 6.3.1. Repeated installs use the populated local
  npm cache. A backend compilation failure preserves the preceding build.
- Build creates a standalone backend with `bun build --compile`, records its
  hash/runtime in the manifest and packages it separately from browser assets.
  This embeds Bun and JavaScript; it is not Static Hermes native AOT compilation
  of backend code. Native validation temporarily hides the source and
  node_modules directories while running the packaged application.
- Actual native runs cover the JIT-only package's default launch, the AOT
  package's native AOT launch, and that package's JIT comparison launch. The
  JIT-only package does not initialize Hermes. AOT execution does initialize it.
  The raw Bun report's `engine: "aot"` on the JIT-only package denotes the default
  launch selector, not its effective engine; `hermesInitialized: false` records
  the effective behavior.
- UI/backend assertions exercise Node filesystem, path, OS and crypto APIs,
  a child process, semver, Unicode/nested JSON and 16 concurrent correlated calls.
  They check named-method errors, missing methods, timeout/cooperative abort,
  oversized replies, unsupported BigInt results and console framing.
- Queue exhaustion rejects one of 129 pending calls while the other 128 finish.
  Backend process failure rejects both pending and subsequent calls. Animation
  callbacks continue during 300ms of synchronous backend work; this establishes
  process separation in this scenario, not a latency or throughput benchmark.
- Missing/invalid browser capabilities are rejected. Native launch rejects
  invalid backend hashes, paths, runtime declarations, executable formats and
  symlinks escaping the app directory before backend execution.
- Closing a healthy native window terminates/reaps the owned backend. When the
  backend is in an infinite loop, force-killing the native host still terminates
  its direct Bun child through Linux parent-death signaling. This is not a
  guarantee for intentionally detached descendants or an OS sandbox.
- Actual `npm run dev` loads Vite in Servo and invokes Bun. Closing its window
  closes the development server and backend. Existing apps without a backend
  pass the full preceding Vite workflow regression, including both UI engines,
  CSS/TSX HMR, missing-host failure and interrupted-development cleanup.
- Release compilation, package-scoped Rust format, Clippy with warnings denied
  for Weber, and Node syntax checks pass. Upstream engine warnings remain in
  build logs. The audit checks five package executables, all 14 private libraries
  in each package, application/native-unit/backend hashes and matching source
  fingerprints across four reports. Both preceding prepared hosts are unchanged.

## Evidence and reproduction

- [Build/package report](../artifacts/bun-workflow.json)
- [Native invocation and process-lifetime report](../artifacts/bun-native-workflow.json)
- [Source/package integrity audit](../artifacts/bun-backend-audit.json)
- [Existing Vite build regression](../artifacts/vite-workflow.json)
- [Existing Vite native/HMR regression](../artifacts/vite-native-workflow.json)
- Logs: `artifacts/bun-build-release.log`, `artifacts/bun-clippy.log`,
  `artifacts/bun-format.log`, `artifacts/bun-host-package.log`,
  `artifacts/bun-workflow/`, `artifacts/bun-native-session.log` and individual
  native traces named in the reports.

The ready host is `target/package/weber-bun/weber`, SHA-256
`356f8e33fc620e7b5244d51566aa493b77a3b354f0baf647a26aa0287a7bf040`.
Generated test projects/package paths are recorded in the reports. These are
temporary fixtures; use the [documented workflow](bun-backend.md) for new apps.

Prepared-checkout reproduction:

```sh
CARGO_TARGET_DIR=target/optimized cargo build --release --locked
python3 scripts/package.py --profile release --binary target/optimized/release/weber-servo --output target/package/weber-bun
node scripts/bun-workflow-smoke.mjs target/package/weber-bun/weber
node scripts/vite-workflow-smoke.mjs target/package/weber-bun/weber
dbus-run-session -- node scripts/headless-wayland.mjs artifacts/bun-validation/native-suite.mjs
node artifacts/bun-validation/audit.mjs
```

The npm tests expect `/tmp/weber-vite-npm-cache` or `WEBER_NPM_CACHE` to contain
their dependencies. Bun must be available for building. Native tests require
permission to create local sockets and a compositor. Each workflow test writes
the latest report to its corresponding artifact path; the report's own build
fingerprint identifies the tested build.

## Limits

Native evidence comes from isolated GNOME headless Wayland with an actual
winit/Servo rendering window and a 960×720@60 virtual monitor. Inputs and probes
are programmatic. This is not physical keyboard/IME validation, the user's live
desktop, hardware performance evidence or a desktop-environment integration.

The selected Node APIs and one npm dependency do not establish complete Node.js
or Electron compatibility. Arbitrary native addons, V8-specific interfaces,
dynamic imports and additional application data need dependency-specific tests
and packaging. Windows/macOS implementation and packaging remain unverified.

The Bun backend has ordinary native-app privileges and uses bounded JSON IPC,
with copying and result polling. It adds a process/runtime when enabled; no new
startup, memory or throughput advantage is claimed. Apps without a backend start
no Bun child. Today's host still links Hermes even on its JIT path. The earlier
1,474-subtest DOM compatibility profile was not rerun in this milestone.

# Vite/npm workflow validation — 2026-10-19

Historical milestone: the source fingerprint and prepared `weber-vite` host
below describe the original Vite milestone, whose host and audit are preserved.
The linked raw `vite-workflow.json` and `vite-native-workflow.json` reports now
contain the latest regression run against the Bun-capable host; their own build
fingerprints identify that run. See [Bun validation](bun-backend-validation.md)
for the current host and results.

SDK workflow 0.3 is implemented, compiled and tested. This milestone connects
project-owned Vite/npm tooling to Weber; it does not complete Hermes-only DOM
integration or establish a performance advantage.

Source SHA-256: `1b65c16cbc145fb70d0bf3a61296e827e196afc0623e45e3a7c12164462b1ad2`.
Servo: `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`.
Static Hermes: `17b37301da5da4a2cd55d78f9697c46c0fd96123`.
The host's app API remains 0.2 and the existing native-unit ABI is unchanged;
the tooling version is separately reported as `sdkWorkflowVersion: 0.3.0`.

## Implemented and executed

- Fresh `init` generates npm scripts, Vite configuration, TypeScript configuration
  and development HTML. Real npm installs project-local dependencies and the
  local SDK. Validation used Node 26.10.0, npm 12.0.2, Vite 7.1.12,
  vite-plugin-solid 2.11.10 and Solid 1.9.9. Initial public dependency retrieval
  populated a task-local cache; repeated fresh-project tests install offline.
- `npm run check`, `npm run package` and `npm run package:aot` execute their real
  commands. The latter two invoke `build` and `build:aot`. JIT output has no
  native unit/engine metadata or `app.so`; AOT output includes a real compiled
  O3 ELF unit and a JIT comparison bundle. Native compiler/linker output is saved.
- The project adds its own Vite plugin, `define`, path alias, `.env` value,
  file-based npm dependency, source maps and public resource. Packaged application
  assertions verify the combined values in the actual DOM on both engines.
  Public resources/maps are included in the declared hashed assets.
- Type errors and unsupported UI imports of `node:fs` fail. A deliberately failing
  native linker also fails the AOT build. Each preserves the preceding manifest
  and output. Nonempty unrelated output directories retain their user file.
  Node APIs in the Vite configuration remain usable: the development test plugin
  uses Node filesystem APIs while UI Node built-ins are rejected.
- The Rust host accepts JIT-only manifests and automatically runs their web entry.
  Existing native manifests continue to validate ABI, revision, module hash and
  path. Partial native metadata, invalid asset hashes and escaping asset paths
  are rejected before opening a window. Native failure is not a JIT fallback.
- The final optimized host and app packages run in a separate GNOME headless
  Wayland session with an actual native winit/Servo rendering window. Tests cover
  JIT-only default launch, native AOT default launch and the AOT package's JIT
  comparison. Button/input/style assertions and remount pass; Hermes initializes
  only for the AOT execution. Package runs use cwd `/tmp` and remove developer
  `LD_LIBRARY_PATH`; Node/Vite/source/node_modules are not included in app packages.
- `npm run dev` loads the real Vite server in Servo. A programmatic click changes
  the counter. CSS HMR changes the computed color while retaining page identity
  and counter value. TSX HMR changes the rendered heading without replacing the
  page; the component state resets, which is recorded rather than described as
  universal state preservation. Host console output confirms Vite connection and
  updates. Native presentation telemetry is observed; Hermes remains uninitialized.
- The initial SDK called the root Solid component as an ordinary function, which
  bypassed Solid's development component instrumentation and prevented refresh.
  The SDK now mounts through `createComponent`. The corrected HMR behavior is
  tested in Servo, not inferred from a successful Vite transform.
- Closing the owned window exits the dev command and closes Vite. Missing-host
  startup closes its server and exits nonzero. SIGINT terminates the owned native
  host, Vite and helper processes; the test checks the server and child PIDs.
- Release compilation, package-scoped Rust format, Clippy with warnings denied
  for Weber, and Node syntax checks pass. Existing upstream engine warnings are
  present in build logs. The previous binding-milestone host is preserved with
  its original SHA-256.

## Evidence and artifacts

- [npm/build/package report](../artifacts/vite-workflow.json)
- [native Wayland and HMR report](../artifacts/vite-native-workflow.json)
- [source/package audit](../artifacts/vite-workflow-audit.json)
- Detailed command logs: `artifacts/vite-workflow/`, `artifacts/vite-dev.log`,
  `artifacts/vite-dev-missing-host.log`, `artifacts/vite-dev-interrupt.log`.
- Build/check logs: `artifacts/vite-build-release.log`,
  `artifacts/vite-clippy.log`, `artifacts/vite-format.log`.
- Original milestone prepared host: `target/package/weber-vite/weber`.
  SHA-256: `d63d869af451cf8553d821d578d63edbb246f0d1c070cd00111bbbe8ca545af0`.
  The audit verifies all 14 private libraries and both generated app packages.
- The exact generated project and package paths are in the reports. They are
  temporary test fixtures; create a new working project with the documented
  [workflow](vite-workflow.md).

Prepared-checkout reproduction:

```sh
CARGO_TARGET_DIR=target/optimized cargo build --release --locked
python3 scripts/package.py --profile release --binary target/optimized/release/weber-servo --output target/package/weber-vite
node scripts/vite-workflow-smoke.mjs target/package/weber-vite/weber
dbus-run-session -- node scripts/headless-wayland.mjs scripts/vite-native-smoke.mjs
node artifacts/vite-workflow/audit.mjs
```

The build test expects a populated npm cache at `/tmp/weber-vite-npm-cache` or
`WEBER_NPM_CACHE`. Populate it with a generated project's normal npm install using
the same cache option. Native tests require permission to create local sockets
and a test compositor. They do not use or unlock the user's desktop session.

## Limits

This is a prepared-checkout SDK, not a registry-published/self-contained installer.
The production contract is one bundled library entry with Weber-controlled app
manifest and output. Arbitrary Vite plugins, multipage HTML builds, SSR, Node
runtime APIs and all browser libraries are not covered. AOT does not hot-replace
machine code; development uses SpiderMonkey and AOT needs its separate build/test.

All native evidence here is Linux Wayland. Windows/macOS windowing, loaders and
packaging remain unimplemented. Input assertions are programmatic and rendering
uses a headless compositor; this is not new physical keyboard/IME evidence,
hardware latency testing or a desktop-environment integration result. The earlier
1,474-subtest compatibility profile was not rerun in this tooling milestone.

The AOT path still uses Hermes plus Servo's SpiderMonkey DOM adapter. DOM/GC
ownership work remains. Startup, memory and long-running behavior were not
remeasured; the [preceding measurements](binary-dom-validation.md) apply only to
their recorded build. No performance improvement is claimed.

# Local npm distribution, SDK 0.3.1

Weber has two distribution layers: the JS/TS SDK and CLI are npm development
dependencies; the native Servo/SpiderMonkey runtime is platform-specific.
`npm run build` compiles the app's JS/CSS/assets without requiring that runtime.
`npm run dev` and `npm start` launch it; `npm run package` copies it and the
compiled app into a relocatable application directory. The end user does not
need Node/npm/Bun for a JIT app without a Bun backend.

These are local preview artifacts, not published registry packages:

- `target/npm/weber-sdk-0.3.1.tgz`: SDK, CLI, five templates and pinned defaults.
- `target/npm/weber-runtime-linux-x64-0.3.1.tgz`: JIT executable, private native
  libraries, existing notices and Servo patches. No Hermes or install scripts.
- `target/npm/release.json`: artifact hashes, sizes, file lists and native build
  identity. Native protocol versions are independent of the SDK package version.

Generate them from a prepared JIT runtime bundle:

```sh
node scripts/npm-release.mjs target/package/weber-sdk-jit/weber
```

To create an app, replace `/absolute/path/weber` and `/path/my-notes` below. The
explicit SDK spec is required because this preview is not in the npm registry.
It may be relative to the new project (the distribution test uses sibling
tarballs), allowing the complete project and tarballs to move together.

```sh
WEBER_SDK_SPEC=file:/absolute/path/weber/target/npm/weber-sdk-0.3.1.tgz \
  npm exec --package=/absolute/path/weber/target/npm/weber-sdk-0.3.1.tgz -- \
  weber init /path/my-notes notes
cd /path/my-notes
npm install
npm install --save-dev /absolute/path/weber/target/npm/weber-runtime-linux-x64-0.3.1.tgz
npm run dev
npm run build
npm run package
./package/weber --app ./package/application
```

Runtime lookup checks `WEBER_HOST`, then the application's installed native
package, then a package alongside the SDK. Source checkouts retain their
prepared-host fallback. `WEBER_HOST` must identify a prepared runtime's `weber`
executable; only source checkouts can bundle a raw developer executable through
the older Python/patchelf tool.

Packaging now copies the verified runtime bundle in Node. This fixes packaging
projects inside the source checkout without relaxing the raw-binary bundler's
source protection. It copies only the declared executable/libraries and
notices/patches/manifest, never another app embedded in the runtime directory.
Manifest hashes are local integrity checks, not a signature or trust guarantee.
Existing build/package output is atomically replaced only after success.

Installed JIT builds no longer import source-only AOT tooling. Static Hermes
compilation still requires the source checkout and toolchain; the npm SDK gives
an explicit error for `build:aot`. It does not implement a Hermes-only Servo DOM.

Validation commands (from the Weber checkout):

```sh
node scripts/npm-distribution-smoke.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/npm-distribution-native.mjs
```

The first creates a fresh external project, extracts all five SDK templates,
installs local tarballs, checks/builds/packages Notes, moves the project and
rebuilds. It tests missing runtime, unsupported installed-SDK AOT, type errors,
application/runtime hash mismatches, overlapping paths and unrelated output.
The second uses separate real GNOME Wayland windows for programmatic Notes
input, Save/Reload/New window, persistent restart, and installed-SDK Vite HMR.
Packaged execution sets PATH to a nonexistent directory; development uses Node.
Results are `artifacts/npm-distribution.json` and
`artifacts/npm-distribution-native.json`; the normal Notes app is
`target/package/weber-notes-npm`, separate from instrumented test packages.

Only Linux x64 on this development machine is validated. A compatible system
glibc loader, GPU/EGL/Wayland drivers and fonts remain prerequisites. This does
not establish clean-machine compatibility, a complete license audit, physical
keyboard/IME behavior, Windows/macOS support or new performance measurements.
The native engine and CPU policy have not changed in this SDK work.

## Verified result

The optimized `--release --locked --features layer-shell` host compiled and
both npm distribution gates passed. Vite reported a live HMR update of
`/src/main.tsx`; the native telemetry observed the updated value. The final
source fingerprint is
`8a861c099382628659b0c58ae1291bfed7c2f1a75e3a3607058b16b28aacf48c`.
`artifacts/npm-distribution-audit.json` checks that this source, native build,
npm tarball hashes and tested runtime agree, and verifies every app asset and
private library in the normal Notes package. SDK tarball: 19,153 bytes;
Linux runtime tarball: 54,254,445 bytes (163,447,864 bytes unpacked). These are
disk sizes, not memory measurements. The existing checkout's Notes project also
passed its actual `npm run package` command with the newly built runtime.

To run the normal Notes package from the Weber checkout:

```sh
./target/package/weber-notes-npm/weber --app ./target/package/weber-notes-npm/application
```

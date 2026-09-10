# Linux development runtime bundle

This archive runs a Weber project without rebuilding Electron, Obscura or Rust.
It is a development artifact for trusted applications. The current runtime has
separate renderer processes and isolated preload contexts, but **no OS sandbox**.
It is not a production installer or a claim of complete Electron compatibility.

The archive contains the native TOML launcher, GTK desktop host, Obscura renderer,
the original Electron modules compiled for Weber's replacement bindings, runtime
JavaScript helpers, and the required stable Node-API addon. It excludes Chromium's
browser runtime, Node/Bun executables, compiler dependencies and `node_modules`.
Obscura's standalone JavaScript engine still uses V8.

## Use an extracted archive

Use a Linux distribution compatible with the build machine. Install GTK 3,
fontconfig, fonts, libpng, X11/XScreenSaver libraries and libstdc++; run inside
an X11 desktop session.
`bundle-manifest.json` records the build target, glibc version, required ELF symbol
versions, direct shared libraries, source commits and hashes of every other file.
Those symbol versions are a lower bound for the binaries themselves; system
shared libraries and an external Node/Bun runtime can add newer requirements.
No claim of portability to older distributions is made.

For JavaScript applications, install Node.js 24 or the Bun version tested in the
associated CI run. Bun currently supports CommonJS application entry points.
Native applications require neither Node nor Bun at runtime. The supplied native
example is already compiled; your own native application must be compiled once.

Put `weber.toml` in your application directory:

```toml
[backend]
kind = "node" # or "bun" with the same CommonJS app
entry = "main.cjs"
```

For a native application:

```toml
[backend]
kind = "native"
executable = "my-native-app"
```

Run the launcher from the extracted archive. It finds the adjacent
`electron-runtime` directory automatically:

```sh
WEBER_UNSANDBOXED_DEVELOPMENT=1 /absolute/path/to/weber-backend run --project /absolute/path/to/app
```

The explicit environment variable acknowledges that this is the unsandboxed
development runtime. Do not set it for untrusted content.

The included `examples/node` and `examples/bun` applications automatically test
two real windows, isolated preload, IPC, DOM evaluation, capture and close.
`examples/native` tests a real native window, DOM evaluation and presentation.
Run each through the extracted selector, with no source-checkout path overrides:

```sh
WEBER_UNSANDBOXED_DEVELOPMENT=1 python3 smoke.py --backend node
WEBER_UNSANDBOXED_DEVELOPMENT=1 python3 smoke.py --backend bun
WEBER_UNSANDBOXED_DEVELOPMENT=1 python3 smoke.py --backend native
```

Use `xvfb-run -a` before `python3` on a machine without a desktop session.
The Linux smoke verifier needs kernel/Python pidfd support and a matching `/proc`
PID namespace so cleanup can signal verified process identities safely.
The verifier checks all bundled file hashes before launching. The archive's
separate `.sha256` file checks transport integrity; neither is a signed publisher
identity. Keep smoke output outside the extracted directory.

## Assemble in CI after a successful build

The packager uses Python 3.11+, Git, Cargo, rustc and `readelf`. It never compiles
or downloads executable binaries. Locked Cargo metadata may fetch package sources
to collect notices, including metadata for other workspace members. Build the release launcher in addition to the
already-built engine, host, renderer, native example and Electron source bundle:

```sh
cargo build --release --manifest-path weber/runtime-config/Cargo.toml
python3 weber/packaging/package.py --output out/development-bundle
mkdir -p out/extracted-bundle
tar -xzf out/development-bundle/weber-*-development-*.tar.gz -C out/extracted-bundle
```

Run `smoke.py` inside the single extracted `weber-…` directory for Node, Bun and
native as shown above. Archive the tarball, checksum and smoke JSON outputs as CI
development artifacts. No GitHub Release or system installation is performed.

The packaging layout is deterministic for identical built inputs: sorted tar
entries, fixed permissions, zero owner IDs, stable gzip metadata and timestamps
from `SOURCE_DATE_EPOCH` or the Weber source commit. This does **not** assert that
independent Rust/C++ builds are already bit reproducible. Keep the generated
Cargo lockfiles, npm lockfile and patch hashes recorded in the archive when
repeating a build.

Electron, Weber and Obscura root license files are preserved when present.
`licenses/cargo-inventory.json` records versions, sources, SPDX declarations and
available LICENSE/NOTICE/COPYING/COPYRIGHT/PATENTS files for normal Cargo dependency
closures. Proc-macro packages can appear in that conservative closure. Packages
without notice files are explicitly listed; some native components bundled by a
crate may require additional notices or source distribution. This collection is
evidence for a later distribution review, not a complete third-party license audit.

The IPC/frame optimization bundle is
[56cfe40](results/56cfe40.json), from
[CI run 34433240209](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34433240209).
It contains 29 compiled original Electron modules, native protocol,
clipboard/display/notification/power bindings, batched renderer IPC and shared
immutable capture/presentation frames. All three backend examples
passed after extraction. See its record for the archive link and checksum.

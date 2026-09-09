# Weber — Electron / Obscura migration

This branch contains Electron's source and ancestry, plus Weber's development
history. Electron's MIT LICENSE and original source remain at the repository
root; its original README is README.electron.md. Weber's Apache-2.0 code and
license live under weber/. See weber/UPSTREAM_REVISIONS for exact source commits.

The active task is replacing Chromium's engine implementation with Obscura.
Backend alternatives and agent features are deferred until this route works.

## Implemented boundary

shell/renderer/obscura contains a C++ adapter calling the actual Obscura engine
through the statically linked C ABI in weber/crates/weber-engine. It loads local HTML, executes
JavaScript with a watchdog, changes viewport, and captures PNG output. The
standalone smoke checks DOM results, exceptions, rendering changes and invalid
requests. No Chromium libraries are linked into that executable.

This is the first replacement-renderer component, **not a working replacement
Electron binary**. Electron's existing BrowserWindow/WebContents still use
Chromium; they are not yet routed to this adapter. The normal BUILD.gn remains
Chromium-dependent. The separate CMake target tests only the new boundary.

Obscura brings its own V8 build. This library must run in a dedicated replacement
renderer process, not in Electron's main process alongside Electron's V8.
A Linux process launcher and bounded private transport now connect the browser-side
proxy to a dedicated renderer. Native surface integration and OS sandbox remain
unimplemented. The C ABI itself is not a security boundary.

## Reproduce the boundary test on Linux

```sh
git submodule update --init --depth 1 weber/vendor/obscura
cargo build --release --manifest-path weber/Cargo.toml -p weber-engine
cmake -S shell/renderer/obscura -B out/obscura-boundary -DWEBER_ENGINE_LIBRARY="$PWD/weber/target/release/libweber_engine.a"
cmake --build out/obscura-boundary
ctest --test-dir out/obscura-boundary --output-on-failure
```

Requires Rust, C++17, CMake and Obscura's native build dependencies. Only Linux is
currently tested. An externally set CARGO_TARGET_DIR changes the library path.
The PNG capture is a diagnostic path, not a performance solution. No comparative
memory/performance results exist.

## Next engine replacement work

1. Introduce an asynchronous engine-neutral browser-side contract in place of direct
   content::WebContents dependencies. Preserve Electron's public JS contracts.
2. Wire the replacement renderer process proxy into that contract, including navigation,
   frame lifecycle, input, callbacks and failure reporting.
3. Replace PNG capture with raw-frame/dirty-region presentation to native windows.
4. Implement isolated preload, message ports and process sandboxing before
   claiming existing Electron app compatibility.

Upstream Electron workflows are preserved under weber/upstream-electron-workflows
as reference. They are not activated as Weber release jobs. The source import
workflow refuses to overwrite this branch if it already exists.

See weber/migration/ENGINE_REPLACEMENT.md for the source-level dependency map.

## Verified integration

[Migration CI 34354236566](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34354236566)
built the Rust static library and C++ executable and passed the real Obscura
boundary test on Linux. Imported source commit:
`37f9050f2ddc9db1f76a41a8965a28ad879b3ce4`.
Its two parents are the pinned Electron source commit and Weber implementation
commit `4cf5f266c4d7967791f0b3678addb78a854915ac`.
The initial shared-library attempt failed because the prebuilt V8 uses TLS
relocations incompatible with a shared object; the validated build statically
links it into the separate executable.

The [browser-side process proxy](shell/browser/obscura/README.md) describes the
new process transport and its exact integration limits. The normal Electron
BrowserWindow/WebContents path still uses Chromium.

# Text geometry and persistent browser storage

Validated 2026-11-09 on Linux x64. This increment builds the actual Servo host;
it is not a browser shim, a Monaco integration or a Code-OSS port.

## Implementation

`servo-range-geometry.patch` connects DOM Range queries directly to the existing
in-process layout trait. Text bounds come from shaped glyph advances, font
metrics and actual fragment/scroll-tree transforms. It maps UTF-16 DOM boundaries
to the existing scalar/text-transform mapping and handles partial selections,
zero-width carets and selected element boundaries. Each text fragment retains
only inline spatial metadata; no second DOM, text tree or glyph buffer is built.
Queries currently walk the nearest rendered ancestor's fragments. Large-document
query costs have not been benchmarked, and broad vertical-writing/complex-bidi
or grapheme conformance is not established by the selected cases.

`servo-app-origin.patch` gives packaged applications a stable `weber-app` origin
whose authority derives from SHA-256 of the manifest app ID. The authority uses
two 32-character labels. Assets are served only for the configured application's
authority (apart from Weber's existing built-in desktop assets). URL and blob
origin reporting use Servo's origin representation consistently. The custom
scheme serializes its default port as `:0`.

The ordinary and layer-shell hosts enable Servo's IndexedDB preference and use
an app-scoped durable profile at:

```
$XDG_DATA_HOME/weber/apps/<sha256(app-id)>/data/browser-profile
```

New Unix profile directories are created with mode 0700. Browser database files
are separate from the existing SDK JSON store. The app ID is an application
identity, not authentication against another program running as the same user.
This does not establish an OS or renderer-process sandbox.

`servo-indexeddb-durable-delete.patch` fixes deletion after a process restart:
the previous implementation treated a missing in-memory database entry as an
absent database even when the backing database still existed on disk. The fixed
path opens the persisted store, obtains its real version and closes SQLite
handles before deletion. Deleting a nonexistent store returns version zero.
The existing client-storage API creates then removes a temporary empty store in
that case. No new thread/process transport is introduced.

The [transport policy](transport-policy.md) applies to future workspace/runtime
services: direct shared data in-process, shared memory or file mappings for large
isolated payloads, pipes for small controls. **The current JSON backend has not
been replaced, and no native zero-copy transport is claimed.** Packaged assets
still use the existing eager loading/cloning path.

## Actual build and acceptance

- Release build: `cargo build --release --locked --features layer-shell --target-dir target/optimized --offline`.
- Servo: `aac43a3f31a259f04a574f5ec4e959c943ad7cc7` (v0.7.0).
- Source/build SHA-256: `711bf450f61a9643824bbe9a3f7a468900a310710286b64bacc21a08235d9d21`.
- Runtime: SpiderMonkey JIT, `aotAvailable: false`; Hermes is not initialized.
- SDK/runtime version remains `0.6.0-alpha.5`; this is not a newly published package.
- Vite 7.1.12 / TypeScript 5.9.3 from the checkout's existing dependencies.
- Native windows run on a newly owned headless GNOME/Wayland display and private
  session bus, with disposable XDG profiles. No host desktop input/settings are used.
- All 15 ordered Servo patches apply to pristine pinned sources and reproduce
  the modified vendor files. The runtime fingerprint matches the current source.

| Workload | Actual result | Artifact |
| --- | --- | --- |
| Original fixed large-app primitives | **13/13 on HTTP and 13/13 packaged**, strict exit 0 | `artifacts/large-app/native.json` |
| Extended text Range geometry | **12/13 on HTTP and 12/13 packaged**, strict exit 1, `passed: false` | `artifacts/range/native.json` |
| Durable app storage | **12/12 sequential process launches**, strict exit 0 | `artifacts/browser-storage/native.json` |
| Korean IME regression | **13/13**, including Solid Workbench save/restart, strict exit 0 | `artifacts/ime-native.json` |

Profile SHA-256 values:

- Original primitives, unchanged: `09e44afc18c06be6783d0be07e8abf03155b65762032c97aaa226ca9c0e04dec`.
- Range: `228ce4c7d761bdfd2eccd3f85ad31a9994e5c958b07ba26b485ea5be5abc6fb0`.
- Browser storage: `3864bd9a62669109c1001affe100d36ceb1f20300f5c18334842590a222ae584`.

Range passes partial text, collapsed caret, surrogate-pair boundaries, one
combining cluster, normal word wrapping, RTL logical offsets, nested text,
element boundaries, hidden/detached nodes, scale/translation, scrolling and
collapsed whitespace. Bounds reflect real text layout rather than an ancestor's
border rectangle. These are selected tests against the
[CSSOM View Range geometry contract](https://drafts.csswg.org/cssom-view/#dom-range-getclientrects),
not whole CSSOM or text-shaping conformance.

The remaining required case is `wrapped-lines`: `abcdefghij` in a 50px container
with `white-space:pre-wrap; overflow-wrap:anywhere` is laid out as one 120px text
fragment. The containing element is also only one line high (24px). Computed
styles report the requested properties, so this is a line-breaking gap before
the Range query. Normal space-separated text does wrap and returns multiple
line rectangles. The failing requirement has not been removed or marked passing.
This CSS issue remains work before calling the extended renderer gate complete.

Storage tests cover separate app A/B records and origins, binary/Unicode data,
ordinary and blob Worker reads, fresh-process persistence, schema upgrade,
older-version rejection, deletion of an unopened persisted DB with oldVersion 2,
deleting a missing DB with oldVersion 0, and isolation after deletion. They also
reject successful foreign-app asset fetches and verify distinct profile paths
and 0700 modes. Profiles are deleted with the private test session.

This does not certify simultaneous multi-process writers, active-connection
`versionchange`/`blocked` deletion, transaction recovery, production quota
handling or complete IndexedDB behavior. Servo still has connection-lifecycle
TODOs; these sequential tests do not hide them. No new CPU/memory/startup
comparison was measured, and Windows/macOS hosts are not verified here.

The IME regression uses the actual Fcitx5 Hangul engine through GNOME IBus and
Wayland text-input-v3 with OS keycodes. It covers commit, jamo deletion,
10 immediate toggles, kr104 right Alt, UTF-16 insertion, selection replacement,
textarea newlines, Tab/programmatic/window focus, readonly/password controls,
and Solid Workbench typing, save and restart. No synthetic DOM composition
or input events are used; human physical-keyboard testing is not claimed.
Fixtures were rebuilt with the source SDK, reusing `app/node_modules` through
test-local symlinks. The standard offline npm installation failed because its
cache lacked TypeScript registry metadata; this is not recorded as a successful
new npm installation. The local fixture preparation is retained in
`artifacts/ime/prepare-checkout.mjs`.

## Reproduction

Build all fixtures with the source SDK; these commands do not install packages:

```sh
node scripts/large-app-workflow.mjs
node scripts/large-app-workflow.mjs range
node scripts/large-app-workflow.mjs browser-storage
cargo build --release --locked --features layer-shell --target-dir target/optimized --offline
python3 scripts/check-servo-patches.py
```

Run each native suite separately, with no simultaneous private sessions:

```sh
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/large-app-native.mjs
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/large-app-native.mjs --suite=range
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/browser-storage-native.mjs
```

The Range command intentionally exits nonzero while the required CSS case fails.
The original primitive fixture remains locked and unchanged. Monaco, workspace
file/PTY/LSP services and Code-OSS remain later stages; passing browser primitives
does not imply compatibility with them.

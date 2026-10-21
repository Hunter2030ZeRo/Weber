# Native editing and Hyprland — 0.6.0-alpha.3

Weber is a general HTML/CSS/JavaScript/TypeScript application framework. Its
current Linux host is Wayland-only and uses Servo's SpiderMonkey JIT. Static
Hermes remains a deferred optional experiment, not the engine for these tests.
Simulacrum's compositor is **Hyprland**. Weber does not replace its window-manager
or compositor responsibilities; this work provides an application UI foundation.

## Implementation

- Pinned winit 0.30.13 gets a narrow Wayland text-input-v3 backport, not a fork of
  Electron or Chromium. `prepare-winit.py` verifies the upstream archive SHA-256
  and patch, without editing the shared Cargo cache. The ordered Servo extension
  is `servo-native-editing.patch`; the clean-apply checker includes new files.
- Focused input/textarea and editable DOM publish UTF-8 surrounding text and
  cursor/anchor byte offsets. Excerpts are at most 4,000 bytes, retain the whole
  selection and never split a code point. Preedit is excluded. Password fields
  send an empty context. This is not protection from a privileged system IME.
- Delete-surrounding plus replacement is one native group. The transport checks
  the done serial; Servo checks the advertised text/selection again after the
  cancellable `beforeinput` event. Stale requests and invalid byte boundaries
  fail closed. Editable DOM currently rejects surrounding deletion while a live
  preedit range exists; committed-word Hanja replacement is the covered path.
- Losing native window focus commits the existing preedit once. Switching back
  starts a fresh composition without replacing the previously entered syllable.
- Candidate anchors reuse the actual painted caret and the paint-side scroll
  transforms. Changed geometry reaches winit in device pixels, with no additional
  layout query or timer. This currently covers the root document; nested iframe
  caret positioning, RTL/vertical text and pinch-zoom need further coverage.
- Standard `contenteditable="true"` uses native DOM ranges, selection and Servo
  editing commands. Ordinary text insertion, grapheme/word/logical-line movement,
  Shift selection, host-scoped Ctrl+A, plain-text copy/cut/paste, Hangul composition
  and Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y have native paths. Clipboard cuts retain the existing
  write-success-before-delete guarantee and 256 KiB limit. The composition path
  replaces its live range directly, avoiding placeholder BR accumulation.
- Undo retains original DOM nodes and text, preserving listener and framework
  references. It is limited to 32 entries and 2 MiB per document, with 512 nodes /
  256 KiB per snapshot. Entire compositions form one history transaction. A new
  edit clears redo; incompatible external DOM edits invalidate history. These are
  basic native editing transactions, not full rich-formatting/style history.

## Reproduction

Use the normal pinned bootstrap and optimized host build. The test-only Hyprland
runtime is separate from Weber and is never shipped in application bundles:

```sh
python3 scripts/prepare-winit.py --offline --check
python3 scripts/check-servo-patches.py
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --offline
python3 scripts/package.py --binary target/optimized/release/weber-servo \
  --output target/package/weber-clipboard-jit
node scripts/npm-release.mjs target/package/weber-clipboard-jit/weber
node scripts/ime-workflow.mjs --installed
node scripts/editing-workflow.mjs --installed
python3 scripts/build-wayland-test-tools.py
python3 scripts/prepare-hyprland-test.py --offline

env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/nested-hyprland.mjs \
  scripts/hyprland-ime-suite.mjs target/package/weber-clipboard-jit/weber
```

The optional prebuilt test tool lock targets this CachyOS x86-64-v3 host ABI.
Other environments can supply a compatible prefix with
`WEBER_TEST_HYPRLAND_ROOT`; this is not a Weber runtime dependency. GNOME Shell,
Fcitx5 with Hangul/Wayland addons, libhangul, Wayland development tools and the
normal project dependencies must already be present. No system packages,
compositor configuration, keyring, or user input-method configuration are changed.

Hyprland runs in an owned short `/tmp/wh-*` runtime, nested under private headless
Mutter with its own D-Bus/config directories. DRM/seat acquisition is disabled.
An actual Hyprland headless output is created; record the effective monitor size
from `hyprland-environment.json`, not the requested mode. The test keyboard is a
separate Wayland virtual-keyboard-v1 client, so keys pass through Hyprland and the
real Fcitx Hangul engine. JavaScript fixtures observe DOM events and seed/reset
state; they do not synthesize composition/input events or implement an editor.

Artifacts:

- `ime-hyprland-native.json`: 13 existing form/window/Workbench scenarios.
- `editing-hyprland-native.json`: basic editing, cancellation, node identity,
  external-mutation history invalidation and Hanja replacement.
- `ime-reconversion-hyprland-native.json`: committed `한` replaced by `韓` and
  actual Fcitx candidate-popup anchor protocol messages. This does not alone
  certify visual placement under every scale/transform or human candidate choice.
- `ime-native.json`: the independent GNOME/IBus regression gate.
- `editing-native.json`: the most recent editable-DOM run; preserve per-display
  copies rather than treating it as a universal compositor result.
- `hyprland-environment.json`: compositor build, actual output and isolation scope.

For a 200-composition endurance sample, run `editing-native.mjs` under the same
Hyprland wrapper with `WEBER_EDITING_STRESS=1`. Its resource report measures only
the Weber process tree, including owned children, using `/proc` RSS/PSS and CPU
accounting; it excludes the compositor, Fcitx and test driver. Active input is
paced by the OS-input harness. It is not a peak-throughput benchmark or an
Electron/native-toolkit comparison.

## Remaining acceptance boundaries

The Workbench gate starts typing after its first presented frame. A stress probe
that typed before presentation reproduced a startup composition cancellation;
that pre-presentation race remains open. Twelve diagnostic restarts with immediate
post-presentation typing passed. Do not interpret the gate as proof that keystrokes
arriving before the first frame are buffered safely.

This does not establish physical-keyboard behavior, primary DRM-session behavior,
full Simulacrum integration, display hotplug/fractional-scale coverage, screen
reader/accessibility conformance, all rich-editor/web editing semantics, or
Windows/macOS support. Up/down movement is logical text movement rather than
geometric navigation through arbitrary CSS layouts. GNOME/IBus is a separate
transport: the Hanja reconversion acceptance target here is Hyprland's direct
text-input-v3/input-method-v2 path, not a claimed GNOME/IBus reconversion pass.

Tray/global shortcuts, first-class desktop layer-shell APIs, renderer recovery,
clean-OS packaging certification and wider application compatibility remain
framework work. Completing basic IME/editing does not make Weber feature-complete
or turn the downstream desktop project into an implemented desktop environment.

## Recorded final acceptance — 2026-10-21

All rows below passed on the same final runtime/installed SDK source fingerprint:

`27287f7014241b42d865394d2fb1089dea2e45f17536a1ae807fcf1edbef3107`

| Check | Result |
| --- | --- |
| Optimized offline locked build / host tests / Clippy | Passed / 28 tests / passed (upstream warnings remain) |
| Pinned Servo patch reproduction | 11 patches, 44 files match the compiled checkout |
| Pinned winit reproduction | 217 files match the archive plus patch |
| Existing preview regression gates | 8 passed |
| Installed SDK, launcher, production Workbench | Passed; production runs without Node/Bun |
| GNOME/Fcitx form/window/Workbench IME | 13 scenarios passed |
| GNOME native editable DOM | 11 scenarios passed; Hanja gate is Hyprland-only |
| Hyprland/Fcitx form/window/Workbench IME | 13 scenarios passed |
| Hyprland native editable DOM | 12 scenarios passed |
| Hyprland committed Hanja replacement / candidate anchor | Passed / real Fcitx popup protocol received |
| Hangul compose/commit/delete endurance | 200 cycles, 1,000 paced key taps; no accumulated BR elements |
| Native window create/dispose | Both 50 and 200 cycles passed |
| Local alpha archive and npm tarballs | Integrity/source audit passed; not published |

The earlier 12-restart startup diagnostic used build
`ecafec639ac13829a3d68259cc764c3d2efd9aca6514a698b1a3d85ac14b2b03`;
it informed the visible-frame test boundary, rather than replacing the final
same-source gates above.

### Resource sample

The endurance fixture was the standard editable-DOM page with two editors and
an input, after the native editing/Hangul/Hanja scenarios had warmed it up. The
actual isolated Hyprland output was **960×720 at scale 1**; the captured content
surface was 958×718. The compositor was Hyprland 0.56.2 nested under private
headless Mutter, not a full Simulacrum or primary DRM session. CPU below is the
Weber process-tree CPU; 100% means one fully occupied logical CPU. Compositor,
Fcitx, driver and D-Bus helper costs are excluded. Test telemetry was enabled.

| State | PSS | RSS | Idle CPU (about 10 seconds) |
| --- | ---: | ---: | ---: |
| Before endurance | 125.90 MiB | 166.27 MiB | 0.10% |
| After 100 cycles | 129.48 MiB | 169.82 MiB | 0.00% |
| After 200 cycles | 131.97 MiB | 172.31 MiB | 0.00% |

During the two paced 100-cycle blocks, Weber CPU averaged 6.51% and 6.01%,
respectively. Their durations were 40.37 and 46.40 seconds; this is not an
unpaced throughput or input-latency measurement. PSS increased about 6.1 MiB
throughout this short sample; no long-run memory plateau or absence of leaks is
claimed. The separate 200-window gate returned to 28 file descriptors and had
zero additional CPU ticks over its 3.887-second settled idle sample.

Final local artifacts are under `target/alpha/`; matching raw acceptance and
resource records remain under `artifacts/`. Read these as workload-specific
measurements, not an Electron/native-GUI comparison or a general beta score.

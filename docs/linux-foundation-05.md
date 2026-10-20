# Linux document and lifecycle foundation — SDK 0.5.0

This increment extends the Linux JIT developer preview. It is not a completed
Linux beta, a desktop environment, or a Windows/macOS implementation. Static
Hermes remains outside this increment and outside the default host.

The subsequent host-only [native transfer optimization](native-transfer-optimization.md)
records newer builds and resource comparisons without changing SDK 0.5.0.

Status: implemented, compiled and accepted within the scope below on 2026-10-20.
Retained memory after repeated windows remains an explicitly unresolved finding.

## Recorded validation

| Gate | Result |
| --- | --- |
| Native document storage | Exactly 1 MiB encoded JSON and a 120,000-byte Unicode document roundtrip; SDK/native oversized rejection and restart persistence passed |
| Repeated lifetimes | Independent 50- and 200-cycle runs; 1,550 and 6,200 abandoned storage results cleaned up, cross-window result ownership preserved, last-window exit/restart passed |
| Portal parents | All 51/201 native windows exported handles; actual FileChooser calls carried exported parents and open/save/cancel/abort/owner-close scenarios passed with GTK backend |
| Clipboard | Independent GTK roundtrip, worst-case escaped 256 KiB write, oversized external read rejection, limits, cancellation, recovery, native Ctrl+C/X/V and safe-cut preservation passed |
| Distribution | External installed npm SDK/runtime check/build/package/relocation/integrity; Notes persistence/multiwindow and actual Vite HMR passed |
| Project checks | Release build, 15 Rust tests, project Clippy with warnings denied, formatting and diff checks passed |
| Pinned engine patches | Eight ordered patches apply to pristine pinned Servo; all 14 touched files match the compiled checkout, bootstrap patch loop is idempotent |
| Provenance | Seven integration reports, local runtime, installed SDK bytes, tarball hashes and normal Notes executable/libraries/assets agree; no test probe in production bundle |

Final source fingerprint:
`83e7fb3232f46e2e709c41be483757403fd819cbe1895c0f887848f9b4225f72`.
Local artifacts remain under `artifacts/`; `preview-audit.json` records the seven
integration gates and package checks. Local npm artifacts are SDK/runtime 0.5.0;
they are not published to npm or GitHub Releases. The normal app bundle is
`target/package/weber-notes-npm`.

## Implementation

- Text clipboard: 256 KiB UTF-8, checked in the SDK and native worker. Reads are
  bounded during transfer; failed default cuts continue to preserve their text.
- App storage: 1 MiB encoded JSON per value, 128 keys and 16 MiB per area. A
  4 MiB reservation budget bounds queued/in-flight request payloads, including
  tasks whose callers cancel or close. Pending results retain a separate 32-slot
  limit. This is not a whole-process 4 MiB memory budget or a database API.
- Storage worker disconnection fails outstanding requests while preserving
  already completed results, instead of leaving requests to time out.
- Servo's Weber JSON host-call envelope now permits 2 MiB, with smaller native
  operation limits retained. Binary DOM/query limits stay at 1 MiB. This fixes
  the earlier mismatch where an otherwise valid document plus JSON escaping and
  metadata could be silently rejected by the intermediate bridge.
- The host exports each actual Wayland toplevel through xdg-foreign v2, with a
  v1 fallback, and passes its identifier to FileChooser. Exports are destroyed
  before their windows. Unsupported compositors retain unparented dialogs.
  Registry initialization is bounded to 3 seconds after the shared display
  clipboard queue is ready; individual exports are bounded to 400 ms during
  window creation, with no additional thread or idle polling timer.

The identifier format follows the portal's official
[window identifier contract](https://flatpak.github.io/xdg-desktop-portal/docs/window-identifiers.html).
The export implementation uses the pinned wayland-protocols bindings and keeps
the winit-owned surface/display alive for the duration of each borrow.

## Acceptance and reproduction

The native suites and packaging audit record their exact source identities in
local JSON reports; the recorded results appear below.
The suites use private GNOME headless Wayland, a private bus/profile and the GTK
FileChooser backend. They do not send input to the user's desktop.

After building/preparing the current JIT host and local npm packages:

```sh
python3 scripts/check-servo-patches.py
node scripts/lifecycle-workflow.mjs
node scripts/lifecycle-workflow.mjs --cycles=200
node scripts/preview-workflow.mjs --installed
node scripts/clipboard-workflow.mjs --installed
node scripts/npm-distribution-smoke.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/lifecycle-native.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/lifecycle-native.mjs --cycles=200
WEBER_TEST_FILE_CHOOSER=gtk dbus-run-session -- node scripts/headless-wayland.mjs scripts/preview-native.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/clipboard-native.mjs --browser
dbus-run-session -- node scripts/headless-wayland.mjs scripts/clipboard-native.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/npm-distribution-native.mjs
node scripts/preview-audit.mjs
```

Run native suites sequentially. The lifecycle suite tests an exactly 1 MiB
encoded JSON value, a Unicode document, native/SDK size rejection, restart
persistence, 50 sequential child-window lifetimes and 1,550 abandoned owned
storage results. It records process-tree PSS, fd/thread counts and CPU ticks;
the extended variant repeats 200 child lifetimes and 6,200 abandoned requests.
the idle samples are taken from a static test page. Creation-cycle timing
includes script/setup/storage checks and disposal, not just first presentation.
The file and SDK clipboard suites use 256 KiB of control characters whose JSON
representation needs six bytes per character, exercising the intermediate
envelope limit rather than testing only unescaped ASCII.

One final file-suite attempt lost initial focus during virtual-input setup and
timed out before starting a file scenario; its log/trace are preserved locally
as `preview-initial-focus-failure.*`. It is not counted as a passing run.
This reinforces the physical-input verification boundary. The private compositor
also once hung after the app and its checks had finished; the harness now bounds
shutdown of that exact spawned compositor to three seconds before terminating
it. This cleanup is separate from Weber's own clean-exit assertions.

## Remaining scope

Contenteditable default editing, rich clipboard formats, full browser Clipboard
permissions, physical keyboard/IME, accessibility, output changes, GPU/renderer
recovery and clean-OS packaging remain unfinished. This is a short lifecycle
screen, not all-day endurance or a leak-proofing claim. v1/unsupported-compositor
fallback, explicit activation tokens and strict modality across desktop portal
backends still need native verification. Windows/macOS and AOT were not tested.
The locked WPT profile is not rerun by these application-specific suites.

Each area still rewrites one JSON store; multiple processes with the same app id
have no interprocess transaction/locking contract. The file API remains bounded
to 256 KiB UTF-8. Larger/binary/streaming files require a separate API design.

## Resource observation

The extended 200-cycle run lasted 76.3 seconds on the isolated virtual display.
The static page contains 80 rows and an input; it also tests a 1 MiB encoded
JSON value and a Unicode document. Settled process-tree PSS increased from
137.32 MiB to 153.95 MiB (+16.63 MiB). After the first 50 cycles it was
147.13 MiB; subsequent observations fluctuated rather than increasing at a fixed
rate, but they do not establish a memory plateau or absence of leaks. Earlier iterations of this same workload retained approximately 22–26 MiB,
so this lower observation is not evidence of a memory optimization. The cause
of retained memory is not isolated. Treat further memory attribution/reclamation
as open work, rather than calling this a completed memory optimization.

Settled fd count was 28 before and after; thread count was 50 then 51, including
the lazily started reclamation worker. The final static idle observation saw
0 added process CPU ticks over 3.900 seconds. This is a finite-resolution sample,
not a claim of zero CPU on animated or desktop-shell workloads. The 201 parent
exports took median 0.60 ms and p95 1.04 ms; those times exclude window creation
and first presentation. Full create/setup/storage/dispose cycles took median
129.56 ms and p95 174.16 ms. These figures are a single run, exclude compositor
and external GPU allocations, and are not a comparison with Electron or AOT.

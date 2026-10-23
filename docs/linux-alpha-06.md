# Weber 0.6.0-alpha.1 — Linux application/window/system alpha

This report records the original alpha.1 milestone. Alpha.2 added
[Korean IME implementation and acceptance](korean-ime.md); alpha.3 adds
[native editable DOM and Hyprland IME](native-editing-alpha3.md). Original build
identities and measurements below remain historical.

This milestone is a usable **developer alpha** for Linux x64 Wayland applications.
Application authors use HTML/CSS/JS/TS and Vite; Rust implements the framework
host. Servo's existing SpiderMonkey DOM/JIT path remains the default. Bun is an
optional backend process. Static Hermes is not linked into this default runtime;
this milestone makes no Hermes-only DOM or AOT performance claim.

## Integrated application

`workbench` is a SolidJS app template, built through the same public SDK as any
other app. It combines persistent notes, UTF-8 file open/save, text clipboard,
unsaved-close decisions, visible script diagnostics and native window controls.
Ctrl+S saves the app document, Ctrl+Shift+S opens Save As, Ctrl+O opens a text
file and Ctrl+N creates another app window. A system inspector shows native
window/display snapshots and exercises notifications and external links.

From a prepared checkout:

```sh
node sdk/cli.mjs init ../weber-workbench workbench
cd ../weber-workbench
npm install
npm run dev
# Stop dev before running the production flow.
npm run check
npm run build
npm start
npm run package
./package/weber --app ./package/application
```

Packaging needs either the matching installed runtime or `WEBER_HOST` pointing
to a prepared bundle, as described in [npm distribution](npm-distribution.md).
The final app without a backend needs neither Node nor Bun to run. A compatible
glibc/loader, Wayland compositor, system GPU/EGL drivers and fonts remain required.
Portals and a desktop notification service are prerequisites for those APIs.

## Native window surface

Existing multi-window/title/size/maximize/fullscreen/close handling now includes
creation-time `decorations` and `resizable`, runtime decoration toggles,
`minimizeWindow`, `requestWindowAttention`, `beginWindowDrag` and
`beginWindowResize`. Window snapshots include theme, decoration state and the
current display. Public state subscriptions are coalesced, immutable and timer
free when idle. A newly subscribed listener receives the current snapshot even
if another listener already owns the native watch and nothing changes afterward.

Drag/resize requests require a focused calling window and a currently held
native left mouse button. Use a mouse-down handler on a custom titlebar or resize
grip. Synthetic DOM input alone is rejected. The compositor decides whether to
honor requests. Attention is a request, not a guarantee of visible presentation.

Wayland restrictions remain explicit: `minimized` is `null` because this backend
cannot reliably query it. There is no force-restore, arbitrary visibility,
absolute window positioning or always-on-top API. Native focus was observed after
minimization and compositor-mediated recovery in the test; the SDK does not
invent a restore operation.

## System module

```ts
import {
  getSystemInfo, refreshSystemInfo, onSystemChanged,
  openExternal, showNotification, dismissNotification,
} from '@weber/sdk/system';

const stop = onSystemChanged(info => console.log(info.displays));
const displaySnapshot = await refreshSystemInfo();
const notice = await showNotification('Saved', 'Your document was saved.');
await dismissNotification(notice);
await openExternal('https://github.com/Hunter2030ZeRo/Weber');
stop();
```

`appIntegrationProtocol: 1` identifies this host surface. Capabilities describe
implemented interfaces, not whether a service exists or a compositor honors a
request. `getSystemInfo()` reads cached OS/architecture/display metadata; native
focus/size/scale/theme/movement events refresh it. Refresh explicitly after
hotplug of an unused output. At most 32 displays are returned; names are capped
at 64 Unicode scalars. Names and output coordinates are not stable IDs or window
positioning permission. Mixed-scale movement and hotplug still require broader
native validation.

External URLs use the real OpenURI portal with the calling xdg-foreign parent
where available. Only http/https/mailto are allowed; credentials and raw control
characters are rejected, with an 8192-byte bound. Focus is required to start a
handoff. `{ ask: true, signal }` supports a chooser and cancellation. `true` means
the portal accepted the handoff; `null` means user cancellation. It does not prove
that an external page loaded. Response waits are bounded; cancellation cannot
undo an action already issued by another application.

Notifications use `org.freedesktop.Notifications` and the app's desktop identity.
They are plain text, with no actions. Titles allow 1..256 UTF-8 bytes and bodies
up to 4096 bytes, excluding NUL. Handles belong to the originating window:
other windows cannot poll/cancel its requests or dismiss its notifications.
Limits are eight handles per window and 64 per process. The server is asked for
10s expiry; handles are pruned after 30s on subsequent service work. Window close
or navigation requests cleanup. Delivery, expiry and cleanup remain best effort;
the server may suppress presentation, and dismissing an expired handle may fail.

URL and notification services each have eight pending result slots and a bounded
queue, with separate lazy workers. A URL chooser cannot hold up notifications.
Workers block while idle; no recurring system-service timer or UI snapshot poll
was added. Service errors are reported; transparent recovery from a disconnected
session bus is not established by this milestone.

## Desktop launchers and local artifacts

`weber package` writes `<app-id>.desktop` with the final bundle path. The generated
entry uses fixed shell code (`exec "$@"`) and passes paths as quoted argument data;
app metadata and paths are never evaluated as shell code. Real GIO launching was
tested with spaces, quotes, dollar signs, backticks, percent, backslash and Unicode
in a path, plus a newline in the display name. Existing output is never replaced.

The runtime bundle is relocatable; the desktop entry contains absolute paths.
After moving or extracting it, regenerate the launcher:

```sh
weber launcher /absolute/path/to/bundle /tmp/dev.weber.workbench.desktop
# Install this new entry yourself as dev.weber.workbench.desktop if desired.
```

No launcher is installed into the user's desktop automatically. `scripts/alpha-dist.mjs`
creates local SDK/runtime tarballs and a Workbench archive under `target/alpha`
only after current-source acceptance passes. The archive omits stale absolute
launchers and includes checksums/validation. These packages are not published to
npm, and no GitHub binary release is implied.

## Reproduce acceptance

Build with the pinned dependencies and prepare the actual optimized binary:

```sh
cargo fmt --check
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --offline
CARGO_TARGET_DIR=target/optimized cargo test --release --locked --offline > artifacts/preview-rust-tests.log 2>&1
CARGO_TARGET_DIR=target/optimized cargo clippy --release --locked --offline --no-deps > artifacts/preview-clippy.log 2>&1
python3 scripts/check-servo-patches.py
python3 scripts/prepare-stylo.py --offline --check
python3 scripts/package.py --binary target/optimized/release/weber-servo --output target/package/weber-clipboard-jit
node scripts/npm-release.mjs target/package/weber-clipboard-jit/weber
node scripts/alpha-workflow.mjs
WEBER_TEST_FILE_CHOOSER=gtk dbus-run-session -- node scripts/headless-wayland.mjs scripts/alpha-native.mjs
dbus-run-session -- node scripts/launcher-workflow.mjs
```

Offline commands require a previously populated dependency cache. The alpha audit
also requires the existing installed SDK preview/clipboard/npm/lifecycle/activation
gates described in their respective guides, and a normal production Notes bundle.
Run `node scripts/alpha-audit.mjs`, then `node scripts/alpha-dist.mjs`. The audit
checks matching source fingerprints, installed SDK bytes, tarball hashes,
executable/private-library/application asset integrity and absence of acceptance
probes in the production Workbench. A report from a different source revision
cannot promote the current build.

The alpha native fixture requires GNOME/Mutter, Python GI and PipeWire as test
tools. It starts a private PipeWire process to attach absolute OS pointer input
to the actual test monitor stream. The virtual pointer is prepared before the
app connects; the test waits for a DOM motion before pressing a button.
It runs in a private GNOME 960×720@60 Wayland compositor,
never the user's desktop. It observes display data, actual decoration/resize
state, foreign-operation rejection, notification bounds and D-Bus cleanup,
OpenURI delivery to a private handler without network navigation, active chooser
cancellation with concurrent notification, real compositor mouse drag/resize,
minimize/focus recovery, OS Ctrl+S and document persistence across restart.
The normal production package then runs with Node/Bun absent from PATH; its idle
PSS and CPU sample are recorded separately from the instrumented acceptance app.
Zero CPU ticks over a short sample means below sampling resolution, not literally
zero work for every workload or an Electron comparison.

## Recorded validation environment

2026-10-21: Linux `7.2.11-1-cachyos`, x86_64, GNOME Shell 51.1,
Rust 1.99.0 and Node 26.10.0. Native tests use a disposable GNOME
960×720@60 virtual Wayland output and a private session bus; FileChooser is
explicitly routed to the GTK backend. These results do not certify another OS
image or compositor. The runtime is an optimized locked/offline JIT-only build.

The final source fingerprint is
`39ff3866f2508404c56f0d41d43fa6baac919e860d51493f660d99cbe868f735`.
`artifacts/alpha-audit.json` passed against the actual prepared runtime, installed
SDK and production app; `target/alpha/release.json` identifies the local artifacts.

| Check | Recorded result |
| --- | --- |
| Optimized build, formatting, host tests, Clippy | Passed; 23 host tests |
| Existing preview acceptance | All eight current-source records passed, including real file paths, native clipboard, installed SDK/HMR, activation and 50 + 200 window cycles |
| Workbench application/window/system acceptance | Passed in private GNOME Wayland; actual drag/resize/minimize, notifications, URI handoff/cancel and saved-document restart |
| Desktop Entry | Real GIO launch and exact argv/display-name roundtrip passed |
| Source/package audit | SDK bytes, executable/libraries/assets, tarball hashes and absence of shipped acceptance probes verified |
| Production runtime | Normal packaged Workbench ran with Node/Bun absent from PATH |

The normal Workbench idle sample was one process run, after 1.8s settling:
25 process-tree PSS samples at approximately 200ms intervals, median **106.96 MiB**.
CPU accounting recorded **0 ticks over 5.13s** at 100 ticks/s. This is a short idle
sample of a non-animated document/inspector screen, not a literal zero-CPU claim,
startup/active-input benchmark, repeated-run distribution or an Electron/native
GUI comparison. GPU allocations outside process PSS are not included. The
instrumented acceptance app and earlier animated benchmark are different workloads.

## Simulacrum boundary

This alpha supports starting Simulacrum's ordinary UI/configuration applications
and validating their actual Vite/Solid workflows against Weber. It is not yet a
production desktop-shell runtime. First-class layer-shell hosting, Hyprland
integration, tray/global shortcuts and desktop services remain downstream-driven
implementation work. The existing experimental layer-shell probe is not a stable
public SDK surface.

Other remaining work includes physical Korean IME/focus acceptance, accessibility,
contenteditable default editing, rich clipboard and bounded binary/large-file
APIs, renderer/GPU recovery, clean-OS dependency certification, other compositors,
long-running CPU/resource budgets and Windows/macOS hosts. The [beta checklist](linux-beta-checklist.md)
tracks these explicitly; this alpha does not convert them into completed items.

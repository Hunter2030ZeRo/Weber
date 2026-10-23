# Simulacrum prototype foundation — 0.6.0-alpha.5

This increment makes a **single-output panel and window-switching prototype**
possible on actual Hyprland. It is an optional Weber host mode and backend
integration, with an HTML/CSS/TypeScript example. Simulacrum remains a downstream
desktop project using Hyprland as its compositor.

## Implemented slice

- `--features layer-shell` enables `layerPanelProtocol: 1` and
  `weber --panel-app APPLICATION`: a persistent 48px top layer surface with
  top/left/right anchors, a 48px exclusive zone, compositor configure/frame
  handling and actual Wayland pointer input forwarded to Servo.
- The layer surface never requests keyboard focus. Ordinary application windows
  keep focus and are arranged below the reserved panel area.
- Compiled app assets/manifest use the same `weber-app` protocol as normal apps.
  Panel JS supports its capability-checked Bun backend and telemetry. Navigation
  is restricted to its entry or the explicit panel close request.
- Backend event wakeups feed the layer event loop directly. There is no native
  periodic event-loop polling. Normal-window backend wakeups retain their
  existing winit path.
- `@weber/sdk/hyprland` is an optional backend-only module. It provides bounded
  snapshots, event-driven refresh, disconnect/reconnect reporting and typed
  workspace/window focus operations over Hyprland's Unix sockets. It does not
  invoke `hyprctl` or a shell, and is not imported by ordinary Weber apps.
- The `shell` template supplies workspace buttons, active-window text, and a
  separate normal native window with search/filter/selection of running windows.
  That normal window uses the existing text-input-v3/IME implementation.

The example's normal window is a **running-window picker**, not an installed-app
catalog or arbitrary process launcher. The panel backend can spawn only the
current compiled app through the exact current host path and fixed argv. Closing
the panel normally destroys its backend group and the picker it opened.
`WEBER_HOST_EXECUTABLE` is supplied by the native host to its backend, together
with the existing `WEBER_APP_DIR`; neither comes from browser input.

The picker is a transient second host process, with its own Servo and Bun backend.
This keeps keyboard/IME on the already tested window path but adds memory/startup
cost while the picker is open. No performance gain is claimed by this slice.

## Run the example

In a prepared source checkout with Bun available for backend compilation:

```sh
CARGO_TARGET_DIR=target/optimized cargo build --release --features layer-shell --locked
python3 scripts/package.py --profile release \
  --binary target/optimized/release/weber-servo --output target/package/weber-shell
export WEBER_HOST="$PWD/target/package/weber-shell/weber"
node sdk/cli.mjs init /tmp/weber-shell-demo shell
cd /tmp/weber-shell-demo
npm install
npm run check
npm run package
./package/weber --panel-app ./package/application
```

Use an existing Hyprland session for an interactive demo. No user configuration
or autostart entry is installed. The `×` button stops this panel; it does not log
out or stop Hyprland. `npm run dev` opens the ordinary window picker through Vite.
For the compiled app, the SDK also accepts `weber panel dist` when its selected
runtime was built with the optional feature. A standard host without the feature
rejects this mode explicitly.

Applications remain framework-neutral: this example uses plain DOM, while the
other templates demonstrate Solid/React/Vue/Svelte/Angular. Hyprland is optional
downstream integration; Windows/macOS and other Linux compositor backends retain
their own future implementations.

## IPC and resource contracts

The client selects `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE` after
validating the session path/signature. Requests time out (default 2s), accept at
most 1 MiB of response and have a 16-request concurrency limit. Snapshots contain
at most 8 monitors, 32 workspaces and 48 windows, with titles/classes bounded to
200 JavaScript characters and an explicit `truncated` flag. The serialized
snapshot also has a 24 KiB UTF-8 budget, trimming the client prefix as needed so
multibyte window titles fit the backend event envelope. These limits are a
prototype contract, not a full desktop window-management database.

Event bursts coalesce for 60ms. When connected and quiet, no periodic snapshots
run. Disconnects emit a disconnected state and retry with bounded backoff; abort
closes the subscription socket and pending requests. Snapshot queries are
separate IPC operations, not a compositor-atomic transaction. Workspace IDs are
positive 32-bit integers and focus addresses are validated hex values; the API
does not expose arbitrary compositor expressions or shell commands.

## Validation

Local SDK and platform runtime tarballs were installed in a fresh project; the
template passed TypeScript checking, Bun backend compilation, application build,
package hash checking and relocation. The packaged test uses an executable
search path containing no Node/npm/Bun; its compiled backend and fixed native
host path remain sufficient.

The native suite runs only in an isolated Hyprland 0.56.2 nested in private GNOME,
on a 960×720 scale-1 output. It verifies the actual layer role/geometry/PID and
exclusive area, pointer clicks reported as trusted DOM events, real workspace
changes through the example's backend, return events reaching the DOM, normal
window creation, real Fcitx5 Hangul search, keyboard selection/focus of another
app across workspaces, picker close and panel/owned-process cleanup.

The separate mock-socket client suite verifies segmented responses/events,
invalid-command arguments, no idle query polling, event socket reconnection,
timeouts and cancellation. Those mock results are not compositor acceptance.

Reproduction after building/preparing the host above:

```sh
node scripts/npm-release.mjs target/package/weber-shell/weber
node scripts/framework-workflow.mjs
node scripts/shell-workflow.mjs
node scripts/hyprland-client-test.mjs
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/nested-hyprland.mjs \
  scripts/framework-native.mjs
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/nested-hyprland.mjs \
  scripts/shell-native.mjs
```

Build the owned virtual keyboard/pointer helper with
`python3 scripts/build-wayland-test-tools.py`. The helper refuses to operate
outside the private Hyprland test environment. Its protocol XML retains the
upstream wlr-protocols copyright/license notice. Run native suites sequentially.
Records are in `artifacts/shell-workflow.json`, `artifacts/shell-native.json`,
`artifacts/framework-workflow.json` and `artifacts/framework-native.json`.
Acceptance observer modules are copied into generated fixtures only.

## Remaining prototype and beta work

This panel contract is deliberately narrow: one output, fixed height/top layer,
pointer buttons/motion, no layer keyboard/IME, no native window/storage/clipboard
SDK on the panel itself, and no panel-mode Vite/HMR. Layer-surface IME would need
its own focus/text-input plumbing and new native acceptance; the picker uses a
normal window today. Multimonitor selection, scaling/hotplug policy, arbitrary
layer roles, scrolling/touch/drag behavior and panel-native services are not
certified by the single-output test.

Installed-app discovery/launching, desktop icons, tray/global shortcuts,
notification center, session supervision/restart, compositor/renderer recovery,
accessibility, permissions and long-session resource budgets remain needed for a
broader Simulacrum prototype or Linux beta. The example and this report do not
constitute a completed desktop environment. Windows/macOS hosting and Static
Hermes remain outside this increment; the tested UI engine is SpiderMonkey JIT.

References: [Hyprland IPC](https://wiki.hypr.land/IPC/),
[Hyprland dispatchers](https://wiki.hypr.land/Configuring/Basics/Dispatchers/),
[layer-shell protocol](https://gitlab.freedesktop.org/wlroots/wlr-protocols/-/blob/master/unstable/wlr-layer-shell-unstable-v1.xml).


## Final alpha.5 verification — 2026-10-23

The final installed SDK/runtime is `0.6.0-alpha.5`, Servo/SpiderMonkey JIT with
the optional layer-shell feature enabled (`aotAvailable: false`). Six UI templates
passed installed-SDK type checking, ordinary-Vite auto-bindings builds, Node-UI
rejection, packaging and relocation. The native report contains 12 passing
scenario groups: package and development execution for each of DOM, Solid,
React, Vue, Svelte and Angular. Svelte/Angular template type errors and native
AOT requests were rejected. Development update/state behavior is recorded above.
The installed SDK's source module files match the checkout in all six UI projects
and the shell project.

The native shell report contains five passing scenario groups for the real panel,
exclusive zone and focus policy, workspace pointer control, real Hangul window
search, app focus/close behavior and owned-process cleanup. After normal panel
close, none of the four recorded panel/backend/picker processes remained running.
The preceding layer rendering/capture probe also passed on private KWin. That
probe is separate from the actual Hyprland shell acceptance.

Native checks: release compilation, default-feature `cargo check`, layer-enabled
Clippy with `-D warnings --no-deps`, and all 28 existing Rust tests passed.
Upstream Servo warnings remain. The mock IPC suite additionally verified actual
UTF-8 JSON budgeting for many long Hangul window titles; it does not replace the
real-compositor suite. No performance benchmark was performed for this increment.

Final source fingerprint:

```text
bab24a86c4677e04e1d5736d00cd1f0a67694e523f7aec23fcbe8b8a6ae4172c
```

Tested local SDK tarball SHA-256:

```text
244726647f43ddd060eb89e9f26dbf520a2ca2273852e6125c039cceed50b80f
```

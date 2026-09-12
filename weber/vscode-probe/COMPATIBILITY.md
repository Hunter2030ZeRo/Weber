# VS Code migration status

## Latest native window and menu milestone (`ae00460`)

[CI run 34673770600](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34673770600)
passed all **21 runtime gates**. Node/Bun tests with Openbox verify Linux simple
fullscreen aliases, actual maximize/minimize/restore state and events, and native
menu visibility with content resizing. Menu checks cover replacement, hidden
accelerators, Alt toggling, Escape, independent windows and frameless policy.
Existing title-bar, shutdown and runtime regressions also pass. See the
[validation record](../packaging/results/ae00460.json), [window-state scope](../electron-runtime/WINDOW_STATE.md)
and [menu-bar scope](../electron-runtime/MENUBAR.md).

The strict original-layout VS Code 1.136.2 run passes the previous fullscreen,
window-state and menu-visibility failures and now reports
`Error: Weber has not implemented webRequest.onBeforeSendHeaders`.
The expanded-dependency comparison reports the same error. Both retain
`ready: false` and `timed_out: true`; exit code 0 follows diagnostic termination
and is **not** successful workbench startup.

CommonJS/Node ESM loaders and shutdown implementation are unchanged. The next
smallest observed contract is `webRequest.onBeforeSendHeaders`: implement actual
outgoing-header modification and cancellation, preserving request framing,
redirect credential stripping and abort behavior, then rerun original VS Code.
HTML fullscreen, browser-side Window Controls Overlay geometry/CSS integration
and standalone Monaco worker semantics remain separate gaps.

Target: the unmodified Linux x64 VS Code 1.136.2 application at the revision in
`pin.json`, running through the original Electron source modules on Obscura.
The historical full native probe (45c56bb) passed the previous `desktopCapturer`
import failure and exited while resolving `@vscode/spdlog`. That package is present
inside the original `node_modules.asar`; archive filesystem/module loading was
missing in that build. A diagnostic exit code of zero means evidence collection
succeeded; the report itself has `ready: false`. No whole-app compatibility
percentage is inferred from exported names or module counts. Bun bare Electron
ESM imports remain unresolved.

A separate 45c56bb `--expand-dependencies` run copied authentic ASAR dependency bytes
inside its temporary app tree. It preserved 669 existing identical files and
expanded 4,420 files, with 75 newly executable files and 16 native addons in the
dependency inventory. The app source remained unchanged; its package layout changed.
That run reached `CodeApplication.configureSession` and exited at
`session.defaultSession.setPermissionRequestHandler`. This is an observed failure,
not transparent ASAR support or a workbench pass. The archive's original diagnostic
used a generic exit message; the exact exception is recovered from its saved stderr
by the separately tested VS Code log-prefix parser.

Revision `72f2c8d` implements bounded read-only ASAR filesystem/module loading,
session permission handlers, two webRequest events and the original nativeTheme
module. A direct check loaded the pinned distribution's original ASAR-backed
`@vscode/spdlog`, including its declared unpacked native addon, without expanding
or rewriting the package layout. See [ASAR.md](../electron-runtime/ASAR.md) and
[SESSION.md](../electron-runtime/SESSION.md) for exact boundaries.

Previous validation: [72f2c8d](../packaging/results/72f2c8d.json) passed all 16
runtime gates in [CI run 34503083387](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34503083387).
This includes 11 engine tests, actual GTK nativeTheme changes, Node/Bun protocol
and browser-clipboard permission fixtures, and extracted Node/Bun/native bundles.
The local new-feature suites report 69 passes on Node and 50 passes with five skips on
Bun; the runners count subtests differently. The intermediate
[2b8adbd record](../packaging/results/2b8adbd.json) remains a failed 13-of-16 run:
obsolete `original-fs === fs` assumptions failed its Node/Bun/bundle fixtures.
The corrected fixtures check actual raw and archive filesystem behavior.

The strict original-layout `72f2c8d` VS Code 1.136.2 run now passes ASAR loading
and session configuration, then stops at
`Weber has not implemented powerMonitor shutdown inhibition`, matching the
expanded-dependency run. Both application processes exit 1 without a timeout and
both reports retain `ready: false`. The prior
[71ac31a strict run](../packaging/results/71ac31a.json) failed to resolve
`node_modules.asar/@vscode/spdlog/index.js`; that composition failure is resolved
in the 72f2c8d run. This establishes a later failure in the unmodified application,
not a running workbench.

Historical [45c56bb validation](../packaging/results/45c56bb.json) passed 16
execution gates and extracted Node/Bun/native examples. The remaining results
in this paragraph and the following two paragraphs describe that build. Utility tests
pass seven per JavaScript backend, startup services pass four on Node and three
on Bun (one Node-only skip), and safeStorage unit checks pass four per backend.
Real GIO shell tests still pass on both. Electron 42.0.0, Node and Bun cross-read
sync ciphertext in 18 process combinations using an isolated GNOME keyring.
Six simultaneous first-use processes share one key; locked/missing services fail
closed; restarting and unlocking the owned daemon restores the persisted key.
These are API tests, not VS Code's complete secret-service acceptance.

Power-save unit tests pass four per JavaScript backend. Eighteen native protocol
scenarios pass across Node/Bun: GNOME, freedesktop fallback, missing service,
refused upgrade/downgrade, daemon loss, app/host SIGKILL and late responses. Every
scenario ends with zero owned inhibitors. Service loss is recoverable; fatal host
exit status remains intact. Physical sleep/display policy remains unverified.
The startup diagnostic also has four regression tests to distinguish actual
exceptions from error-like text embedded in minified source lines.

Successive unmodified VS Code runs moved from missing crashReporter to shell,
safeStorage, powerSaveBlocker, net and desktopCapturer to ASAR dependency loading.
This remains startup progress, not proof of a running workbench. Desktop capture
adds seven callback tests per backend and actual X11 window/screen capture on
Node/Bun, including extracted bundles. A native fixture verifies real pixels,
icons, titles and source lifecycle. Monaco's module-worker blocker is unchanged.

The probe records 24 named imports from the pinned application. An API
appearing in this table does not mean every method works. This inventory does
not include every access through a default import: VS Code also reads
`electron.nativeTheme`, shown as an additional row. The table describes current
implementation scope; the current native fixtures pass while the full
application diagnostics still fail at the boundaries identified above.

| VS Code import | Implemented scope (validation described above) | Remaining migration work |
| --- | --- | --- |
| BrowserWindow | Original Electron wrapper, two native GTK windows, load/show/hide/size/close | Full window state, parent/modal behavior, platform-specific features |
| webContents | Original wrapper, DOM/Promise evaluation, capture, load lifecycle, renderer IPC | Full frames, navigation, structured clone, DevTools, input/console contracts |
| Menu | Original template policy and actual GTK menus/accelerators | Popup menus, icons, several built-in roles |
| MenuItem | Original ordering, checkbox/radio and click handling | Remaining native menu attributes and roles |
| MessageChannelMain | Original wrapper, bounded structured messages; main-process and main-to-utility ownership transfer | Renderer transfer, nested utility transfer and full browser clone types |
| Notification | Original module; native D-Bus delivery/update/default click/close and absent-service failure on Node/Bun | Full actions, image-object icons, daemon restart and platform-specific behavior |
| WebContentsView | Original module resolves | Actual view construction and embedding |
| app | Lifecycle, selected Linux paths/locales, bounded startup option state with explicit warnings for inactive Chromium hints | Actual engine-option equivalents, singleton/CLI relaunch, other app services |
| clipboard | Native CLIPBOARD/PRIMARY, modern ClipboardItem and legacy text/HTML/RTF/binary | Full NativeImage, bookmarks and additional platform formats |
| contentTracing | Original module; actual bounded Node main-process marks/measures, trace-event JSON, start/stop/restart | Renderer traces, sampling, memory dumps, Chromium categories, Bun recording |
| crashReporter | Original module; inactive metadata and no-upload queries; enabling capture/upload fails explicitly | Native crash collection, process integration and uploading |
| desktopCapturer | Original wrapper connected to X11 window/screen enumeration, titles, monitor IDs, icons and PNG thumbnails | Full NativeImage, obscured windows, Wayland portals, display-media streams and other platforms |
| dialog | Error logging only; no verified native dialog contract | Native file/message dialogs and cancellation |
| globalShortcut | Original module, real X11 registration/conflicts/callbacks | Wayland portals, suspension and keyboard-map changes |
| net | HTTP/HTTPS streams, redirects, compression, cancellation, explicit-omit fetch, DNS and WebSocket; main and utility paths; session-owned policy on main HTTP/HTTPS | Shared browser cookies, proxy/PAC/cache, interception of direct renderer HTTP/HTTPS, WebSocket and utility networking, complete network semantics |
| powerMonitor | Original module; native X11 idle queries, UPower/logind power/suspend/resume/lock transport; bounded shutdown delay descriptors on Node/Bun | Unsupported thermal/platform data, physical shutdown and full desktop acceptance |
| powerSaveBlocker | Original module; aggregated IDs and priority; native GNOME/freedesktop acquisition/release, failed-transition rollback and ownership cleanup | Real desktop physical sleep/display acceptance, raw XScreenSaver fallback, Wayland portals and other platforms |
| protocol | Original module, custom/file interception, handle/Response, document/CSS/JS/module/fetch loading; session policy cancellation and response-header/status changes | Full redirects, HTTP handlers, renderer ASAR URL reads and complete browser privilege semantics |
| safeStorage | Original module; Linux libsecret-backed sync encryption, v10/v11 Buffer format and explicit basic-text opt-in; derived-key cache | Async format/key migration, KWallet, other operating systems and full VS Code secret-service acceptance |
| screen | Original module, native monitors/cursor/work area/scale and change events | Rotation, color profiles, DIP conversion and complete display metadata |
| session | Partition-owned protocols and permission handlers; onBeforeRequest/onHeadersReceived on main HTTP/HTTPS and renderer custom/file resources; permission-gated native renderer clipboard text | Other webRequest events/transports, media/display/geolocation/browser Notification acquisition, persistent cookies/storage and proxy/cache/certificate behavior |
| shell | Original module; real GIO URI/file launch and reversible trash on Node/Bun; folder fallback tested | Real file-manager item-selection acceptance, beep and platform-specific operations |
| systemPreferences | Original Linux module, GTK accent and animation settings | Other operating systems and wider preference integration |
| utilityProcess | Original wrapper and ParentPort; real same-backend child, stdio/argv/cwd/env, CJS/ESM entry (Electron ESM imports only on Node), main-to-child port transfer, two-way data and termination | Actual VS Code extension host, renderer ports, nested transfers, session/proxy auth integration and full process-tree cleanup |
| nativeTheme (default import) | Original module, GTK foreground/background and high-contrast observation, cached properties and native updated events; system themeSource | Forced light/dark themes, reduced transparency, renderer color-scheme/forced-colors propagation and other platforms |

The Electron TypeScript modules remain in the fork source tree.
The replacement runtime compiles 43 of them and records exact source hashes.
Two network modules and the shutdown first-listener wrapper carry explicit, manifest-recorded Weber adaptations.
Additional behavior lives at their native binding boundary, with explicit
unsupported errors where implemented entry points cannot perform an operation.

## Standalone editor evidence

The [Monaco probe](../monaco-probe/README.md) executes upstream Monaco 0.52.2
with the same app on Electron and Weber. Weber passes document load, editor
construction, model edits, undo, native X11 keyboard input, rendered line DOM/PNG,
and scrolling to line 700 in a 1,000-line document. All seven core checks pass in
`72f2c8d`. The worker-driven diff fails with `Unexpected token 'export'`;
Electron passes that check. This standalone Monaco release is not claimed to be
the exact editor revision embedded in the pinned VS Code distribution.

The pinned Obscura Worker implementation evaluates fetched scripts through a
page-realm JavaScript shim and ignores module options. It lacks actual dedicated
worker execution and module-worker semantics. Fixing this boundary is required
for Monaco background services; accepting an editor constructor is insufficient.
Renderer MessagePorts and the actual extension host remain unfinished contracts.
Independent utility-process execution and main-to-utility MessagePort transfer
have dedicated tests; they do not establish complete extension-host compatibility.
Native Notification/powerMonitor checks use actual runtime transport
with controlled D-Bus peers, not a full desktop acceptance suite.

## Session and appearance dependencies

The pinned [CodeApplication source](https://github.com/microsoft/vscode/blob/88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f/src/vs/code/electron-main/app.ts)
installs `setPermissionRequestHandler`, `setPermissionCheckHandler`,
`setDisplayMediaRequestHandler`, and `webRequest.onBeforeRequest/onHeadersReceived`
during session configuration. Revision `72f2c8d` implements those entry points
with session/document ownership checks and actual enforcement on the supported
transports. Main HTTP/HTTPS and renderer custom/file resources enforce request
policy. Browser clipboard text operations use native work after permission;
media/display streams, geolocation and browser Notification delivery remain
unavailable even if policy grants them. These are scoped implementations, not
complete Electron Session behavior or comprehensive renderer network confinement.

The pinned [theme service](https://github.com/microsoft/vscode/blob/88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f/src/vs/platform/theme/electron-main/themeMainServiceImpl.ts)
subscribes to `nativeTheme.updated` and reads/writes theme properties through the
default Electron import. This dependency is outside the named-import inventory.
The original nativeTheme module now receives actual GTK system appearance and
change events; forced themes and renderer media-query propagation remain gaps.
The historical 45c56bb expanded-dependency run encountered
`setPermissionRequestHandler` first. Both verified 72f2c8d runs now reach
powerMonitor shutdown inhibition, including the strict original package layout.
That unsupported operation is the observed next startup failure. Neither result
establishes workbench startup.

## Acceptance work still required

Shutdown-listener registration, previously the first failure in `initChannels`,
is implemented and verified in `ea03b58`; the source wrapper adaptation is
recorded in the manifest. See [POWER_MONITOR.md](../electron-runtime/POWER_MONITOR.md)
for asynchronous logind descriptor ownership, synchronous cancellation,
once-listener handling, cleanup, best-effort availability and the five-second
local delay bound. This does not establish physical desktop shutdown acceptance.

The native title-bar contract is implemented and verified in `2642ee0`; see
[TITLEBAR.md](../electron-runtime/TITLEBAR.md) for its tested scope and remaining
browser geometry/CSS gaps. Linux simple fullscreen uses the native fullscreen
state, as in retained Electron, and is verified alongside maximize/minimize and
restore in `ca71dce`. Menu visibility and hidden accelerators pass in `ae00460`.
See [FULLSCREEN.md](../electron-runtime/FULLSCREEN.md),
[WINDOW_STATE.md](../electron-runtime/WINDOW_STATE.md) and
[MENUBAR.md](../electron-runtime/MENUBAR.md). Both VS Code diagnostics now report
`Error: Weber has not implemented webRequest.onBeforeSendHeaders`.
The next step is the outgoing-header hook with real mutation/cancellation and
regression checks for redirects, request framing, aborts and custom protocols.
Workbench readiness remains unverified.

[ACCEPTANCE.md](ACCEPTANCE.md) records the project success criterion: the same
VS Code application must provide equivalent visible behavior with lower resource
use. These steps are required even if individual API tests already pass.

1. Start the unmodified workbench through its real custom-scheme module graph,
   preload, configuration and IPC services. A screenshot or a loaded title alone
   will not count as a workbench pass.
2. Open a workspace, edit/save a file, exercise selection/clipboard and IME, and
   compare visible output and commands with the pinned Electron application.
3. Run the actual terminal and extension host, verify port transfer, isolation,
   crashes, shutdown and process cleanup. Repeat with two independent windows.
4. Exercise native menus/dialogs/notifications, drag and drop, session storage,
   relaunch and packaged application behavior.
5. Compare identical workspace/extension workloads, including process-tree PSS,
   idle CPU, interaction latency and peaks. Separate application/extension costs
   from runtime overhead; do not extrapolate the small fixture's ratio to VS Code.

Node is the primary path for the unmodified VS Code JavaScript main. Bun
CommonJS applications already run through the same Electron source runtime, but
Bun ESM loading and Node native-addon compatibility are separate acceptance
requirements. The TOML native option runs a Rust main; it does not automatically
translate VS Code's JavaScript main or extension hosts into Rust.

Process separation and isolated preload are implemented. The current build
requires an explicit trusted-development opt-in because it has no OS sandbox.
That limitation remains part of migration acceptance, independent of memory use.


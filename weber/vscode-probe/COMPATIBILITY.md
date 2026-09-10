# VS Code migration status

Target: the unmodified Linux x64 VS Code 1.136.2 application at the revision in
`pin.json`, running through the original Electron source modules on Obscura.
The latest probe still exits before workbench startup because `crashReporter` is
missing. A diagnostic exit code of zero means evidence collection succeeded;
the report itself has `ready: false`. No whole-app compatibility percentage is
inferred from exported names or module counts.

The probe records these 24 named imports from the pinned application. An API
appearing in this table does not mean every method works.

| VS Code import | Implemented and exercised scope | Remaining migration work |
| --- | --- | --- |
| BrowserWindow | Original Electron wrapper, two native GTK windows, load/show/hide/size/close | Full window state, parent/modal behavior, platform-specific features |
| webContents | Original wrapper, DOM/Promise evaluation, capture, load lifecycle, renderer IPC | Full frames, navigation, structured clone, DevTools, input/console contracts |
| Menu | Original template policy and actual GTK menus/accelerators | Popup menus, icons, several built-in roles |
| MenuItem | Original ordering, checkbox/radio and click handling | Remaining native menu attributes and roles |
| MessageChannelMain | Original wrapper, bounded main-process channels and ownership transfer | Renderer/utility-process transfers and full clone types |
| Notification | Original module; native D-Bus delivery/update/default click/close and absent-service failure on Node/Bun | Full actions, image-object icons, daemon restart and platform-specific behavior |
| WebContentsView | Original module resolves | Actual view construction and embedding |
| app | Lifecycle and selected Linux paths/platform operations | Switch handling, singleton/CLI relaunch, other app services |
| clipboard | Native CLIPBOARD/PRIMARY, modern ClipboardItem and legacy text/HTML/RTF/binary | Full NativeImage, bookmarks and additional platform formats |
| contentTracing | Missing | Trace collection and lifecycle across runtime processes |
| crashReporter | Missing | Native crash collection, process integration and configuration |
| desktopCapturer | Missing | Authorized desktop/window capture and source selection |
| dialog | Error logging only; no verified native dialog contract | Native file/message dialogs and cancellation |
| globalShortcut | Original module, real X11 registration/conflicts/callbacks | Wayland portals, suspension and keyboard-map changes |
| net | Missing | Main-process network requests and session integration |
| powerMonitor | Original module; native X11 idle queries, UPower/logind power/suspend/resume/lock transport on Node/Bun | Shutdown inhibition, unsupported thermal/platform data, full desktop acceptance |
| powerSaveBlocker | Missing | Native inhibition ownership and release |
| protocol | Original module, custom/file interception, handle/Response, document/CSS/JS/module/fetch loading | Full redirects, HTTP handlers and browser privilege semantics |
| safeStorage | Missing | OS credential-store-backed encryption and availability behavior |
| screen | Original module, native monitors/cursor/work area/scale and change events | Rotation, color profiles, DIP conversion and complete display metadata |
| session | Partition-owned protocol handlers | Persistent cookies/storage, webRequest, permissions, proxy/cache/certificate behavior |
| shell | Missing | Native external URL/file opening, reveal and trash operations |
| systemPreferences | Original Linux module, GTK accent and animation settings | Other operating systems and wider preference integration |
| utilityProcess | Missing | Utility/extension hosts, parentPort, stdio, termination and transferred ports |

The unmodified Electron TypeScript modules remain in the upstream source tree.
The replacement runtime compiles 29 of them and records exact source hashes.
Additional behavior lives at their native binding boundary, with explicit
unsupported errors where implemented entry points cannot perform an operation.

## Standalone editor evidence

The [Monaco probe](../monaco-probe/README.md) executes upstream Monaco 0.52.2
with the same app on Electron and Weber. Weber passes document load, editor
construction, model edits, undo, native X11 keyboard input, rendered line DOM/PNG,
and scrolling to line 700 in a 1,000-line document. The worker-driven diff fails;
Electron passes that check. This standalone Monaco release is not claimed to be
the exact editor revision embedded in the pinned VS Code distribution.

The pinned Obscura Worker implementation evaluates fetched scripts through a
page-realm JavaScript shim and ignores module options. It lacks actual dedicated
worker execution and module-worker semantics. Fixing this boundary is required
for Monaco background services; accepting an editor constructor is insufficient.
Renderer/utility MessagePorts and extension processes are separate unfinished
contracts. Native Notification/powerMonitor checks use actual runtime transport
with controlled D-Bus peers, not a full desktop acceptance suite.

## Acceptance work still required

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

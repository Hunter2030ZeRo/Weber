# Success criterion: the same VS Code application on Weber

The project succeeds when the pinned VS Code application provides the same
user-visible editing, terminal, extension and desktop behavior as its original
Electron distribution, with substantially lower resource use. Export counts,
standalone Monaco construction and a workbench screenshot are not substitutes
for these checks. Internal Chromium implementation details need not be reproduced.

Use the same official application revision in `pin.json`, project contents,
extension versions, settings, theme, fonts, display scale and window geometry.
Retain separate disposable profiles and workspaces for each runtime. Record any
application changes required for porting; do not hide them in the runner.

| Required scenario | What must agree with the original application |
| --- | --- |
| Startup and workspace | Workbench loads, opens the same folder and restores saved window/editor state |
| Editing and persistence | Native typing, selection, undo/redo, save, external file changes and reload preserve expected text and cursor state |
| Input and clipboard | Korean IME composition, shortcuts, copy/paste and drag/drop act on the correct window and document |
| Editor services | Original module workers, diff, search, diagnostics, completion and rename return correct results |
| Terminal | Real PTY shell, input/output, ANSI display, resizing, command exit and process cleanup |
| Extensions | A pinned extension runs in the actual extension host and exchanges messages with the workbench |
| Debugging | Start/stop a debug target, hit a breakpoint and inspect state with the same extension configuration |
| Desktop integration | Menus, dialogs, notifications, window focus/state and multiple independent windows |
| Storage and networking | Profile persistence, session resources, custom schemes, proxy/authentication and credential handling where used |
| Failure and shutdown | Renderer/utility failures are reported, documents recover as supported by VS Code, and owned processes do not survive application exit |
| Packaging | The extracted runtime runs the same application without source-tree paths or a Chromium browser binary |

Visual comparisons should check layout, text, controls and interaction results.
Rasterizer-specific antialiasing differences alone need not fail an otherwise
equivalent UI, but missing controls, clipped text, wrong geometry or broken input
do fail. Keep screenshots and input sequences for review.

Measure resource use only after these functional scenarios run. Compare the
entire process tree, including extension hosts, terminals and language servers.
Record PSS/RSS, peaks, startup, input-to-display latency, representative IPC
payloads and idle CPU over a useful interval (at least 30 seconds). Use repeated
runs and report medians and tail latency. Electron-level responsiveness must
hold beyond a tiny capture fixture; report losses as well as wins. Do not apply
a small-fixture memory ratio to the whole VS Code application.

Node is the first target for the unchanged JavaScript application. Evaluate Bun
separately, including native addons. The Native backend supports a Rust main;
it does not convert VS Code's JavaScript or its extensions into Rust. Process
separation does not satisfy OS sandboxing, which remains required security work.

Current evidence is in `COMPATIBILITY.md`, the startup report, the standalone
Monaco probe and the utility-process tests. Whole-app acceptance remains unpassed.

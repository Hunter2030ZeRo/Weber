# Implementation status — 2026-10-23

Weber is a **Linux x64 / Wayland developer alpha**, SDK/runtime
`0.6.0-alpha.4`. It is past the single-window rendering prototype: ordinary
HTML/CSS/JavaScript/TypeScript apps can be developed, run and packaged, including
the SolidJS Workbench document app. Application authors do not need to write
Rust; Rust owns the native framework host. This is not a production beta,
arbitrary Electron compatibility or a completed desktop shell.

## Available application foundation

| Area | Implemented path | Evidence and limits |
| --- | --- | --- |
| Development | Installed local SDK/runtime, Vite/plain DOM/Solid/React/Vue/TypeScript, HMR, `npm run check/build/start/package` | Installed-SDK and relocation acceptance; packages are local tarballs, not published to npm |
| Web UI | Servo HTML/CSS/DOM and SpiderMonkey JIT, input, scrolling, animation/rAF | Locked selected compatibility profile and app tests; not whole-browser conformance |
| Native windows | Multiple owned windows, title/size, decorations, drag/resize, maximize/fullscreen/minimize, state subscriptions and close decisions | Native compositor tests; Wayland policies apply, no arbitrary positioning/always-on-top or force-restore API |
| Text and IME | Native form controls and basic contenteditable, grapheme selection, plain-text clipboard, bounded undo/redo, Hangul and committed-word Hanja | Actual Fcitx plus OS key injection in isolated Hyprland/GNOME; physical keyboard and full rich editing remain unverified |
| Data and files | App directories, async persistent JSON, UTF-8 portal open/save/cancel | 1 MiB JSON values / 16 MiB area; 256 KiB text files and clipboard; no general binary/streaming file API |
| System | Display/theme snapshots, notifications, cancellable external links, generated desktop launchers | Portal/notification services and compositor policies apply; not broad desktop-service coverage |
| Backend | Optional app-owned Bun process, named calls, subscriptions, cancellation and bounded IPC | Dependency-specific Node compatibility; not Node native-addon or arbitrary npm-package compatibility |
| Errors and distribution | Visible script/startup errors, unsaved-close decisions, relocatable app/private-library bundle | Clean-machine certification, renderer/GPU recovery and installation/update policy remain work |

The [framework integration report](frontend-frameworks.md) records the installed-SDK
and native DOM/Solid/React/Vue scope. The [alpha.3 report](native-editing-alpha3.md) records the native editing/IME
build and verification boundary. The [alpha.1 report](linux-alpha-06.md) records
the earlier app/window/system milestone. Historical tests are not automatically
fresh certification of every later runtime or operating-system image.

## What still blocks a broader Linux beta

Accessibility and assistive technology, renderer/GPU failure recovery, richer
clipboard and binary/large-file contracts, multi-output/fractional-scale/hotplug
acceptance, real keyboard/IME acceptance and startup input races, longer resource
budgets, and supported clean-OS packaging all remain. Some need implementation,
not just additional tests. Tray/global shortcuts and further system APIs need
explicit first-beta use cases and defined failure behavior.

The current [Linux beta checklist](linux-beta-checklist.md) is an acceptance
boundary, not a weighted progress score. A numeric percentage would mix working
APIs, unverified behavior and large missing subsystems and would misstate progress.

## Simulacrum and other platforms

Simulacrum uses **Hyprland** as its compositor. Its ordinary windowed settings/UI
apps can begin against this alpha. Stable public layer-shell hosting, actual
Hyprland IPC integration, panel/launcher/tray behavior and desktop-service
integration remain work. An experimental layer-shell probe is not an integrated
desktop shell; that probe does not yet handle keyboard/IME or multi-output policy.
Hyprland must remain downstream integration rather than a mandatory
dependency of ordinary Weber apps.

Windows and macOS native window/input/rendering/system/package hosts have not
been implemented and validated. They remain framework targets. Static Hermes
is deferred and experimental; the current normal runtime is SpiderMonkey JIT,
with Bun optional for Node-oriented backend code.

## Performance scope

The [input CPU investigation](editing-cpu-analysis.md) separated a substantial
correctness-observer cost from ordinary native editing. That was a measurement
correction, not an engine optimization. CPU, retained memory, startup, input
responsiveness and resource behavior under real app workloads remain active work;
a passing short sample does not establish all-day stability or an Electron/native
toolkit advantage.

The subsequent [native composition optimization](native-editing-range-optimization.md)
is a compiled engine change: an 800-cycle same-app comparison reduced mean input
CPU by about 7.1%, with native editing tests passing. It does not establish lower
initial memory, eliminate input-cost growth or complete the broader beta gates.

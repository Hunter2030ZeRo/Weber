# Linux developer beta acceptance checklist

This is an explicit acceptance boundary, not a completion percentage. A working
happy path, automated native coverage and physical-device evidence are different
levels. No row counts as complete merely because its API exists.

Scope: Linux Wayland, Servo/SpiderMonkey JIT, HTML/CSS/JS/TS apps using standard
Vite/npm workflows. Bun remains optional. Windows/macOS, a downstream desktop
environment and experimental Hermes AOT are separate deliverables.

| Area | Current evidence | Remaining acceptance work |
| --- | --- | --- |
| SDK and build workflow | Local installed SDK/runtime tarballs; Vite/Solid/type checking, HMR, relocation, packaged execution without Node/Bun on PATH | Fresh-machine reproduction and an explicit supported toolchain/dependency matrix |
| Windows | Multi-window ownership, bounds, resize/maximize/fullscreen, coalesced state subscriptions, close decisions | Alpha adds decorations, real pointer drag/resize, minimize and attention; modal/focus behavior on more compositors remains |
| Activation | Native GTK token → initial Weber window; focused-source child token and observed native focus | Forced token timeout, missing-protocol fallback, navigation races and other compositor policies |
| Editing and clipboard | Bounded text SDK clipboard, normal input/textarea Ctrl+C/X/V and external GTK exchange | Contenteditable default editing, richer formats and app-driven browser gaps |
| Persistence and documents | JSON values up to 1 MiB, 16 MiB per area; text files/clipboard up to 256 KiB; portal parent, cancellation and repeated cleanup | Broader file APIs need separate bounded binary/large/streaming design; current caps must stay explicit |
| Platform integration | Alpha system snapshots, cancellable OpenURI, bounded desktop notifications and generated launchers | Tray/global shortcuts, service recovery and APIs selected by real first-beta apps |
| Bun / Node ecosystem | Optional compiled backend, invoke/subscriptions, bounded ownership/cancellation and shutdown | Dependency-specific Node compatibility; runtime/addon boundaries documented with real packages |
| Document and native lifetime | Per-window cleanup; queued opens carry navigation generation; repeated window and abandoned-result tests | Complete navigation/disposal policy and native privilege boundaries across allowed app/document transitions |
| Failure handling | Visible startup/JS errors, bounded queue errors, backend disconnect handling | Renderer/process/GPU failure policy, recovery behavior and actionable crash diagnostics |
| Input and accessibility | Native virtual keyboard/clipboard checks; composition forwarding implemented | Physical Korean IME, focus transitions, accessibility behavior and repeatable user-input acceptance |
| Displays | Alpha enumerates displays, current display, scale, refresh and theme; explicit refresh supported | Mixed-scale output movement, hotplug and compositor-specific input/focus tests |
| Resources and responsiveness | Startup/input/CPU probes, retained-cache fixes and repeated lifetime budgets | Representative app budgets, reliable initial-memory comparison, CPU/QoS policy and longer endurance runs |
| Distribution | Relocatable Linux bundle and deterministic engine/source/library identities | Clean OS/dependency verification and an installation/update support policy appropriate to the beta |
| Browser compatibility | Locked profile and app-specific native tests have historical evidence | Re-run affected profile coverage as engine work changes; publish remaining gaps without presenting a full-browser claim |

The current state is a Linux developer alpha (0.6.0-alpha.2). Performance, IME and QoS are only part
of this list. General platform APIs and recovery are still implementation work,
not merely polishing or adding more tests. Larger-file support and richer
clipboard APIs must not be implied by passing the current bounded text cases.

Before promotion, each first-beta requirement needs a stated supported behavior,
failure behavior and reproducible evidence. Scope decisions still open in this
table must be resolved explicitly; they are not implicitly satisfied or silently
deferred. An installer/update policy does not imply an updater is implemented.
Arbitrary Electron APIs, native addons and full web conformance are not promised.

Alpha scope: [0.6 application/window/system milestone](linux-alpha-06.md).

Evidence and current sequence: [beta plan](beta-plan.md),
[foundation limits](linux-foundation-05.md), [activation](window-activation.md),
[residency investigation](executable-residency.md).

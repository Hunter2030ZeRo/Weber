# Beta delivery plan

Linux developer beta first; Weber remains a general-purpose framework targeting
Linux, Windows and macOS. A downstream desktop environment is an application of
Weber. Its compositor integration must not become a common runtime dependency.

Use the [Linux beta acceptance checklist](linux-beta-checklist.md) to distinguish
implemented paths from remaining implementation and verification. Previous
informal percentage estimates were not derived from a fixed weighted checklist.

## Current priority — 2026-10-20

Prioritize Servo/SpiderMonkey JIT for beta compatibility, platform work and CPU /
startup / memory optimization. Further Static Hermes integration and the
Hermes-only DOM port are deferred at the user's direction. Retain the compiled
experimental path and its evidence, but do not put new AOT work on the beta
critical path. Upstream improvements or a concrete integration opportunity may
justify revisiting it; they do not imply a future measured win automatically.

See [the JIT CPU investigation](jit-cpu-analysis.md) for the active performance
findings and unresolved costs.

## First implementation bundle

1. JIT-only host build with no Hermes runtime/compiler dependency. Retain explicit
   `aot` feature for the existing two-engine native AOT path. Verify both compiled
   hosts and package capability rejection, not just omitted application modules.
2. Window ownership/lifetime: one Servo instance, multiple native windows and
   rendering contexts. Support opening the same app, listing windows, changing
   titles and closing individual windows; last-window shutdown owns the backend.
3. Bun subscription methods with cooperative cancellation, bounded event queues,
   native wakeups and per-window cleanup. Keep the existing invoke contract.
4. Separate layer-shell renderer probe. Bind a fresh Wayland surface to the
   layer role before EGL presentation; verify configure, actual Servo rendering,
   frame callback and DOM/CSS/rAF behavior on a supporting compositor.
5. Repeat optimized AOT/JIT comparisons using an actual Hermes-free JIT host.

These are implementation gates, not claims of a completed beta. Each needs its
own build and native evidence before being marked complete.

## Current foundation increment

Small-DOM scheduling, app paths/persistent JSON stores and a Vite/Solid Notes
template are implemented. See [foundation validation](foundation-validation.md)
for its binary, native tests and performance evidence. The [clipboard](clipboard.md)
now connects the SDK and normal textarea/input shortcuts to Wayland, with a
separate Servo safe-cut extension. SDK 0.4.0 adds [text file selection and
lifecycle APIs](files-and-lifecycle.md). The [Linux preview milestone](linux-preview-milestone.md)
records the 0.4.0 acceptance scope. The [0.5.0 foundation increment](linux-foundation-05.md)
extends document limits, portal parenting and repeated lifecycle validation. Richer clipboard formats, contenteditable,
broader platform APIs and process/renderer recovery remain subsequent work.

## Active resource and Linux usability sequence

The [window resource increment](window-resource-optimization.md) reuses completed
Stylo TLS caches and adds a 1000-window regression budget. This reduces the main
observed growth without adding an application API or changing the JIT choice.
The [font-lifetime increment](font-lifetime-optimization.md) now removes renderer
font caches at last-WebView close and guards against late-request resurrection.
The normal Notes screen showed higher initial PSS in executable mappings despite
lower retained heap growth. The [residency investigation](executable-residency.md)
identified file identity/cache history as a confound: fresh byte-identical copies
removed the discrepancy in four interleaved runs per host. The precise kernel
mechanism remains unisolated, and this is not a general memory-win claim. CPU
repeats disagree; no CPU improvement is established. Keep representative
startup/idle/input gates, physical Korean IME, output scaling and clean-environment
packaging. [Native activation](window-activation.md) now handles startup and
focused-source child tokens; physical input, more compositors, forced timeout
and navigation races remain. Test-helper activation waits alone are not evidence.
These are Linux beta gates; they do not certify a cross-platform beta or a
downstream desktop environment.

## Subsequent beta requirements

The implemented window/resource bundle adds bounded, coalesced app-wide window snapshots,
logical resizing, maximize, borderless fullscreen and resizable controls. It also
measures larger DOMs, multiple windows and repeated close/reopen lifetimes on
both engines, alongside the preceding JIT-only host. See
[the bundle's validation record](platform-validation.md) for what actually ran.

- Rich clipboard formats, contenteditable editing, remaining window controls,
  broader activation/focus coverage and physical keyboard/IME verification.
- General platform event API, renderer navigation/disposal handling, recovery
  policy, dependency-specific Node compatibility and native app trust boundaries.
- A downstream panel/launcher integrated with actual Hyprland sockets; output
  scaling/hotplug, focus and input must be tested there. A KWin layer probe alone
  does not establish Hyprland or desktop-shell support.
- Fresh environment packaging, deterministic dependency/engine identification,
  crash diagnostics and prolonged lifecycle/resource regression tests.
- Windows/macOS JIT build and native window/input/package smoke tests early in
  platform work. Linux developer beta does not mean a cross-platform beta passed.

Full browser conformance, arbitrary Electron compatibility, arbitrary native
addons and a complete desktop environment are not the first beta's scope.
Retain the locked browser profile; fix app-driven gaps without silently widening
or weakening that profile.

## AOT product gate

AOT is optional and experimental until measured startup AND memory advantages
are demonstrated. Do not promote it based on its compilation model or one small
JS benchmark. Preserve the JIT path independently.

Use the same source, equivalent app/assets, viewport, optimization level and
backend choice. Compare the Hermes-enabled AOT host against the JIT-only host;
also retain same-binary comparisons when diagnosing engine overhead. Include:

- Parent pre-spawn to first native app presentation (including process/loader
  startup), separately from the existing Rust-main measurement.
- Process-tree PSS, RSS and private memory, including Bun when enabled. Record
  startup/settled memory and external GPU-memory limitations explicitly.
- Idle CPU, responsiveness and long-lived resource growth on representative
  small apps and a downstream panel/launcher workload.

The initial automated screen requires at least 5% improvement in BOTH median
spawn-to-first-present time and settled process-tree PSS, using alternating
repeated launches. This is a provisional workload screen, not statistical proof
or a universal promotion rule. Report distributions and repeat improvements;
responsiveness or stability regressions block promotion even if the two medians
improve. The current two-engine DOM adapter remains an unresolved cost. Further
Hermes-only DOM/ownership integration is deferred; apply this gate if that work
is resumed rather than claiming that it is already implemented.

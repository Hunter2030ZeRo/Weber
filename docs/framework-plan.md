# Framework execution plan

Historical scope below. As of 2026-10-20, JIT beta and performance take priority;
further Hermes-only integration is deferred. See [the current beta plan](beta-plan.md).

Authorized scope: native Servo CSSOM bindings for Hermes AOT, less duplicate DOM
state and serialization, followed by a reusable application build/run interface.
Wayland remains the supported native window backend. App and shell logic remain
Static Hermes native AOT; Servo's existing SpiderMonkey adapter is explicit.

1. Preserve the measured release as a baseline. Add a scoped native inline-style
   binding; delegate CSS parsing/normalization to Servo. Keep local CSS fallback
   lazy and explicit for standalone tests without a real DOM. Verify detached
   nodes, Attr identity, MutationObserver oldValue/counts, invalid values,
   priority, CSS text, indexing and aliases against native Servo behavior.
2. Remove independently maintained low-level tree links when the browser facade
   already owns topology. Keep weak wrapper ownership and native handle release.
   Remove redundant JSON conversions; preserve boundary validation and scope
   lifetime. Record remaining wire serialization instead of claiming zero-copy.
3. Expose a versioned SDK/build manifest and reusable entry point. Verify two
   different user apps through the same AOT host, with embedded assets and a
   relocated package. Do not present a hardcoded demo launcher as a framework.
4. Build and run standalone contracts, fixed WPT profile, native renderer/ownership
   scenarios and fresh benchmarks. Preserve earlier measurements under their
   original build hash. Distinguish real OS input, programmatic DOM tests and
   standalone runtime checks. Report incomplete compatibility and engine removal.

This starts a general framework foundation. Full browser conformance, Bun/Node
APIs, Windows/macOS packaging, elimination of SpiderMonkey and a performance win
are separate results requiring their own implementation and evidence.

# Approved standalone AOT milestone

Approved scope: all application/shell UI in native Static Hermes AOT; runnable
without Vite or build-tree paths; native Wayland input including Hangul IME;
repeated mutation/mount/dispose ownership and memory checks; identical-app
SpiderMonkey comparison of memory, startup, input-to-paint and frame times.

## Execution

1. Use a shared Solid TSX desktop component in two builds. The default native
   entry mounts the complete shell/app through Hermes. The comparison entry runs
   that exact component in SpiderMonkey without initializing a Hermes heap.
   Servo retains SpiderMonkey for the generic DOM adapter in AOT mode.
2. Embed the bootstrap/assets or resolve them relative to the packaged binary.
   Package required private libraries with relative loader paths and license
   notices. Verify a relocated copy with a different working directory and no
   developer server. State the supported Linux system-library/driver baseline.
3. Replace strong mirror-node registration with weak ownership and explicit
   collection/release to the renderer. Retained detached nodes remain reusable;
   unreachable nodes/listener cycles must release native handles. Test both
   repeated mutation within one document and repeated mount/dispose sessions.
4. Validate the actual compositor-to-winit-to-Servo-to-AOT input route. Separate
   OS input injection from direct DOM events and human physical input. If the
   session requires interactive access, finish the reviewable app/tests first.
5. Collect equivalent optimized-build samples: complete process-tree RSS/PSS,
   process-to-present startup, input-to-present latency, and native presentation
   intervals. Separate cold-process starts from true cold filesystem-cache
   starts. Report sample counts, distributions, hardware, toolchain and workload.
   Do not assume a performance win from two engines.

## Completion evidence

- Relocated packaged AOT and SpiderMonkey modes launch and render the same UI.
- Full fixed compatibility profile remains passing.
- Native input/editing/focus/scroll and real IME behavior have explicit evidence.
- Retained detached-node behavior and unreachable-object cleanup pass; sustained
  mutation/remount reports show handle counts and memory over time.
- Comparable timing/memory report exists with reproducible commands and limits.

This milestone is implementation and measurement, not elimination of
SpiderMonkey, full browser conformance, cross-platform packaging, or a numerical
performance promise before measurements exist.

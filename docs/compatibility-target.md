# Fixed compatibility target: weber-ui-2025-01-v1

This is a bounded desktop UI profile using the API/test snapshot immediately before
2025-01-01 UTC. It is **not** a claim to implement every browser feature available
on that date. `compatibility/profile.json` fixes the required tests, their original
bytes, and the additional application scenarios. `profile.sha256` locks that file.
Do not remove a failing test, change its assertions, or mark an unexecuted case as
passing. A changed target needs a new profile version and a separate report.

## Required behavior

- All subtests of the 17 selected WPT files at revision
  `58c1148991566b4b3454edac0f9a8e11010e20b2`, on both actual Servo and native
  Static Hermes AOT. Original harness and tests are hash verified. No skips,
  harness errors, missing results, or pending async tests count as a pass.
- The existing 30 DOM, 7 Solid, 9 scheduler and low-level lifetime cases.
- Actual Wayland Solid UI: click, input, scroll, animation, timers, disposal and
  remount. Automated DOM input is distinguished from physical device input.
- Mouse/keyboard/input event fields and constructors; abort signals and listener
  cleanup; namespaced attributes and dataset.
- Real Servo computed style and client rectangles, viewport/scroll coordinates,
  focus/activeElement, and ResizeObserver delivery/disconnect/disposal. Values
  must come from the live renderer, not a guessed mirror layout.
- Compiled AOT application fetch: string URL GET/JSON, POST/text, status/headers,
  abort and network failure. Streaming bodies and full Request/Response/Blob
  surface are outside this profile.
- Build, strict TypeScript, lint and formatting pass; a fresh report identifies
  the exact profile hash and source revisions. Every required scenario has
  explicit evidence. A missing scenario fails the gate.

The Solid 1.9.9 application is an additional integration workload; its version
does not redefine the dated WPT baseline.

## Execution boundary

Servo retains its SpiderMonkey script engine. Static Hermes compiles application,
shell and DOM facade code into native objects; the owned DOM bridge synchronizes
with the real Servo tree. This experimental two-engine bridge is not a completed
replacement of Servo's WebIDL/SpiderMonkey implementation.

The native WPT runner initializes the original harness in its supported **shell**
environment, then installs the DOM facade and parsed HTML fixtures. Original test
scripts are separate native AOT units, preserving their script boundaries. HTML
reporting scripts are replaced by result callbacks; assertions are not replaced.
The Servo reference runs the original harness in its window environment. This is
a selected conformance workload, not an official complete WPT run.

## Outside this version

Full WebIDL, cross-document application adoption/iframes, Shadow DOM, workers,
service workers, media/WebGPU, runtime eval/string timers, Node/Bun compatibility,
production packaging and cross-platform support are outside this Wayland profile.
Mixed SpiderMonkey/Hermes listener ordering, trusted physical input, and unified
cross-engine garbage collection are not promised. Session disposal and stale
callback rejection remain required despite that GC limitation.

Performance measurements must state workload, memory metric and hardware; this
compatibility gate alone does not establish the memory/latency product goals.

# Browser scheduling for native AOT — 2026-10-19

Static Hermes AOT now exposes function-based setTimeout/setInterval, their cancel
methods, requestAnimationFrame/cancelAnimationFrame and a minimal performance
clock. The shared Solid TSX application uses these APIs for actual native-window
animation and timed state changes. Servo schedules the callbacks; Hermes executes
the compiled application functions. SpiderMonkey still owns Servo's DOM and the
browser event loop. No source evaluation is introduced inside Hermes.

## Scheduling and ownership

`aot/browser-scheduler.js` stores compiled callbacks and arguments by a monotonic
numeric handle plus document session. Typed schedule/cancel commands travel with
DOM updates. On the Servo script thread, `src/dom_adapter.js` creates real browser
timeouts, intervals and animation-frame requests and associates them with those
handles. A browser callback invokes the existing synchronous host extension with
the session, handle and frame timestamp. The main thread invokes the matching
Hermes function and returns its DOM changes.

Timeout callbacks receive the original arguments and use the Hermes window/global
as this. Timeout and interval cancellation share an ID space; animation requests
have a distinct cancellation operation. Completed one-shot callbacks release
their registry entries. Intervals can cancel themselves. Stale or canceled
deliveries are ignored. Callback exceptions are recorded in the owning document's
listenerErrors array so that subsequent scheduled callbacks can continue.

Reset/dispose clears both the Hermes callback registry and Servo's real scheduled
work. Solid onCleanup cancels its own timers and current animation request before
unmount. Handles are not reused across document resets. The native adapter checks
session and handle validity before each delivery, including callbacks queued
before cancellation. This prevents disposed callbacks from mutating either a
retained old subtree or a fresh document session.

`performance.now()` uses a C++ steady_clock host function and a document-clock
sample supplied by Servo at each host call. `timeOrigin` comes from Servo's real
document. Frame callbacks receive Servo's actual rAF timestamp. This associates
the two clocks; it does not eliminate bridge latency or provide a clock-accuracy,
frame-rate, startup or memory guarantee. Timer delay/clamping and rendering
opportunities are managed by Servo's browser scheduler.

## Event microtasks

Previously, every synchronous host call drained the Hermes microtask queue while
still inside the native capture listener. AOT Promise/observer/queueMicrotask work
could therefore run before that listener returned its cancellation decision.

Event calls now flush synchronous DOM writes and decisions without draining
Hermes microtasks. The adapter queues one epoch-guarded Servo microtask, which
requests a separate Hermes checkpoint and applies the resulting writes. Timer,
frame and mount calls retain their normal Hermes checkpoints. Native event
cancellation remains synchronous.

The programmatic-event test observes a native bubble listener and the return from
click(): both see the synchronous handler state. After the real browser checkpoint,
the queued Hermes callback's DOM change is visible. Checkpoint timing is delegated
to Servo; this is not a guarantee that physical-event microtasks always follow an
entire dispatch. Interleaving of SpiderMonkey observers/listeners and Hermes
observers/listeners is still not equivalent to one unified browser realm.

## Servo time-origin correction

The first rendered result exposed another pinned-Servo compatibility issue:
Performance.TimeOrigin subtracted CrossProcessInstant::epoch(), whose value is
the platform monotonic zero. On this Linux run that exposed system uptime, not
an estimate relative to the Unix epoch. Copying that value into Hermes only made
the two realms agree; it did not make the original value standard-compatible.

`patches/servo-time-origin.patch` replaces that getter's origin conversion with a
single process-wide wall-clock/monotonic anchor. All contexts in this process use
the same anchor, and later wall-clock changes do not recalculate it. Internal
monotonic navigation/frame timing is unchanged. The existing duration conversion
still coarsens relative values. Bootstrap checks/applies this third local patch.

The actual Servo test now checks that timeOrigin + now is close to Date.now under
the test's stable wall clock and that Hermes receives the same Unix-scale origin.
The one-second sanity tolerance is not an accuracy or latency claim. Clock-change
injection, cross-process/suspend behavior and full High Resolution Time WPT are
not validated by this local patch.

## Evidence

| Check | Result |
|---|---|
| Cargo build with compiled Hermes scheduler and Solid component | Pass |
| Native AOT scheduling contracts, controlled task delivery | Nine cases, pass |
| Existing native DOM / Solid suites | 30 / seven cases, pass |
| Actual Wayland, DISPLAY unset: real timeout and repeating interval | Pass |
| Timer arguments/window receiver and interval self-cancellation | Pass |
| Actual rAF-driven Solid style updates; pause/resume | Pass |
| Frame timestamp and document timeOrigin | Pass |
| Patched Servo exposes Unix timeOrigin and passes it to Hermes | Pass |
| Event microtask ordering at actual Servo checkpoint | Pass |
| Dispose cancels pending work; remount starts fresh timers/frames | Pass |
| Previous DOM ownership/session and browser contract runs | Pass |
| TypeScript/Vite, host Clippy, Rust formatting | Pass |

The native scheduling suite tests cancellation, stale sessions, exceptions,
arguments, receiver binding, timestamp delivery and Promise/queueMicrotask behavior
using controlled callback deliveries. It does not prove wall-clock scheduling.
The separate Wayland test uses Servo's real timers and compositor frame callbacks.
Input events are programmatically generated, not physical device input. This is
project-owned coverage, not WPT or a performance benchmark.

Results: [scheduling AOT cases](../artifacts/scheduler-native.json),
[existing native DOM cases](../artifacts/scheduler-dom-native.json),
[existing native Solid cases](../artifacts/scheduler-solid-native.json),
[Wayland Solid scheduling result](../artifacts/solid-aot.json),
[native rendering](../artifacts/solid-aot.png).
Logs: `artifacts/scheduler-build.log`, `scheduler-clippy.log`,
`solid-aot-native.log`, `browser-dom-native.log` and `dom-binding-native.log`.

```sh
cargo build --locked
pnpm --dir app run build
target/debug/weber-servo --scheduler-self-test
target/debug/weber-servo --browser-contract-self-test
target/debug/weber-servo --solid-self-test
WEBER_SOLID_TEST=1 node scripts/wayland-smoke.mjs
WEBER_BROWSER_TEST=1 node scripts/wayland-smoke.mjs
WEBER_DOM_TEST=1 node scripts/wayland-smoke.mjs
```

## Limits

String timer handlers are deliberately rejected: this native AOT path accepts
compiled functions and does not implement browser runtime string compilation.
This differs from the complete HTML timer API. Only performance.now/timeOrigin
are implemented; PerformanceEntry, document.timeline and the other Performance
APIs are absent. Worker scheduling, complete Promise rejection events and browser
error-event reporting are not implemented.

Full HTML/Web IDL, layout reads/getComputedStyle, Shadow DOM, arbitrary external
DOM synchronization, cross-engine reachability GC, broad networking APIs and the
complete AOT desktop shell remain separate work. The outer demonstration UI/test
driver still runs in SpiderMonkey. The shared Solid application, timers, animation
and its event logic run as Hermes native AOT.

Sources: [HTML timers and microtasks](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers),
[animation frames](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames),
[High Resolution Time](https://www.w3.org/TR/hr-time-3/#dom-performance-timeorigin),
[Solid lifecycle implementation](https://github.com/solidjs/solid/blob/main/packages/solid/src/reactive/signal.ts).

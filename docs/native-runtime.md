# Native runtime foundation

The first beta foundation separates the default JIT host from the optional AOT
build, adds native window lifetime management, and adds Bun event subscriptions.
These APIs are experimental and Linux Wayland validated first.

## Host choices

```sh
# Default: Servo / SpiderMonkey. Does not compile/link Hermes or Weber's Hermes CXX bridge.
CARGO_TARGET_DIR=target/optimized cargo build --release --locked
# Existing Static Hermes native AOT plus SpiderMonkey comparison path.
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --features aot
# Optional separate layer-shell rendering probe (can combine with aot).
CARGO_TARGET_DIR=target/optimized cargo build --release --locked --features layer-shell
```

`--build-info` reports `aotAvailable`, `windowProtocol` and `layerShellProbe`.
The JIT-only host rejects native-unit manifests rather than silently treating
failed AOT loading as a JIT fallback. Build a JIT application for that host.
The `aot` host still uses the existing SpiderMonkey DOM adapter; this is not a
Hermes-only DOM port.

The latest window-protocol-2 hosts are `target/package/weber-platform-jit/weber`
and `target/package/weber-platform-aot/weber`. The preceding foundation hosts
remain at `target/package/weber-beta-{jit,aot}/weber`. The SDK selects the appropriate prepared
host for packaging/running a native-unit application. `WEBER_HOST` overrides
selection; an incompatible host fails explicitly. Bootstrap defaults to JIT;
`bash scripts/bootstrap.sh --aot` also prepares the optional AOT toolchain.

## Windows

```ts
import { currentWindow, listWindows, openWindow, closeWindow,
         setWindowTitle, resizeWindow, setWindowMaximized,
         setWindowFullscreen, setWindowResizable, onWindowsChanged } from '@weber/sdk/window';
const current = currentWindow();
const second = await openWindow({ title: 'Inspector', width: 640, height: 480 });
setWindowTitle('Inspector ready', second.id);
resizeWindow(800, 600, second.id);
const stop = onWindowsChanged(({ windows }) => {
  console.log(windows); // initial + changed app-wide snapshots
});
setWindowMaximized(true, second.id);
setWindowFullscreen(false, second.id); // borderless native window fullscreen
setWindowResizable(true, second.id);
stop(); // component cleanup
closeWindow(second.id);
```

Each new window runs the same application entry in its own UI realm. Branch on
`currentWindow().id` if only the primary window should open other windows. A
single Servo instance owns separate WebViews/rendering contexts; the application
owns one optional shared Bun backend. Backend module state is therefore shared
by its windows, while component/DOM state is per window.

Opening resolves when the native window is created, not when its first frame is
presented. Dimensions passed to open are logical pixels; reported width/height
are physical pixels with a separate scaleFactor. `resizeWindow` also takes logical
pixels. Mutators enqueue a request; the compositor can constrain/deny it. They
do not promise a completed size or displayed frame. Observe actual width/height
and scale in snapshots and the DOM viewport. Maximize/fullscreen flags are the
native window implementation's reported state, not optical presentation evidence.
Fullscreen is borderless window fullscreen, separate from browser element fullscreen.

`onWindowsChanged` receives an initial snapshot, then only changed state: window
membership, title, dimensions, scale, focus, maximize/fullscreen and resizable.
Snapshots have increasing process-session revisions and frozen records/arrays.
At most 64 SDK listeners share one native watch in each UI realm. One evaluation
per watching window may be in flight; intermediate states are coalesced into the
latest snapshot. This is not a durable event history, close veto, or delivery of
every intermediate resize. No idle timer polls window state. Unsubscribe removes
the native watch when the last listener leaves; close/navigation detach it.
Callbacks run on the UI thread; exceptions are logged independently. Re-subscribing
uses a new generation so stale deliveries/acknowledgements cannot affect it.

Wayland positioning, activation, minimize restoration/state, close vetoes and
arbitrary window URLs are not exposed by this API. Actual desktop physical
keyboard/IME and scaled/multiple-output validation remain separate requirements.

Requests are bounded/deferred until the script callback returns. At most 16
windows and 64 queued commands are accepted; dimensions are 64..8192 logical
pixels. IDs are process-session IDs, not OS window handles. Closing one window
keeps other windows running. Closing the last exits the app and reaps its backend.
A per-launch native capability is injected into packaged/development HTML;
missing/invalid capabilities are rejected. This is trusted native application
code, not an untrusted-web-page sandbox.

## Memory after window teardown

On Linux/glibc the host lazily starts a single housekeeping worker after the
first non-final window close. Close bursts are coalesced (one pending signal),
then `malloc_trim(0)` returns already-free allocator pages after 750ms quiet or
at most 2s of continued close requests. It does not force JavaScript collection,
destroy live DOMs or disable graphics/font caches. No worker/timer is created
for the initial single-window application. Teardown cancels pending work and
joins the worker. Telemetry records release attempts and duration.

`WEBER_RECLAIM=0` disables this policy for controlled comparisons. Other platform
targets currently use a no-op policy; they need their own resource validation.
Moving work off the UI thread does not eliminate allocator-lock contention, so
the validation record includes window-creation timing and worker duration, not
a claim that all input latency or frame-time effects have been measured.

## Bun event subscriptions

A backend method receives `{ signal, emit }`:

```js
import { setTimeout as delay } from 'node:timers/promises';
export default {
  async watch(_, { signal, emit }) {
    while (!signal.aborted) {
      await emit({ time: Date.now() });
      try { await delay(1000, null, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }
};
```

```ts
import { subscribe } from '@weber/sdk/backend';
const stop = subscribe<{time:number}>('watch', null, event => {
  console.log(event.time);
}, { onError: console.error, onEnd: () => console.log('Finished') });
// On component disposal:
stop();
```

`subscribe` starts a named method and returns an unsubscribe function. Returning
from the backend method ends the subscription; throwing calls onError. Await
emit to respect pipe backpressure. Backend results/events remain JSON values.
Callbacks run in the subscribing UI realm; callback exceptions are reported to
console without stopping unrelated listeners.

Only one event per window is in flight until its JavaScript evaluation finishes;
slow UI callbacks therefore do not move an unbounded backlog into Servo's script
queue. Backend messages wake the native event loop and are delivered to the owning
window. Subscriptions have no periodic result polling timer. Existing invoke
calls still use their bounded pending-call poll; this change does not remove
all polling or IPC/copies. AOT event callbacks run through the existing scoped
DOM adapter and its checkpoint/flush path.

At most 64 subscriptions and 128 combined calls/subscriptions are active.
Individual event packets are limited to 32KiB; the native event queue has a
128-packet / 2MiB normal limit, with up to 64 bounded terminal notices
reserved for cancellation/failure. Subscription slots remain occupied until the
terminal event is acknowledged, so rapidly completed methods cannot create an
unbounded delivery backlog. Overflow ends the affected subscription with
BackendOverflowError, discards its queued values and requests cancellation.
A burst may therefore lose values on explicit overflow; it is not a durable
message queue. The runner also bounds queued stdout bytes to 2MiB. Console output
still belongs on stderr; libraries writing stdout directly need adaptation.

Unsubscribe, window close and navigation request cooperative cancellation and
remove native routing for the old window work. Backend code must observe its
signal and release resources in finally. Synchronous unyielding code cannot be
cooperatively interrupted. Backend failure reaches active subscribers; there is
no automatic replay/restart. Native application shutdown still owns termination.

Create the complete example with `node sdk/cli.mjs init /tmp/windows-app windows`,
then install dependencies and use the standard npm commands.

## Layer-shell probe

With the layer-shell feature, `weber --layer-probe file:///absolute/panel.html`
creates a fresh top-layer Wayland surface anchored top/left/right with a 48px
exclusive zone. Servo renders directly into that surface via its real
WindowRenderingContext. The probe expects a 48px-tall app to set its title to
`weber-layer-pass`; it verifies a frame callback and saves a Servo screenshot.
This is a bounded rendering test, not a published panel/window SDK API.

The probe has a 20-second completion deadline and supports no keyboard/IME,
output scaling/hotplug policy, AOT, backend/window APIs or Hyprland IPC. A regular
winit xdg window is not re-roled into a layer surface. Follow-up production work
must integrate input, output and lifetime policies explicitly.

See [window and resource milestone validation](platform-validation.md),
[beta plan and AOT performance gate](beta-plan.md),
[Bun backend](bun-backend.md) and [milestone validation](beta-foundation-validation.md).

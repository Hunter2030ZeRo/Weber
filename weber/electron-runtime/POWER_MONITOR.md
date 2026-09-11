# Linux shutdown delay

The original Electron `power-monitor.ts` wrapper now forwards shutdown listener
registration to the native GTK host. Its first-listener correction is identified
in `dist/source-manifest.json`. CommonJS and Node ESM loaders are unchanged.

## Ownership and event delivery

The host watches `org.freedesktop.login1` on the system bus. With at least one
shutdown listener it asynchronously calls `Inhibit("shutdown", who, why, "delay")`
on that daemon's unique owner, consumes the returned Unix-FD list, validates its
handle, and retains a close-on-exec descriptor. This is separate from the
session-bus cookie contracts implemented by `powerSaveBlocker`.

`PrepareForShutdown(true)` begins a generation-bound lifecycle only when a delay
descriptor is owned. The host emits the shutdown event without waiting on GTK.
The JavaScript binding dispatches synchronous listeners, then returns their
`preventDefault()` decision over the production platform channel. An ordinary
decision releases the descriptor; a prevented decision retains it until exit,
cycle cancellation, service loss or the deadline. A final `once` listener is
removed before its callback runs, so native disable preserves an already
preparing lifecycle until its decision is known.

Duplicate decisions and decisions from expired generations cannot release a
new lease. Removing the last listener outside a shutdown cycle cancels pending
acquisition and closes an owned descriptor. All stale asynchronous completions
consume and close any returned descriptors, including after host destruction.
Loss/replacement of the daemon invalidates ownership; observation is reacquired
when the service returns and listeners still exist.

## Explicit limits

- This is a temporary delay, not an indefinite veto of system shutdown.
  logind applies its configured deadline. Weber also releases after at most five
  seconds from notification, including when JavaScript supplies no decision.
- Acquisition is best effort, matching the desktop service contract. Missing
  service, denial and malformed replies emit a nonfatal warning with code
  `WEBER_SHUTDOWN_INHIBITOR_UNAVAILABLE`; they do not abort application startup
  or pretend that an inhibitor was obtained. `app` emits
  `weber-power-monitor-status` with `active`, `generation` and an optional reason.
- A closed system bus releases ownership and reports inactivity. Reconnecting
  after the entire system bus restarts is not implemented. Daemon replacement
  on a live bus is handled without periodic polling.
- `preventDefault()` is synchronous. Calling it after listener dispatch cannot
  change the already-consumed decision.
- Tests use controlled logind peers over real D-Bus with real Unix descriptors.
  They do not shut down a physical desktop or verify other operating systems.

## Regression checks

`test-power-monitor.cjs` executes the compiled original wrapper and binding on
Node and Bun. `tests/shutdown-service.py` exercises the original API and actual
native platform channel with a private logind peer. The fast host excludes the
renderer engine; the full-runtime variant runs through the normal bootstrap.
The runtime workflow requires both layers as well as the original-layout VS
Code diagnostic. Completing a diagnostic is not a workbench acceptance pass.

References: [systemd inhibitor locks](https://systemd.io/INHIBITOR_LOCKS/),
[GIO asynchronous Unix-FD calls](https://docs.gtk.org/gio/method.DBusConnection.call_with_unix_fd_list.html).

# Original powerSaveBlocker on Linux

The unchanged Electron `lib/browser/api/power-save-blocker.ts` is compiled and
resolved through `electron_browser_power_save_blocker`. Its `start(type)`,
`stop(id)` and `isStarted(id)` use the native GTK host's private synchronous
transport. No Chromium wake-lock service or renderer dependency is introduced.

Requests retain distinct monotonically increasing IDs. Display-sleep prevention
takes precedence over app-suspension prevention. Up to 128 live requests are
supported; only changes of effective strength send native commands. Queries,
duplicate-strength starts and non-final stops do not send IPC or create timers.

The host follows Electron/Chromium's Linux desktop D-Bus selection:

| Path | Acquisition | Release |
| --- | --- | --- |
| GNOME first | `org.gnome.SessionManager.Inhibit(app, 0, reason, flags)`; flags 4 for suspension, 8 for display sleep | `Uninhibit(cookie)` |
| Suspension fallback | `org.freedesktop.PowerManagement.Inhibit.Inhibit(app, reason)` | `UnInhibit(cookie)` |
| Display fallback | `org.freedesktop.ScreenSaver.Inhibit(app, reason)` | `UnInhibit(cookie)` |

Each native lease uses a dedicated session-bus connection. A replacement is
acquired before the old lease is released. Failed upgrades or downgrades leave
the preceding lease and JavaScript IDs intact. Timed-out candidates close their
own connections, including when the service accepts an inhibitor but replies late.
Release addresses the issuing daemon's unique name, avoiding cookie reuse by a
new daemon. Quit, private-transport EOF and host death release ownership. Service
owner loss or connection closure invalidates the IDs and emits an app
`weber-error` with `ERR_WEBER_INHIBITOR_LOST`. A later explicit start may retry.

Acquisition has a two-second cancellation deadline, including D-Bus connection
authentication, and individual method calls are capped at 750 ms. Release waits
at most 250 ms before closing the dedicated connection. The cancellation waiter
exists only during a strength transition and is joined before returning; there
is no continuing inhibition polling or periodic synthetic input.

## Compatibility limits

- The application receives an exception when no supported service acknowledges
  inhibition. Electron's asynchronous native implementation can return an ID
  before the OS grants the request. Weber does not claim an ungranted request is
  active. Desktop policy and user-initiated sleep remain authoritative.
- This is desktop D-Bus inhibition, not logind shutdown inhibition. No activity
  pulses, X11 global timeout changes, raw XScreenSaver suspension, Wayland portal
  integration, macOS or Windows implementation is supplied by this boundary.
- Integer IDs are validated as signed 32-bit values. Invalid types/fractions are
  rejected instead of attempting Electron converter coercions.
- ID allocation and class exports alone do not establish VS Code compatibility.
  The original application is rerun separately after integration.

## Validation

`test-power-save.cjs` loads the original module on Node/Bun and tests aggregation,
failure rollback, re-entrancy, generation-aware loss, quit and bounds.
`weber/tests/power-save-service.py` runs the actual Weber host with controlled
desktop services over a private D-Bus session. It checks GNOME and freedesktop
calls, exact transition order, denials, missing services, daemon loss, delayed
replies, app SIGKILL and host SIGKILL. These are native protocol and lifecycle
checks. CI does **not** physically suspend a machine or verify a real desktop's
display-power policy.

Sources: [original Electron implementation](https://github.com/Hunter2030ZeRo/Weber/blob/c1aad3df47dcae19bad6d12157c7f06ad72ea409/shell/browser/api/electron_api_power_save_blocker.cc),
[Chromium Linux desktop protocol mapping](https://github.com/chromium/chromium/blob/main/services/device/wake_lock/power_save_blocker/power_save_blocker_linux.cc).

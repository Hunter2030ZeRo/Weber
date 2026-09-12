# Linux native fullscreen state

The native binding implements `isFullScreen()` and `setFullScreen(boolean)`
for the original Electron BaseWindow/BrowserWindow wrappers, including their
`fullScreen` property. The `fullscreen` constructor option is forwarded to GTK,
including when the window is initially hidden.

The setter enqueues `gtk_window_fullscreen` or `gtk_window_unfullscreen`.
It does not optimistically update the query value: GTK's `window-state-event`
confirms the actual state. The binding stores that state before emitting
`enter-full-screen` or `leave-full-screen`, and suppresses duplicate transitions.
Changes made by the window manager take the same path. Each window has its own
state; queries and setters reject destroyed windows. Invalid non-boolean
arguments fail before sending a native request.

Applications should wait for the transition event before depending on the new
state. An immediate query can still return the previous state while the native
event is in transit. A missing or refusing window manager does not produce a
fabricated successful transition. Native command errors use the existing
asynchronous `weber-error` channel.

The full-runtime fixture uses Openbox inside Xvfb on Node and Bun. It checks
actual GDK state, screen-sized content, restored content dimensions, native
title-bar visibility, event ordering, duplicate requests, external `wmctrl`
changes, hidden creation, independent windows and destruction in fullscreen.
Run it with `xvfb-run -a -s '-screen 0 1024x768x24' bash
weber/tests/fullscreen-runtime.sh node` (or `bun`) after building the host.

This scope does not implement HTML element fullscreen, kiosk policy,
`setFullScreenable`, macOS simple fullscreen, or acceptance on Wayland and
other desktop window managers. Workbench readiness is established only by the
separate VS Code acceptance criteria.

Reference: [Electron BaseWindow](https://www.electronjs.org/docs/latest/api/base-window#winsetfullscreenflag).

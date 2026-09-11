# Linux native title-bar overlay

`BrowserWindow` and `BaseWindow` creation now forward `frame`, `titleBarStyle`
and `titleBarOverlay` to the GTK host. On Linux, `titleBarStyle: 'hidden'`
removes native decorations; an enabled overlay places GTK window controls at
the top right of the content surface without reducing the renderer allocation.
The original Electron source wrappers are unchanged by this implementation.

`setTitleBarOverlay({ color, symbolColor, height })` updates native controls.
Omitted values retain their previous settings. GTK parses colors before an
update is applied, and invalid native updates preserve the previous appearance.
JavaScript validates argument types and bounds before enqueueing a command.
As with other current Weber window setters, the native operation is queued;
native validation failures are reported through `weber-error`, not thrown
synchronously by the original setter.

Controls have real GTK buttons with accessible names. Minimize and maximize/
restore send native window-manager requests; close goes through the normal
Electron close-request event, including cancellation. Controls consume their
input instead of passing clicks to the web page, hide in fullscreen, and update
their restore icon when the window-manager state changes. Each window owns its
widgets and style providers; updates and destruction are independent.

## Scope

- `default` and `hidden` title-bar styles are supported on Linux. Overlay is
  opt-in at creation. Updating a non-overlay or destroyed window is rejected.
- Height is bounded to 0–512 logical pixels; 0 restores the 32-pixel default.
  Each button is 46 logical pixels wide. System layout preferences, customized
  control ordering and per-monitor DPI transitions are not implemented.
- Colors use GTK's accepted CSS color forms. Without an explicit symbol color,
  black or white is selected using relative luminance contrast.
- These are native controls over the content surface. Browser-side
  `navigator.windowControlsOverlay`, geometry-change events and CSS
  `env(titlebar-area-*)` integration remain unimplemented. Do not interpret
  this native API milestone as complete Window Controls Overlay support.
- Full-window dragging/resizing for frameless windows and the interaction with
  custom web drag regions remain separate work. Minimize/maximize policy still
  depends on the running window manager. Xvfb tests do not establish full
  desktop-window-manager acceptance.

## Checks

`test-titlebar-options.cjs` checks creation and update arguments on Node and Bun.
`tests/titlebar-overlay.cc` checks actual GTK pixels, partial updates, atomic
rejection, content allocation, native button callbacks and repeated teardown.
`titlebar-fixture` runs the original BrowserWindow through the complete runtime,
checks independent window state, and uses real X11 input to close the window,
cancel that close once and verify that the click did not reach the page.

See the [Electron API contract](https://www.electronjs.org/docs/latest/api/base-window#winsettitlebaroverlayoptions-windows-linux).

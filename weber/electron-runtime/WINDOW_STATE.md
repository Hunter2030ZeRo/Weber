# Native Linux window state

The original BaseWindow/BrowserWindow bindings expose `isMaximized`,
`isMinimized`, `maximize`, `unmaximize`, `minimize` and `restore` through GTK.
Queries reflect the most recently received native window-state event; issuing
a command does not fabricate a completed transition. Both cached state fields
are updated before the corresponding maximize/unmaximize/minimize/restore
events are delivered, and unchanged states do not emit duplicate events.

The same path receives external window-manager changes and native title-bar
button actions. Maximize and minimize can show an initially hidden window.
Restore requests deiconification and removal of maximization. Queries and
commands reject destroyed windows; native command failures use `weber-error`.

The Openbox/Xvfb full-runtime fixture on Node and Bun checks GDK state, actual
content geometry, restoration, duplicate requests, external maximization,
actual native maximize/minimize button clicks, hidden-window maximization,
independent windows and destruction. Fullscreen remains a separate state;
Linux simple-fullscreen aliases are documented in [FULLSCREEN.md](FULLSCREEN.md).

These checks do not establish behavior across other window managers, Wayland,
per-monitor scaling, or complete VS Code workbench compatibility. Window-manager
policy can reject native requests. Existing focus, always-on-top, resizable and
other unsupported window contracts are outside this change.

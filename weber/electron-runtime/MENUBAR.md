# Linux menu-bar visibility

The original BaseWindow/BrowserWindow wrappers expose `setMenuBarVisibility`,
`isMenuBarVisible`, `setAutoHideMenuBar`, `isMenuBarAutoHide` and their existing
properties through the GTK menu view. Constructor `autoHideMenuBar` is forwarded
before the application menu is attached.

Visibility affects the actual GTK menu bar and content allocation. Hidden bars
use `no-show-all`, so showing a window does not silently reveal its menu.
Replacing a menu preserves its current visibility. Removing it clears the
visible state. Frameless windows retain menu accelerators without showing a bar,
matching the retained Electron `RootView::SetMenu` policy.

Auto-hide is an independent setting and does not immediately change visibility.
A lone Alt press/release toggles an auto-hidden menu. Other key presses cancel
the lone-Alt gesture; Escape hides the visible auto-hidden bar. Content clicks,
loss of window focus and menu deactivation also request hiding. Getters receive
native visibility updates. Invalid arguments and destroyed objects are rejected.

The Node/Bun full-runtime fixture checks native mapping and settled content
allocation, show/hide and menu-replacement preservation, hidden accelerators,
Alt/Escape and Alt-chord behavior, constructor policy, independent windows,
frameless policy and detachment. Geometry checks wait for the menu and content
allocations to sum to the client height before comparing hidden/shown sizes.

This is the GTK menu bar, not VS Code's custom web menu. Hidden Alt-letter
mnemonics, desktop-global menu export, all accessibility/keyboard-navigation
combinations, other window managers and Wayland acceptance remain unverified.
This change does not establish complete VS Code workbench readiness.

Original policy: `shell/browser/ui/views/root_view.cc` in the retained Electron
tree. See also [native window state](WINDOW_STATE.md).

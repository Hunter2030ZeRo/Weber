# Synchronous Linux platform bridge

`build.cjs` compiles a small stable Node-API 8 addon with the pinned
`node-api-headers` development dependency. Both Node and Bun load the same
`dist/native/weber_platform.node`; no V8 API or Chromium library is linked by this
transport or the GTK host.

Utility processes also use this addon's socketpair ownership primitives.
`takeParent` moves a descriptor out of the tagged native owner into an
asynchronous Socket, so native cleanup cannot close it twice. Those utility
channels use their own bounded structured-data protocol; they do not call the
synchronous platform request loop. Linux `guardParent` installs a parent-death
signal and checks the parent PID again to cover early parent exit. It terminates
the immediate utility process, including blocked JavaScript, and does not claim
an arbitrary descendant-tree sandbox.

The parent source compiler's explicit output directory applies to the addon too:
verification builds write `native/weber_platform.node` inside their temporary
output directory, without rewriting the installed runtime.

The addon creates a private Unix socketpair and passes one endpoint as descriptor
3 to the GTK host. Requests use a separate channel from asynchronous window and
renderer traffic, with sequential IDs, 4 MiB frames and a five-second deadline
covering both writes and reads. Incomplete transactions permanently close the
channel. The host reader schedules native operations on the GTK main loop and
writes their results from its reader thread. There is no listening socket.

The first client is Electron's original `global-shortcut.ts` module, with native
X11 grabs underneath `register`, `registerAll`, `isRegistered`, `unregister` and
`unregisterAll`. Register and ownership results are real synchronous booleans;
registration conflict rolls back partial lock-modifier grabs. Activation events
return through the normal asynchronous host event stream. Caps Lock and Num Lock
are ignored, and grab ownership is released when the host exits.

Current limits: Linux X11 only, at most 256 registrations per application, no
Wayland portal, no suspended shortcut mode, and no live keyboard-map remapping.
These operations report errors when unsupported. The runtime retains its explicit
trusted-development gate; this transport does not provide an OS sandbox.

Run transport failure checks with `node platform-sync/test.cjs` and
`bun platform-sync/test.cjs` from `weber/electron-runtime`. After building the GTK
host and X11 focus helper, run `xvfb-run -a python3
weber/electron-runtime/test-shortcut-live.py node` and repeat with `bun` from the
repository root. The live test verifies focus in another process, registration
conflicts, actual shortcut callbacks and key delivery after unregistering.

The channel also serves native clipboard and monitor/system preference commands.
Clipboard operations have a smaller 2 MiB total representation budget, including
X11 text aliases, and asynchronous native reads have a three-second deadline.
A timed-out native callback retains its state safely until GTK completes it.
Monitor/theme signals are event-driven, and the transport reader waits for real
socket readiness without a periodic timeout. Display IDs remain stable for each
monitor object during the runtime; they are not persistent hardware IDs.

# Bun backend connection

Status: implemented and validated on Linux Wayland. See the
[usage guide](bun-backend.md) and [recorded validation](bun-backend-validation.md).
The following design describes the implemented prototype and its boundaries.

Implement an opt-in backend entry in `weber.json`, compiled with Bun into a
self-contained executable. Keep the UI on Servo/SpiderMonkey or the existing
Hermes AOT path. Both UI modes use the same asynchronous SDK invocation API.
This does not replace Servo's DOM engine or expose Node globals directly in UI.

The native host owns one backend child per app and exchanges bounded JSON-line
messages over private stdin/stdout pipes. Pipe writes and reads happen outside
the UI thread. The first prototype uses a bounded result poll while calls are
pending; it is not a zero-IPC or zero-copy design. Correlation IDs, queue limits,
timeouts, cancellation of waiting, process failure and shutdown are explicit.
There is no automatic retry of potentially side-effecting methods.

Only named functions exported by the app backend are callable. Browser calls
carry a per-launch capability injected in application HTML (not a public script
resource); unrelated pages/frames cannot invoke the privileged backend without
it. Hermes's native callback is trusted app code. This is a native-app trust
boundary, not a filesystem/process sandbox for backend code.

Build emits the backend executable separately from browser assets, hashes it in
the app manifest, and includes it in app packaging. The host streams verification
of the larger executable rather than retaining it as a browser asset. Installed
Bun/Node and original node_modules must not be required for the demonstrated
bundled dependency path at runtime. Bun --compile embeds its runtime; this is
not Static Hermes native AOT compilation of backend JavaScript.

Development starts the same compiled backend alongside Vite and its native
window; stopping development cleans it up. Backend edits initially require a
dev restart; frontend HMR remains a separate existing capability.

Gate: actual Bun Node filesystem/crypto/process APIs and an npm dependency through
the SDK, concurrent/error/timeout/crash behavior, relocated JIT and AOT UI packages
in real Servo Wayland windows, capability rejection and process cleanup. Existing
apps without a backend must keep working without starting Bun. Linux first;
Windows/macOS packaging and arbitrary native addons/dynamic imports are not
assumed supported by successful bundling of one app.

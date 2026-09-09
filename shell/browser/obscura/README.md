# Obscura browser-side process proxy

This Linux/glibc implementation starts weber-obscura-renderer with posix_spawn.
The browser-side library and test executable do not link Obscura or V8. Each
renderer process owns one engine and its own DOM. A caller must own the proxy on
a worker/task-runner thread: these initial calls are synchronous and bounded,
not suitable for Electron's GUI thread.

The private socketpair is inherited as fd 3; other descriptors above stdio are
closed before exec. No shell, TCP port, WebSocket listener or executable search
through PATH is used. There is no fallback to Chromium. Messages use a 16-byte
big-endian header: WBR1 magic, sequence, kind, payload size. Kinds are request=0,
success=1, error=2 and ready=3. Startup returns ready/sequence 0/payload "1".
Requests are capped at 1 MiB and replies at 64 MiB before allocation. Capture
replies are raw PNG bytes; other success replies are JSON and errors are UTF-8.
PNG remains diagnostic and has not been replaced by raw frame presentation.

Each command has one deadline shared across send and receive. Corrupt frames,
sequence mismatches, disconnects and timeouts close the channel and terminate/
reap that proxy's child. Valid engine errors leave the channel usable. There is
one command in flight per proxy. Destroying the proxy closes and reaps its child;
this first implementation uses immediate termination, not application unload
callbacks. Parent death closes the only parent socket endpoint, so an idle child
sees EOF. This is process separation, not an OS sandbox or untrusted-content
security claim. No origin/preload permissions are implemented by this transport.

Tests distinguish explicit protocol fixtures from real Obscura processes. The
real test creates two renderer processes, checks independent documents, captures
PNG, terminates one child, confirms the other still answers, and starts a
replacement. It does not create native windows or prove multiwindow GUI support.

## Integration status

The existing electron::api::WebContents still delegates to Chromium. This proxy
is the next engine component, not yet wired into those methods or BUILD.gn.
Next: an asynchronous browser-side engine contract, native surface delivery and
navigation/input/lifecycle mapping. Existing Electron JS API behavior must be
preserved during that change. The full Electron binary has not been built with
this proxy. Windows/macOS launchers and OS sandbox policies remain pending.

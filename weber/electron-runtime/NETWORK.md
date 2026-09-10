# Chromium-free main and utility networking

Weber compiles the Electron `net.ts`, `net-client-request.ts`, `net-fetch.ts`,
`net-websocket.ts` and utility `net.ts` from its source fork. Scoped changes to
`net-client-request.ts` start empty chunked requests and close the transport when
a response is destroyed or a fetch reader is cancelled. `net-fetch.ts` preserves
and validates explicit options that Bun 1.4.2 drops from Request. These adaptations
are recorded in the source manifest; other public network wrappers are unchanged.
Failed upload streams also reject fetch and release their transport. `net-url-loader.cjs` supplies the native URLLoader contract with
Node/Bun HTTP; `net-binding.cjs` manages connection pools, lifecycle, DNS and
WebSocket transport. Renderer networking still belongs to Obscura.

## Implemented behavior

- Main `net.request` waits for app readiness. Utility `electron` and
  `electron/utility` expose the utility net module through CJS on both backends
  and ESM on Node. Bun ESM bare Electron imports remain unresolved.
- HTTP/HTTPS responses stream through the original IncomingMessage with an
  acknowledgement for each chunk. Paused consumers stop further delivery;
  response bodies are not accumulated into a single main-process buffer.
- gzip, zlib-wrapped deflate and Brotli decode incrementally. Original raw and
  repeated headers, Set-Cookie arrays, status and HTTP version remain available.
  Received cookies are data only and are not installed in a cookie jar.
- Redirect follow/manual/error policy remains in the original ClientRequest.
  The transport caps redirects at 20, implements method/body rewriting, rejects
  non-HTTP targets and strips authorization/cookie/Host across origins.
- Fixed and chunked uploads, upload progress, request abort and stream errors are
  connected to actual sockets. Content-Length is checked. Chunked uploads cannot
  be replayed for authentication or body-preserving redirects.
- Basic request-level login challenges retry at most twice; credentials are not
  cached or shared. Opt-in utility authentication forwards challenges to main
  `app.login` with a null webContents and the actual child PID. Cancellation,
  late callbacks and child termination release the owned challenge. Proxy
  authentication and session-specific login routing are absent.
- Default-session/main and utility `net.fetch` work with explicit
  `credentials: 'omit'`. AbortSignal and the original Request/Response adapter
  are retained. The default include-credentials behavior explicitly fails until
  shared browser cookies and authentication are implemented.
- System DNS lookup supports A, AAAA and unspecified family. `online` is only a
  non-loopback interface hint; enumeration failure reports false. It neither
  probes the Internet nor runs a background polling timer.
- Main `net.WebSocket` supports the original text, binary, Blob, ordering,
  binaryType, subprotocol and close behavior through the backend WebSocket.
  Session cookies, custom headers and origin/session options are rejected.

## Resource and isolation scope

Each process has at most 128 active HTTP/WebSocket operations. HTTP and HTTPS
have separate keepalive agents, each with at most 64 total sockets, 32 per origin
and four free sockets per origin. Successful responses retain reusable
connections; abort/failure destroys owned streams and sockets. Quit closes the
process's network resources. There is no extra network process, request-data IPC
or recurring polling timer in this main/utility transport.

The original non-chunked upload SlurpStream still buffers the complete upload;
this is not a claim of bounded application upload memory. The adapter rejects
fixed bodies above 64 MiB and individual chunked writes above 64 MiB. WebSocket
transport send admission is 4 MiB; this does not bound the original wrapper's
pending Blob conversion queue. The backend owns incoming message allocation.
There is no claim of WebSocket receive-memory bounds or a measured VS Code
memory/performance improvement from these changes.

## Remaining compatibility

Obscura's current high-level network API returns a complete byte vector and
collapses repeated response headers. Its request_client accessor could support a
future native streaming boundary, but it does not by itself attach browser
cookies, CORS, interceptors or redirect policy. The present backend transport
has separate pools and trust configuration from the renderer.

Shared/persistent browser cookies, proxy/PAC, NTLM/Kerberos, HTTP cache, session
webRequest interception, custom-protocol fetch in the main process, policy-rich
DNS, referrer policies and priority control are unimplemented. Non-default
session partitions and these unsupported policies fail explicitly. HTTPS always
verifies certificates; the test suite checks a real untrusted local certificate.
The original Electron parser drops Node-specific agent/rejectUnauthorized/auth
options, as Electron does; they do not configure this transport.

Utility `respondToAuthRequestsFromMainProcess` supports Basic HTTP challenges
without a session or partition. It is validated as a boolean. Browser cookies,
proxy authentication and Chromium shared network context are still absent.
Original VS Code requests this option; passing the isolated API tests does not
establish full extension/shared-process startup.

This is an application-privileged main/utility transport, not a renderer network
sandbox. Renderer process separation still has no OS sandbox. Full VS Code
startup and extension-host acceptance remain separate gates.

## Verification

`test-net.cjs` uses real loopback HTTP/HTTPS and unchanged compiled Electron
wrappers. `test-net-websocket.cjs` uses a real WebSocket echo peer.
`test-utility-auth.cjs` checks main/child authentication with real loopback HTTP.
`test-net-fetch-compat.cjs` checks Bun fetch policy preservation.
`test-utility-net.cjs` forks real CJS/ESM utility children, exercises gzip, POST,
fetch and cancellation, and verifies denied browser APIs and natural exit.
The Bun ESM Electron-import case records the expected unresolved-import failure;
it is not a passing ESM networking scenario. Bun ESM files using only supported
builtins still execute.
The workflow runs these tests separately on Node and Bun before the full native
runtime, extracted bundles and unmodified VS Code diagnostic.

## Continuation verification (2026-09-10)

The ten focused suites (`test-net`, `test-net-fetch-compat`,
`test-net-websocket`, `test-utility-net`, `test-utility-auth`, `test-utility`,
`test-startup-services`, `test-message-port`, `test-preload-boundary`,
`test-ipc-reply-queue`, all `.cjs`) produced:

| Runtime | Result | Qualification |
| --- | --- | --- |
| Node.js 24.19.0 | 54 passed | Real HTTP/TLS/WebSocket and utility subprocesses plus existing boundary regressions |
| Bun 1.4.2 | 53 passed, 1 skipped | Node-only trace test skipped; one pass verifies the expected unsupported Electron ESM import failure |

Fresh recompilation verified all 41 current source and compiled module hashes.
The manifest identifies two adapted network modules. Packaging unit checks
passed four cases with one build-dependent skip; startup diagnostic parser
checks passed three cases. These local tests do not build the native GUI,
measure application performance or establish a running VS Code workbench.
The full GitHub workflow separately builds Obscura/GTK, exercises extracted
Node/Bun/native bundles and records the unmodified VS Code startup result.

Full workflow [34470208877](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34470208877)
then passed all 16 runtime gates at `1219c94`, including real Obscura/GTK and
extracted Node/Bun/native bundles. The unmodified VS Code probe now stops at
missing `desktopCapturer`. Monaco passes its seven core checks and still fails
the dedicated module-worker check. The same-app comparison completed; median
IPC was 1.207 ms on Weber versus 0.542 ms on Electron in the three-trial small
fixture. This does not meet an Electron-or-faster IPC target and does not measure
whole VS Code behavior. Exact evidence is in the packaging/benchmark records.

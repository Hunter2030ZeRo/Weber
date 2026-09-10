# Session policies and system appearance

These implementations advance the Linux VS Code startup path. They are scoped
runtime features, not complete Electron Session compatibility or an OS sandbox.

## Request policy

Each Session owns its own `webRequest` instance. `onBeforeRequest` and
`onHeadersReceived` accept one callback listener per event, URL/resource-type
filters and `null` removal. The last registration replaces the previous listener.
Empty filters and `<all_urls>` include registered custom protocols.

The policy is enforced by two actual transports:

- Main-process `net.request` and `session.fetch` HTTP/HTTPS transport: cancellation
  before connecting or delivering bytes, bounded redirects with credential
  stripping across origins, response-header replacement and status-line changes.
  Redirect targets re-enter request policy. Requests select their owning Session
  with `session` or `partition`.
- Renderer custom protocols and intercepted `file` resources: cancellation before
  calling the protocol handler and header/status changes before the native resource
  reply reaches Obscura. This includes document, CSS, script, module and fetch
  resources routed through that protocol transport. Custom-protocol policy
  redirects fail explicitly because their origin and final-URL handling is not
  implemented.

Callbacks, response headers and queues are bounded. Invalid responses, exceptions
and expired callbacks fail the request. Aborting a request, replacing its document
or destroying its window discards late decisions. Protocol policy, handler and
stream stages share a 20-second deadline below the native resource deadline.
No polling timer is installed for idle sessions.

Direct HTTP/HTTPS requests inside Obscura, WebSocket, utility-process networking,
and other webRequest events are not connected to this policy. Registering these
two listeners does not provide comprehensive browser network confinement.
Cookies, persistent storage, proxy configuration and shared cache remain absent.

## Browser permissions

`setPermissionCheckHandler`, `setPermissionRequestHandler` and
`setDisplayMediaRequestHandler` store browser-owned policy per Session. The
renderer uses a private operation channel for fixed browser APIs, separate from
application `ipcMain` channels. Rust stamps each operation with its document
generation and URL; the main process validates that owner again before performing
native work. Changing the document, session or policy invalidates a pending grant.

Renderer `navigator.clipboard.readText()` and `writeText()` use the actual native
clipboard after permission succeeds. Newly connected operations deny by default;
the check handler may grant immediately, or the request handler may grant through
its callback. Queries consult checks without prompting. This is a deliberate
restricted development policy, not every Chromium permission default. Secure
contexts and explicitly secure custom schemes are required.

Media streams, display streams, geolocation and browser Notification delivery
remain unavailable. The browser overlay removes synthetic geolocation and fake
clipboard success. These APIs deny or report unsupported acquisition even when an
application policy grants them; selecting a desktop source cannot fabricate a
MediaStream. Electron main-process clipboard, Notification and desktopCapturer
APIs remain trusted application operations with their separately documented scope.

## nativeTheme

The original Electron module exposes GTK system appearance through the native
transport. It reads GTK foreground/background colors and high-contrast settings,
caches results and emits `updated` on changes. There is no periodic query loop.

`themeSource = 'system'` is supported. Forced light/dark themes and reduced
transparency queries fail explicitly. Renderer `prefers-color-scheme` and
`forced-colors` propagation, desktop portals and other operating systems remain
unimplemented; system appearance observation is not a complete renderer theme
implementation.

## Verification

`test-web-request.cjs` exercises real local HTTP transport through the original
Electron request wrapper, plus custom-resource lifecycle checks. The native
`protocol-fixture` checks renderer fetch cancellation and response headers.
`test-session-permissions.cjs` checks ownership, rejection and native-operation
dispatch. `test-native-theme.cjs` loads the original Electron module;
`weber/tests/native-theme.cc` changes actual GtkSettings through the native wire.
The full Linux workflow executes the engine and native fixtures separately from
the VS Code startup diagnostic. A successful diagnostic process exit is never
reported as workbench readiness.

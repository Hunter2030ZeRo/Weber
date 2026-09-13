# Outgoing request header policy

`session.webRequest.onBeforeSendHeaders` accepts the existing URL/type filters,
replaces the previous listener, and unregisters with `null`. It runs after
`onBeforeRequest` redirects and before HTTP/HTTPS transport creation or custom
protocol handler execution. Its callback may cancel or replace `requestHeaders`.
Omitting `requestHeaders` preserves the current headers. Returned names are
normalized to lowercase; values must be strings, valid HTTP headers, and fit
within 64 KiB. Case-insensitive duplicates replace the earlier value, matching the retained
Electron converter's `HttpRequestHeaders::SetHeader` behavior.

The HTTP adapter passes a separate header snapshot to the listener. Mutations
take effect only through the callback result. Body framing is checked again
after replacement: Content-Length must be valid and match buffered bytes;
streaming writes enforce the new length on both overflow and completion.
Content-Length and Transfer-Encoding cannot coexist. Streaming requests without
a length use chunked encoding. Backend-generated transport headers may still
be added after the hook, including Host and body framing defaults.

Redirects re-enter policy with the same request ID. Cross-origin redirects
remove authorization, cookies, proxy authorization and Host before the next
hook; HTTPS-to-HTTP transitions also remove Referer. Application policy can
explicitly supply new credentials for the destination. Existing streaming
replay restrictions remain in place.

Pending listeners share the existing ten-second timeout and abort handling.
Cancellation prevents transport/handler creation, and replies after timeout or
abort have no effect. Custom protocol requests retain their owner/navigation
lifetime checks and overall resource deadline.

Regression coverage includes a real localhost server receiving changed headers,
header deletion, cross-origin redirects, invalid header/framing rejection,
cancellation, timeout, late replies, aborts, custom protocol dispatch, and
buffered/streaming uploads. This hook does not connect the Node/Bun transport
to Obscura's cookie jar or establish renderer-wide HTTP interception. Other
webRequest events remain unsupported. Workbench readiness is assessed separately
by the original-layout VS Code diagnostic.

Malformed values fail the request in Weber; retained Electron skips some invalid
entries. This stricter validation is a documented compatibility difference.

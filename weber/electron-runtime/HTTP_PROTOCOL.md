# Custom protocol HTTP forwarding

`registerHttpProtocol` and `interceptHttpProtocol` use the existing per-session
registry and native resource bridge. A handler returns an HTTP/HTTPS `url`;
the upstream status, headers and decoded body become the custom resource reply.
Registration, duplicate rejection and unregister/unintercept retain the existing
registry behavior. Intercepting built-in HTTP/HTTPS remains unsupported.

The outgoing method defaults to the original request method. Original headers
are copied, with Host and upload framing regenerated for the target. The
optional response `referrer` replaces Referer. For non-GET/HEAD methods,
`uploadData: { contentType, data }` supplies the replacement body; this adapter
accepts string or Buffer data. Original upload bytes are not implicitly replayed.
The selected response `session` supplies upstream webRequest policy. Omitted or
null session uses the registering session, matching the retained native factory.
Invalid session objects are rejected.

HTTP transport uses the existing URLLoader, including header policies,
redirect limits, cross-origin credential stripping and TLS verification.
No pooled transport agent is retained by this path. Navigation replacement,
window destruction and app quit abort pending policy, handler or HTTP work.
The resource bridge's existing 20-second deadline bounds the whole operation.

This implementation buffers at most 512 KiB for a replacement upload or decoded
response. Larger resources fail explicitly. Streaming native delivery, cookies,
shared authentication/cache and complete browser HTTP context remain unsupported.
Compression and transfer framing headers are removed after URLLoader decoding;
the native bridge receives decoded bytes. Duplicate response headers retain the
bridge's existing comma-joined representation. This is not full Chromium network
compatibility or proof of VS Code workbench readiness.

Tests use real localhost servers and the protocol resource-event bridge to check
compressed content/status, selected-session policy, POST body replacement,
redirect credentials, invalid destinations, size limits, cancellation, registry
lifecycle and numeric protocol errors. Original source reference:
`shell/browser/net/electron_url_loader_factory.cc` (`StartLoadingHttp`).

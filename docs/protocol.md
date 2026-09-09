# Host protocol v1

The application backend launches `weber-host` as a child process without a
shell. Requests are UTF-8 JSON lines on stdin. Host messages start with
`@weber:` followed by JSON and a newline on stdout. Other stdout lines are
diagnostics and ignored. No network listener is opened.

Limits: 1 MiB per frame, 256 in-flight backend requests, 128 renderer calls,
32 Ki UTF-16 units per renderer payload, eight drained calls per GUI tick.
The stdin reader waits for the GUI thread to acknowledge each request, bounding
its event queue. The initial hello is `{"event":"ready","protocol":1}`.

Requests: `{"id":1,"method":"window.create","params":{...}}`.
Responses: `{"id":1,"result":1}` or `{"id":1,"error":"..."}`.
IDs belong to a single pipe session and responses may arrive out of order.

| Method | Parameters | Result |
| --- | --- | --- |
| `window.create` | width, height, title, show, allowedChannels | window ID |
| `window.loadFile` | window, absolute path | null |
| `window.evaluate` | window, source | JSON value, synchronous results only |
| `window.url` | window | URL string |
| `window.title` | window, title | null |
| `window.visible` | window, visible | null |
| `window.close` | window | null |
| `ipc.reply` | window, epoch, call, result or error | null |
| `app.quit` | none | null |

Renderer calls become events with `event:"invoke"`, `window`, `epoch`, `call`,
`channel`, and `payload`. Replies must echo the same window/epoch/call. Loading
another file increments the epoch, so a late response cannot resolve a promise
in a replacement document. Window IDs currently support only one active window.

Events also include `closed`. Pipe EOF closes the host. A host crash rejects
pending backend requests. JavaScript renderer calls time out after 30 seconds.
Backend requests/startup default to 30 seconds. A timed-out operation is not
automatically retried, because it may already have caused side effects.

The protocol is a trusted application boundary, not a sandbox. Renderer channel
allowlists are checked in both Rust and JavaScript. No Node/Bun globals are
injected into the page; Rust native callbacks use the same allowed channels.

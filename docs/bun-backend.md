# Bun / Node-compatible backend

Weber has an opt-in Bun backend connection. UI code runs in Servo/SpiderMonkey
or the existing Static Hermes AOT path; app backend modules run in Bun. Both UI
modes use the same Promise-based SDK API. This is a supported prototype route for
Node-oriented application code, not a replacement for Servo's DOM engine.

## Start a project

With the prepared local SDK/toolchain and Bun installed for building:

```sh
node sdk/cli.mjs init /tmp/my-node-app node
cd /tmp/my-node-app
npm install
npm run dev
npm run package
npm run package:aot
```

The node template demonstrates `node:fs/promises`, `node:path`, `node:os` and
`node:crypto`. It writes/reads a temporary text file and returns its SHA-256.
Normal npm dependencies are installed in the application project. Build-tool
Node and backend Bun are separate: adding Bun does not change the Vite runner.

Existing projects opt in by adding the backend entry to `weber.json`:

```json
{
  "schemaVersion": 1,
  "id": "dev.example.app",
  "name": "Example",
  "version": "0.1.0",
  "entry": "src/main.tsx",
  "backend": "backend/main.mjs"
}
```

The backend default-exports named methods. For example:

```js
import { createHash } from 'node:crypto';
export default {
  hash({ text }) {
    return createHash('sha256').update(text).digest('hex');
  }
};
```

UI code calls it asynchronously:

```ts
import { invoke } from '@weber/sdk/backend';
const hash = await invoke<string>('hash', { text: 'Hello' });
```

Node imports belong in the backend. A project having Bun enabled does not make
`node:fs` available inside its DOM/UI realm. Backend entries can be JS or TS; Bun
transpiles them. The generated UI TypeScript configuration checks `src`, not the
backend. Add a separate backend type-check configuration for backend TS and its
Node/Bun types. Method names/generic result types are not an end-to-end schema or
automatic runtime validation of application-specific parameters.

## Execution and distribution

Build uses `bun build --compile` to embed the backend module, statically resolved
dependencies and Bun runtime into a separate executable. This is a packaged Bun
JavaScript runtime, **not Static Hermes native AOT compilation of backend JS**.
`WEBER_BUN` selects the build-time Bun executable; otherwise `bun` is used.

The app manifest declares a separate backend executable/hash/runtime version.
The native host checks its package path, size, Linux ELF header and SHA-256 before
starting it. It is not served as a browser asset. Packaging includes it beside
the UI resources. Demonstrated bundled dependencies do not need an installed Bun,
Node, the original source directory or node_modules at runtime. Dynamic imports,
native addons and application data files may need explicit additional packaging;
successful static bundling does not establish their general support.

The current JIT prepared host is `target/package/weber-beta-jit/weber`; the
AOT-enabled host is `target/package/weber-beta-aot/weber`.
`WEBER_HOST` explicitly selects another compatible host. The host advertises
`bunBackendProtocol: 1`; packaging rejects preceding hosts without that capability.
Apps without a backend still work and start no Bun child. The default host build now excludes Hermes; the `aot` feature enables the
existing native AOT path.

In packaged execution the backend cwd/`WEBER_APP_DIR` is its application directory.
In development it is the source project directory. Backend edits initially need
a dev restart; ordinary frontend Vite HMR remains supported. The development
backend currently requires the default loopback HTTP URL.

## Invocation and lifetime

The host owns one backend process per enabled app. Private stdin/stdout pipes
carry correlation IDs and bounded JSON lines. Reader/writer work runs outside
the UI thread. The UI prototype polls results every 8ms only while calls are
pending; copies, serialization and polling latency remain. It is not a shared
heap, zero-copy or zero-IPC design.

- Method names are explicitly exported own properties, not arbitrary evaluation.
- Arguments/results are JSON values. The client limits serialized requests to
  16,000 UTF-16 code units and the native boundary to 48KiB of UTF-8. Replies are
  bounded to 1MiB; at most 128 calls may be pending.
  Binary/prototype identity is not preserved; encode binary data explicitly.
  Unpaired UTF-16 surrogates are outside this JSON/UTF-8 bridge's supported values.
- Errors retain a name/message. Missing methods, malformed/oversized results,
  startup failure, process failure and queue exhaustion reject calls.
- Default invocation timeout is 30 seconds, configurable as
  `invoke(method, params, { timeoutMs })` in the range 1..60,000ms. Startup has a
  separate five-second handshake limit.
- On timeout, waiting is cancelled and the backend receives a cooperative abort.
  A method's second argument is `{ signal }`; abort-aware Node APIs can use it.
  Already completed side effects are not rolled back. A synchronous blocking
  method cannot observe cancellation until it yields.
- Backend failure rejects pending calls. There is no automatic replay/restart of
  potentially side-effecting work; restart the app to restart this prototype's
  backend.
- Normal shutdown kills/reaps the owned backend and its dedicated Linux process
  group. Linux parent-death signaling terminates the direct Bun child even if
  the host is force-killed during a synchronous backend loop. This is not an OS
  sandbox or a guarantee for descendants that deliberately detach/escape groups.
- Console log/info/debug/warn/error go to stderr; stdout is reserved for the
  protocol. Libraries writing directly to stdout can break that protocol and
  require an adapter or a future dedicated transport.

Browser calls need a per-launch capability inserted into application HTML, not a
public JavaScript resource. Missing/invalid capabilities are rejected. Hermes
uses a native app callback. Backend code has ordinary native-app filesystem and
process privileges; package hashes detect changes, not publisher authenticity.

## Evidence boundaries

Actual tests use Bun 1.4.2 and include filesystem/crypto/process APIs plus the
real npm package semver 6.3.1. This is not a promise of complete Node.js/Electron
compatibility. Consult Bun's compatibility matrix and test each app's actual
dependencies, particularly native addons, V8-specific APIs and dynamic loading.

Native validation is Linux Wayland first. Windows/macOS host packaging and
process-lifetime integrations have not been verified. No startup/memory benefit
is claimed for adding a second runtime. Optional Bun adds an executable/process
and must be measured on representative applications.

See [validation](bun-backend-validation.md) and the
[connection design](bun-backend-plan.md).

Primary documentation: [Bun executable bundling](https://bun.sh/docs/bundler/executables),
[Node compatibility](https://bun.sh/docs/runtime/nodejs-compat).

Window ownership and native-wakeup subscriptions are documented in
[native runtime](native-runtime.md). Invoke still polls while calls are pending.

# Weber SDK 0.2 — native AOT application foundation

The current SDK tooling is 0.3: see [Vite/npm workflow](vite-workflow.md).
`build` now defaults to JIT; pass `--aot` for the native AOT flow below.

The SDK API below also applies to the current [native byte binding milestone](binary-dom-validation.md), including its measured performance limits.

Weber can build independent JS/TS applications as native Static Hermes modules
and run them in the same Servo/Wayland host without rebuilding the engines.
This is an experimental framework foundation with a fixed compatibility profile,
not a full browser implementation or a production stability commitment.

## Build and run an application

Use the prepared local checkout/toolchain. `sdk/package.json` describes the local
SDK; it has not been published to npm and is not a self-contained SDK installer.

```sh
node sdk/cli.mjs init /tmp/my-weber-app solid
npm --prefix /tmp/my-weber-app install
node sdk/cli.mjs check /tmp/my-weber-app
node sdk/cli.mjs build /tmp/my-weber-app target/applications/my-app --aot
node sdk/cli.mjs run target/applications/my-app
node sdk/cli.mjs run target/applications/my-app --web
```

`init` also accepts `dom` for a framework-independent DOM/TypeScript app. Existing
directories are never overwritten by init. Build runs strict TypeScript checks,
Vite bundling and actual native O3 compilation. It uses a staging directory and
replaces only a recognized build output after success, preserving the previous
application when compilation fails. Static CSS and imported assets are served
from the application origin. Runtime does not require Node, Vite or source files.

`weber.json` identifies the application and entry:

```json
{"schemaVersion":1,"id":"dev.example.app","name":"Example","version":"0.1.0","entry":"src/main.tsx"}
```

The local builder provides pinned SolidJS, Vite and TypeScript dependencies from
`app/node_modules`. Arbitrary additional project dependencies need to be installed
in that project. This is currently a Linux Wayland toolchain; Windows/macOS
loaders/windowing remain unimplemented. An optional [Bun backend](bun-backend.md)
now supports selected Node APIs; [native runtime](native-runtime.md) describes
window ownership and backend event subscriptions.

## Entry points

For SolidJS:

```tsx
import { createSignal } from "solid-js";
import { defineSolidApp } from "@weber/solid";

defineSolidApp(() => {
  const [count, setCount] = createSignal(0);
  return <button onClick={() => setCount(count() + 1)}>{count()}</button>;
}, { title: "Example" });
```

For other libraries or direct DOM code, `defineApp` from `@weber/runtime` accepts
`{ title?, mount(root), test? }`. `mount` may return a cleanup function. The SDK
calls cleanup and clears the owned root on unmount, supports remount, and keeps
application state in the native module. `test` is an optional synchronous,
JSON-serializable test result used only with `WEBER_APP_TEST=1`. This is separate
from real OS input verification.

The Solid integration restores delegated events for each document session and
uses session-local template caches. Ordinary user app/shell code remains TSX and
standard DOM/CSS API calls within the supported profile.

Document globals and the document clock are installed before user module
evaluation, so supported DOM APIs are available to top-level module code too.
The initial clock uses original wire bytes, preserving the same timeOrigin as
later requests instead of introducing a Rust floating-point reformatting step.

## Native module and packaging contract

`build` emits `app.so`, `app.json`, web comparison/CSS/assets and diagnostic build
files. `app.so` contains already compiled machine code; loading it uses `dlopen`,
not JS evaluation or runtime JIT. One application module is loaded per process.
The host retains its library until the Hermes runtime has been destroyed.

The versioned manifest contains the pinned Hermes revision, a native ABI hash,
native module SHA-256 and declared asset hashes. The host validates these and
package-relative paths before loading. Assets are bounded and read into immutable
memory at startup. ABI/hash validation detects mismatches and accidental changes;
it is not a signature, a native-code sandbox or permission isolation. Run native
application packages with the same trust as other installed native programs.

After building the release host:

```sh
WEBER_HOST="$PWD/target/package/weber-framework/weber" node sdk/cli.mjs package target/applications/my-app target/package/my-app
cd target/package/my-app
./weber --app ./application
```

The package copies the host, private libraries and only the compiled application
and declared resources. It can be moved to another directory and run with a
different cwd using absolute `--app` paths. Compatible glibc, a Wayland compositor,
graphics drivers and system fonts are still required. No host installation or
registry publication is performed by build/package.

## Binding and transport changes

- Real-view inline `style` objects refer to Servo CSSStyleDeclaration. Values,
  parsing, normalization, priorities and shorthand expansion are owned by Servo.
  Hermes retains wrapper identity and application expandos. A local CSS fallback
  is loaded only by standalone runtimes without a scoped real-DOM route.
- Native style changes update the AOT Attr identity/value and observer records
  from the real mutation results. They are not written to Servo a second time.
  Eighteen checks compare the facade to actual Servo CSSOM, including detached
  nodes, invalid values, enumeration and observer oldValue/counts.
- Browser mode no longer stores a second set of parent/child arrays in the
  low-level command registry. The browser facade owns its topology; low-level
  legacy contracts retain their independent topology only in legacy mode.
- Requests are parsed once by the Rust host. Original validated request/reply/
  query bytes are forwarded without reserialization. Live queries consume the
  pending command array directly, and event dispatch accepts its existing object.
  Frame/event calls no longer serialize the entire diagnostic report.

The transport still uses a JSON wire boundary and UTF-8/JSI copies. Hermes still
has browser node wrappers/topology/attributes in addition to Servo's actual DOM;
this work removes particular duplicate representations, not all mirrored state.
Replacing those with canonical native node handles and a typed transport remains
an engine-binding project. Servo still uses SpiderMonkey for the generic adapter.
No SpiderMonkey removal or zero-copy result is claimed.

## Compatibility and evidence boundaries

The fixed `weber-ui-2025-01-v1` profile covers 17 original WPT files / 1,474
subtests per engine (1,420 are classList cases), plus 15 required scenarios. It
does not establish full browser compatibility. For example, programmatic
`HTMLElement.click()` activation is not yet implemented in the AOT facade; SDK
examples test their handlers with `dispatchEvent`. Native keyboard/mouse
activation uses Servo's real event/default-action path. Shadow DOM/custom
elements, complete HTML element APIs, arbitrary browser libraries, multiple
windows and Node/Bun desktop APIs are outside the validated profile.

See the final [framework validation](framework-validation.md),
[compatibility target](compatibility-target.md), and
[previous AOT cost analysis](aot-cost-analysis.md). The framework examples are
independent user modules rather than hardcoded branches in the host.

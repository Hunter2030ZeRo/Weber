# Vite and npm workflow — SDK 0.3

Weber is a general GUI application framework targeting Linux, Windows and macOS.
The current native implementation and package builder are validated on Linux
Wayland only. A desktop shell using Weber is a separate downstream application;
Hyprland-specific APIs do not belong in the common build interface.

JIT is the default cross-platform application path. Native AOT is optional for
startup/memory-sensitive workloads; its platform-specific compiler/loader support
is not a prerequisite for a JIT platform release. Both paths retain the common
application API. The current prepared host still links Hermes and its source
build needs the AOT toolchain; JIT-only application output does not yet imply an
AOT-free host build. Making that host build independent is part of the platform
work. AOT's intended performance benefit remains subject to measured validation.

## Create and develop

In this prepared source checkout:

```sh
node sdk/cli.mjs init /tmp/my-weber-app solid
cd /tmp/my-weber-app
npm install
npm run dev
```

`init` also accepts `notes` (a [persistent Notes app](app-storage.md)), `windows`, `dom` and `node` (a [Bun backend example](bun-backend.md)). The generated project has package scripts, an editable
`vite.config.mjs`, `tsconfig.json`, development HTML and app metadata. The SDK
dependency points to this local checkout; this is not a published or self-contained
npm SDK. Node runs the tools, not the packaged UI. Bun is not required or verified
as an alternative tool runner in this milestone.

The Vite preset includes Solid transforms and the Weber DOM/runtime aliases:

```js
import { weber } from '@weber/sdk/vite';
export default { plugins: [weber()] };
```

User `define`, aliases, environment files, additional plugins and public resources
are processed by Vite. Dependencies resolve from the project. The original SDK
0.2 examples without package/config files retain a prepared-checkout fallback.
Do not add a second `solid()` plugin beside this preset. With an existing Solid
plugin, the automatic JIT adapter can work; AOT requires the Weber preset to select
its renderer transform.

`npm run dev` starts Vite on loopback and opens its URL in the native Servo window
using SpiderMonkey. Closing the window stops Vite. SIGINT/SIGTERM stop the owned
host and server; a host launch failure also closes the server. CSS changes use
Vite HMR. TS/TSX updates use the framework's HMR behavior or page reload where
there is no accepting boundary; universal state preservation is not promised.
The generated Solid component has an exported component boundary. This is JIT
development; it is not hot replacement of native AOT machine code.

## Build and distribute

```sh
npm run check
npm run build
npm start
npm run build:aot
npm start
npm run package
npm run package:aot
```

- `build` creates a JIT-only app (`web.js`, CSS/resources, `app.json`). It does not
  invoke the Static Hermes compiler or emit a native app unit.
- `build:aot` emits both JIT resources and an actual O3 Static Hermes `app.so`.
  Its manifest records the existing native ABI and module hash. AOT still uses
  the experimental Servo bridge and SpiderMonkey-owned DOM bindings.
- `start` runs `dist`; a JIT-only manifest automatically selects SpiderMonkey.
  A manifest with a native unit selects AOT; `weber run dist --web` selects its
  JIT comparison. A failed native unit does not silently fall back to JIT.
- `package` and `package:aot` build then create a relocatable Linux directory in
  `package/`. Run `./weber --app ./application` there. Node, npm, Vite and the
  original sources/node_modules are not needed to run that directory.

The default host prefers `target/package/weber-beta-jit/weber`, then `target/package/weber-vite/weber`, then the debug host,
then the preceding framework package. `WEBER_HOST` explicitly selects a host.
JIT-only manifests require the new host; preceding hosts do not understand them.
Old AOT manifests retain their ABI/hash/path validation, including in web mode.

Build and package use staging directories. Type errors, bundler failures or
native compilation errors preserve the previous output. Unrecognized nonempty
output directories are rejected. Packaging checks declared resources before
copying, and only the declared app files are shipped.

## Current boundaries

The SDK currently produces one library entry in a fixed app manifest format;
this is not arbitrary Vite HTML/multipage output. `weber.json` selects the entry.
Build root, output location, library format/entry/filenames and app URL base are
controlled by Weber. Plugins that require a different output contract, SSR or
Node runtime APIs are not automatically compatible. Vite and its plugins can use
Node APIs while building; UI imports of Node built-ins are rejected with a
runtime-compatibility diagnostic. Native desktop APIs and optional backend
runtimes remain separate work.

Linux AOT linking and package creation are explicitly platform-specific today.
The new workflow does not establish Windows/macOS native support. Matching
Linux loader/glibc, GPU drivers, fonts and an active Wayland compositor remain
runtime requirements. No install, publication or performance improvement is
implied by this tooling milestone.

Validation is recorded in `artifacts/vite-workflow.json` (npm/build/package) and
`artifacts/vite-native-workflow.json` (actual Servo/Wayland execution and editing).
See [validation](vite-workflow-validation.md) for executed scope and limitations.

Vite integration references: [Vite 7 plugin API](https://v7.vite.dev/guide/api-plugin)
and [JavaScript API](https://v7.vite.dev/guide/api-javascript).

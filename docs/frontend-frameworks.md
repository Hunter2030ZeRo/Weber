# UI library integration — SDK 0.6.0-alpha.5

Weber's application boundary is an HTML element and a mount/dispose function.
The native host does not require Solid. React, Vue, Svelte and Angular use their normal DOM
renderers against Servo's SpiderMonkey-owned DOM; no custom renderer, Weber-maintained DOM
mirror, Node global shim or Rust application component is introduced.

## Starting an app

From the Weber checkout:

```sh
node sdk/cli.mjs init /tmp/react-app react
node sdk/cli.mjs init /tmp/vue-app vue
node sdk/cli.mjs init /tmp/svelte-app svelte
node sdk/cli.mjs init /tmp/angular-app angular
node sdk/cli.mjs init /tmp/plain-app dom
```

In the chosen directory, use `npm install`, `npm run dev`, `npm run check`,
`npm run build`, `npm start` and `npm run package`. A prepared/installed native
runtime is needed to run/package. The local SDK/runtime tarballs are not published
to npm; see [independent SDK installation](npm-distribution.md).

The templates pin these versions:

| UI | Renderer | Vite plugin | Type checking |
| --- | --- | --- | --- |
| Plain DOM | Browser DOM | Common Weber bindings only | TypeScript 5.9.3 |
| Solid | solid-js 1.9.9 | vite-plugin-solid 2.11.10 | TypeScript 5.9.3 |
| React | react/react-dom 19.2.9 | @vitejs/plugin-react 5.2.0 | TypeScript 5.9.3, @types/react and @types/react-dom 19.3.0 |
| Vue | vue 3.5.44 | @vitejs/plugin-vue 6.0.10 | vue-tsc 3.3.13 / TypeScript 5.9.3, including SFC template expressions |
| Svelte | svelte 5.57.2 | @sveltejs/vite-plugin-svelte 6.2.4 | svelte-check 4.7.7 / TypeScript 5.9.3 |
| Angular | @angular/core/common/forms/platform-browser 21.2.25, RxJS 7.8.2 | @analogjs/vite-plugin-angular 2.9.2 / @angular/build 21.2.25 | ngc 21.2.25, strict templates / TypeScript 5.9.3 |

All use Vite 7.1.12. Only Solid projects install Solid and its Vite plugin.
Both are optional SDK peers; other UI libraries and their plugins are app dependencies.
`weber()` detects the app's direct Solid dependency, rather than finding Solid
in the Weber checkout and imposing it on other apps. Existing Solid plugins
can disable the automatic transform with `weber({ solid: false })` while
retaining shared-instance aliases. Package-less legacy apps explicitly importing
`@weber/solid` retain the previous checkout tool fallback.

## Application boundary

React's entry uses a separate component file so the official Fast Refresh
boundary can retain state:

```tsx
import { createRoot } from 'react-dom/client';
import { defineApp } from '@weber/sdk/runtime';
import App from './App';

defineApp({ mount(root) {
  const app = createRoot(root);
  app.render(<App />);
  return () => app.unmount();
} });
```

Vue uses the same boundary with `createApp(App)`, `app.mount(root)` and a returned
`() => app.unmount()`. Plain DOM can append nodes and return cleanup. The existing
`defineSolidApp` remains available. Window/storage/clipboard/files/system modules
are normal TypeScript modules, independent of the UI library. Components should
unsubscribe native watches in their own framework's cleanup hook.

The build emits the established IIFE application entry and hashed resource
manifest. Vite's library mode leaves `process.env.NODE_ENV` unexpanded, so Weber
now defines that expression as `"production"` at build time by default, respecting
an explicit project `define` value. This fixed an actual packaged React startup
failure (`process is not defined`) and also removes runtime environment accesses
from Vue. No `process` object or Node compatibility layer is injected into the UI.

## Svelte and Angular

Svelte 5 uses `mount`/`unmount` and a normal `.svelte` component with runes.
`svelte-check` checks component scripts and expressions. Angular uses an
unmodified standalone `@Component` with an external template and FormsModule.
`ngc` checks scripts and strict template expressions before every build. Analog's
Vite plugin explicitly receives `tsconfig.app.json`, including when Weber builds
its IIFE library entry. Common bindings transpile the SDK's external TypeScript
modules, which are outside Angular's compilation unit.

Angular uses `createApplication`/`createComponent` with an explicit host element.
A disposed flag destroys a late application result instead of letting an old
async bootstrap attach to a newer mount. Angular 21's default zoneless path is
used; ZoneJS is not installed by this template. Angular's template AOT produces
JavaScript for SpiderMonkey; it is not native machine code or Static Hermes.

Native file-change results are deliberately distinguished:

- React/Vue samples retain page and counter state for their tested component edits.
- Svelte's tested component edit retains the page and resets local sample state;
  CSS HMR retains page and state.
- Angular's current Analog configuration reloads the page for the tested CSS and
  external-template edits, resetting local state. Editing works, but stateful
  component HMR is not claimed. The app remains interactive after the update.

New-template checks include negative component/template type errors, rejection
of UI Node imports and native-AOT requests, real OS button input/Fcitx Hangul,
SDK window/storage calls, immediate mount cancellation/remount and post-update
interaction. Runtime AOT requests for all four new renderer templates are
explicitly rejected.

## Validation

Reproduce against a prepared JIT host:

```sh
node scripts/npm-release.mjs /absolute/prepared/weber
node scripts/framework-workflow.mjs
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/nested-hyprland.mjs \
  scripts/framework-native.mjs
```

The workflow unpacks and runs the shipped SDK CLI/templates, installs the local
runtime tarball and official npm dependencies, and produces relocated packages.
It verifies dependency isolation, TypeScript checks (also without a project
tsconfig for DOM/Solid), ordinary Vite configs with automatic bindings, rejection
of Node built-ins in UI code, and React/Vue component type errors/AOT requests.
`WEBER_OFFLINE=1` reuses the project-local `artifacts/npm-cache` after an initial
install. It does not publish any package.

The native suite uses isolated Hyprland 0.56.2, nested under private GNOME, at
960×720 scale 1. It runs native Wayland OS key injection and the real Fcitx5
Hangul engine; it does not synthesize DOM input/composition events. Each
relocated package launches with an empty executable search path, then exercises
buttons, Hangul input, common window/storage APIs and disposal/remount. Development
tests run `npm run dev`, edit CSS and component/template files, and check HMR
and shutdown of Vite with the native window. Probe modules exist only in generated
acceptance fixtures, not in the shipped templates.

Machine-readable records: `artifacts/framework-workflow.json` and
`artifacts/framework-native.json`, with individual build/dev/telemetry logs.
The preceding alpha.4 pass (historical, before Svelte/Angular) completed against SDK/runtime `0.6.0-alpha.4`:

| Template | Installed SDK check/build/package | Native OS input / Hangul / SDK / remount | Native Vite CSS HMR | Component HMR with page/state retained |
| --- | --- | --- | --- | --- |
| DOM | Passed | Passed, including note insertion | Passed | Not exercised |
| Solid | Passed | Passed | Passed | Not exercised in this increment |
| React | Passed | Passed | Passed | Passed, `App.tsx` Fast Refresh |
| Vue | Passed, including SFC negative type check | Passed | Passed | Passed, `App.vue` template change |

All four native development servers closed with their windows; relocated apps
ran with Node/npm/Bun absent from their executable search path. All four builds
also accepted ordinary Vite configs without an explicit Weber plugin and rejected
Node built-in imports in UI code. React/Vue component type errors and unsupported
AOT requests were rejected. The package-less source DOM/Solid examples also built.

The final JIT host was compiled with
`CARGO_TARGET_DIR=target/optimized cargo build --release --locked --offline` and
prepared as `target/package/weber-frameworks/weber`. Existing upstream Servo
warnings remain; the release build completed. The engine implementation was not
changed by this increment. Its recorded source fingerprint matches the final
source tree:

```text
d0fd62c143d8d48706411b585e8efac1e476784a6dd5be940010249210edcb87
```

The SDK tarball tested by the installed workflow has SHA-256:

```text
d3e4cd20999aae865489dab71a6d867906d380e3dd46123dd2013f73a46f0473
```

The two JSON reports record four build/package results and eight native scenario
groups (package and development for each UI), with runtime identity and detailed
observations. These are functional checks rather than a performance benchmark.

## Boundaries

These samples do not certify every React/Vue component, every npm package,
SvelteKit, SSR, hydration, rich editors or arbitrary Vite HTML/multipage output.
Weber still owns a single browser application entry and manifest. Missing web
APIs remain Servo/Weber compatibility work; normal DOM renderers cannot supply
missing host APIs automatically. Physical-human keyboard acceptance, accessibility,
Windows/macOS and production desktop-shell integration remain separate gates.

The normal runtime is SpiderMonkey JIT. React/Vue/Svelte/Angular native AOT is explicitly rejected;
Static Hermes and Hermes-only DOM are deferred. No startup, CPU or memory gain
is inferred from these observer-instrumented functional tests.

References: [React DOM integration](https://react.dev/learn/add-react-to-an-existing-project),
[Vue application mounting](https://vuejs.org/guide/essentials/application),
[Vue TypeScript/SFC checking](https://vuejs.org/guide/typescript/overview),
[Vite library environment behavior](https://v7.vite.dev/guide/build#library-mode).

Additional primary references: [Svelte imperative API](https://svelte.dev/docs/svelte/imperative-component-api),
[Svelte TypeScript tooling](https://svelte.dev/docs/svelte/typescript),
[Analog Vite integration](https://analogjs.org/docs/packages/vite-plugin-angular/overview),
[Angular zoneless mode](https://angular.dev/guide/zoneless).


## Current alpha.5 result

The final pass contains six installed-template build/package results and twelve
native package/development scenario groups, all passed. The [shell foundation
report](shell-foundation.md) records the
matching source fingerprint, local SDK tarball hash and native build checks.
The alpha.4 hashes above are historical and do not identify this new build.

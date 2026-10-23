# Vite and npm workflow — SDK 0.6.0-alpha.5

Weber is a general GUI application framework. The implemented native host and
packager currently target Linux x64 / Wayland. Windows/macOS remain future
hosts; Hyprland integration belongs to downstream desktop applications.

## Create and develop

From the checkout, select plain DOM, Solid, React, Vue, Svelte or Angular:

```sh
node sdk/cli.mjs init /tmp/my-weber-app react
cd /tmp/my-weber-app
npm install
npm run dev
```

Other templates: `dom`, `solid`, `vue`, `svelte`, `angular`, `shell`, `workbench`, `notes`, `windows`, `node`.
Workbench/Notes/Windows/Node use Solid. Node is a Bun backend example, while
Windows demonstrates multiple app windows rather than a Windows OS port.
The generated package has normal scripts, Vite/TypeScript config, development
HTML and `weber.json`. For SDK/runtime tarballs outside a checkout, follow
[local npm distribution](npm-distribution.md).

`weber()` supplies runtime and native SDK aliases. In a Solid project it also
adds Solid's transform and shared-instance aliases. For other libraries, include
their usual Vite plugin:

```js
import react from '@vitejs/plugin-react';
import { weber } from '@weber/sdk/vite';
export default { plugins: [react(), weber()] };
```

The Vue template uses `vue()` from `@vitejs/plugin-vue`. Plain DOM needs only
`weber()`. React/Vue/Svelte/Angular/DOM projects do not install or resolve Solid. An existing
Solid plugin can use `weber({ solid: false })` to avoid a duplicate transform.
When a normal Vite config omits `weber()`, the CLI adds common bindings and, if
needed, the Solid transform automatically. Very old package-less apps explicitly
importing `@weber/solid` retain the checkout fallback.

Project dependencies, environment files, `define`, aliases, additional plugins
and public resources are processed by Vite. `npm run dev` serves on loopback and
opens a native Servo window using SpiderMonkey. Closing the window stops Vite;
signals and host launch failures also clean up the server. CSS changes use HMR.
Component changes use the official plugin's behavior, with ordinary reloads
where no HMR boundary exists. Universal state preservation is not promised.

## Build and distribute

```sh
npm run check
npm run build
npm start
npm run package
./package/weber --app ./package/application
```

- `check` runs TypeScript, or `vue-tsc` when declared by the project, so Vue SFC
  scripts and templates are checked rather than silently omitted. Svelte uses
  `svelte-check`; Angular uses `ngc` with strict template checking.
- `build` emits `web.js`, CSS/resources and `app.json` for SpiderMonkey JIT.
- `start` runs the compiled app in the installed native runtime.
- `package` builds and creates a relocatable Linux directory with native host,
  private libraries, app resources, notices and desktop launcher.

The packaged JIT UI needs no Node/npm/Vite/Bun. A compatible glibc loader,
Wayland compositor, GPU/EGL drivers and fonts remain prerequisites. Bun is
optional only for apps using its separate backend process. Installed runtime
packages are preferred; `WEBER_HOST` explicitly selects a prepared host.

Build/package use staging directories. Failed checks/builds preserve the previous
recognized output; unrecognized nonempty outputs are rejected. Packaging verifies
declared resource hashes and ships only declared resources.

## Current boundaries

Weber owns a single library entry from `weber.json`, output format/filenames and
app URL base. Arbitrary HTML/multipage/SSR output is not supported by this
contract. Build plugins may use Node APIs; UI imports of Node built-ins are
rejected. Standard DOM rendering does not guarantee every web API or third-party
component. See [framework integration and native validation](frontend-frameworks.md).

Static Hermes remains deferred/experimental. Legacy DOM/Solid source-checkout
`build:aot` scripts require the native toolchain and retain a SpiderMonkey DOM
adapter. New React/Vue/Svelte/Angular templates expose the JIT workflow and explicitly reject
AOT requests. They do not add Hermes-only DOM support.

References: [Vite plugin API](https://v7.vite.dev/guide/api-plugin),
[Vite JavaScript API](https://v7.vite.dev/guide/api-javascript),
[React DOM integration](https://react.dev/learn/add-react-to-an-existing-project),
[Vue TypeScript tooling](https://vuejs.org/guide/typescript/overview).

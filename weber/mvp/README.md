# Weber MVP acceptance

The MVP is an Electron application runtime using Obscura in place of Chromium.
Standalone C++ engine/proxy tests are necessary component tests, not MVP success.
The current standard BrowserWindow/WebContents route still uses Chromium.

## Execute the ordinary application contract

On Linux with a desktop display (or Xvfb), provide a built Weber Electron binary:

```sh
xvfb-run -a node weber/mvp/run.mjs /absolute/path/to/built/weber
```

The fixture imports `electron` normally and checks two native windows, isolated
preload, Promise-result JavaScript evaluation, renderer/backend IPC, page capture,
renderer process identity and window lifecycle. It must not be run with a host
mock or an Electron module alias to the prototype package. It does not pass by
renaming a Chromium executable: build-graph and source review remain separate
requirements. Unsupported/missing operations must fail explicitly.

Only syntax and runner failure handling have been checked so far. The MVP app
has not passed on a built Weber binary because that binary does not exist yet.
Even this app passing would not prove every Chromium role or every Electron API
has been replaced; it is the first application-level acceptance floor.

## Full source baseline

`build_preflight.py` records actual memory/disk/tools and samples direct Chromium
source references. It does not replace GN's dependency graph or claim every
reference is an engine dependency requiring a rewrite.

`bootstrap_baseline.sh` checks out the exact workflow revision into the layout
required by Electron's DEPS, synchronizes its real dependencies, runs hooks and
generates the normal GN graph. Chromium is needed at this stage to establish and
validate the existing Electron baseline while its dependencies are removed.
It then compiles and runs the process-transport tests with Electron's actual GN
toolchain. This command does not compile the Electron application or replace
Chromium. The new GN target is a test target, not a BrowserWindow runtime switch.

The initial bootstrap failed at Yarn's immutable installation because moving
upstream workflows also moved their workspace manifest. The manifest has been
restored at `.github/workflows/package.json`; the unchanged upstream lockfile
now passes validation before downloading Chromium dependencies.

At commit `2993716559edff8ab2c7e06dc302904546d6c9b8`, the three standalone engine
and process tests passed in [run 34363011850](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34363011850).
The GN bootstrap is tracked separately in [run 34363012091](https://github.com/Hunter2030ZeRo/Weber/actions/runs/34363012091).
Its result must be checked before claiming GN compilation success.

The first hosted-runner check found 92.3 GB free. Removing the unused Android SDK
on the disposable runner increased this to 104.2 GB, meeting the documented
100 GB baseline threshold. That resource gate passing is not a successful build.

## Remaining product requirements

- Replace the native WebContents implementation and its internal frame IPC route.
- Replace Chromium-owned startup, navigation/session/storage/network roles and
  native surface/input integration as required by the supported application APIs.
- Implement real preload isolation, OS sandboxing and security behavior.
- Build and launch the actual application runtime, inspect the dependency graph,
  and exercise existing Electron apps without framework-specific source rewrites.
- Validate the broader agreed desktop features and compare equal workloads with
  Electron for memory, performance and rendering correctness.

Status remains MVP INCOMPLETE until the application runtime passes its stated
contracts and the build/dependency review supports the replacement claim.

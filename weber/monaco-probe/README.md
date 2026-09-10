# Original Monaco desktop diagnostic

This fixture bundles upstream `monaco-editor@0.52.2` with `esbuild@0.25.5`.
It loads the original editor API and editor worker without editing their source.
The source tag commit and every generated asset hash are recorded in the build
manifest. This standalone release is not claimed to be the exact Monaco revision
inside the pinned VS Code 1.136.2 distribution.

The same fixture runs on Electron and Weber. A normal Electron custom protocol
serves whitelisted local assets at `monaco://app/`; the probe does not relax
Obscura's private-network policy or substitute fake editor APIs.

After building Weber, install/build the fixture and run under an X11 display:

```sh
npm install --prefix weber/monaco-probe --ignore-scripts
node weber/monaco-probe/build.cjs
WEBER_UNSANDBOXED_DEVELOPMENT=1 WEBER_MONACO_RESULT=out/monaco-weber.json xvfb-run -a node weber/monaco-probe/run.cjs
WEBER_MONACO_ELECTRON=/absolute/path/to/electron WEBER_MONACO_RESULT=out/monaco-electron.json xvfb-run -a node weber/monaco-probe/run.cjs
```

The usual `WEBER_DESKTOP_HOST` and `WEBER_OBSCURA_RENDERER` overrides apply.
`xdotool` is required: input is sent through the actual X11 window, not replaced
with programmatic model edits. Both runs are unsandboxed development tests.

| Check | Electron | Weber at 56cfe40 |
| --- | --- | --- |
| Custom document and upstream editor construction | Pass | Pass |
| Model edit and undo | Pass | Pass |
| Native keyboard input | Pass | Pass |
| Visible line DOM and PNG capture | Pass | Pass |
| 1,000-line document; reveal line 700 and visible range | Pass | Pass |
| Original editor worker exchange and diff result | Pass | Fails: module `export` is parsed as a script |

[The recorded diagnostic](results/56cfe40.json) contains individual checks and
asset provenance. `coreEditingReady` records the initial editing checks.
`ready` requires every check, including worker-driven diff. `vscodeReady` stays
false because this fixture does not launch the workbench. PNG signature and line
DOM checks verify output exists; they do not establish pixel parity, IME,
selection, accessibility, syntax services or performance for the full editor.

The latest failure is `Editor worker: Unexpected token 'export'`. Both the
standard error listener and `onerror` property are observed because the pinned
shim misses error listeners when script evaluation fails. Errors remain visible
and fail the worker/diff check; collection success does not suppress them.

The pinned [Obscura Worker implementation](https://github.com/Hunter2030ZeRo/obscura-for-weber/blob/727cc46d56290995245fbe790caed52fc699452a/crates/obscura-js/js/bootstrap.js)
fetches source and evaluates it through a page-realm shim. It ignores module
options and does not create a dedicated worker isolate. A proper module loader,
separate worker execution, message copying/transfer and termination are required.
Removing module exports or falling back to page execution would not satisfy
that contract. This limitation is separate from VS Code's currently missing
`crashReporter`, utility-process and renderer MessagePort APIs.

The runner records failures as diagnostic evidence. A zero collection exit code
does not turn `ready: false` into an acceptance pass. CI uploads JSON and PNG
artifacts for both runtimes and imposes an overall process deadline.

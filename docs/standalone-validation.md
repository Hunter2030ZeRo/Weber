# Standalone AOT desktop validation

The approved standalone AOT milestone passed. Actual GNOME desktop Hangul/IME,
editing, focus, button activation and scrolling passed in both engines, along
with release relocation/ownership checks, fresh fixed compatibility regression,
and optimized performance measurements. This is a prototype milestone, not
complete browser conformance or achievement of the long-term low-memory goal.

Final source SHA-256:
`0d161bba2bcc6bdf0ad79392f5c4694b955342723e51f8ebd7fe03f7f387f45f`.
The final audit checks all five reports against that source and the pinned engine
revisions, and verifies the packaged executable and all 14 private-library hashes.
Evidence: [milestone audit](../artifacts/standalone-milestone.json).

Release bundle: `target/package/weber-release/`; launch `./weber` inside it.
Archive: `target/package/weber-linux-wayland-x86_64.tar.gz` (about 71 MiB).
Its `--web` flag selects the comparison desktop. The package contains notices,
local engine patches, and a manifest. No host installation was performed.

## Executed

- Debug and release builds completed. The release native platform/application
  units use O3; `manifest.json` records build source/revisions and library hashes.
- Complete shell/navigation and application UI are native Static Hermes AOT by
  default. The same Solid TSX component is compiled for SpiderMonkey with `--web`.
  AOT still uses Servo's SpiderMonkey DOM and a generic synchronous DOM adapter.
- The optimized Linux bundle contains an executable and 14 private libraries,
  approximately 221 MB before compression. Assets are embedded; runtime has no
  Vite/Node/build-tree dependency. It still needs compatible system glibc,
  Wayland/EGL/GPU drivers and fonts. See `scripts/package.py` and its manifest.
- A relocated copy launched with `/tmp` as cwd and DISPLAY/LD_LIBRARY_PATH/
  NODE_PATH unset. Both modes passed shell navigation/remount, counter, Unicode
  signal input and scroll callback checks. Initial UI values and the native
  bounds of shell/counter/input/scroll region were identical. This used direct
  DOM events, not native input. Evidence: `artifacts/standalone-smoke.json` and
  `standalone-{aot,web}.png/.jsonl`.
- Fresh fixed compatibility run: 17 locked original WPT files, 1,474 subtests
  each in actual Servo and native AOT; all 15 mandatory scenarios, build, types,
  lint and formatting passed. The fixed profile hash is unchanged. Evidence:
  `artifacts/compatibility-profile.json`. Earlier evidence is preserved in
  `artifacts/compatibility-profile-baseline.json`.
- Native standalone self-tests passed: browser DOM 30, Solid 7, scheduler 9,
  stateful AOT counter/independent runtime, and 5 new ownership tests. The latter
  verify unreachable listener/node cycles are collected while explicitly
  retained detached nodes keep their identity/listeners and can be reinserted.
  Evidence: `artifacts/standalone-self-tests.log`.
- Repeated renderer ownership test passed in both modes: 35 cohorts of 500
  detached element/text/listener cycles (5 warmup), retained-node reuse, then
  20 complete dispose/remount sessions. Disposed roots stay empty after a timer
  turn. AOT native handles and mirror wrappers remained 249, with 5 root native
  listeners; after disposal only the mount root remains and task/listener/fetch/
  ResizeObserver registries are empty. PSS and actual Hermes heap instrumentation
  are recorded at every checkpoint. Forced GC is part of this bounded workload;
  this is not a proof of freedom from all long-running leaks. Evidence:
  `artifacts/desktop-stress.json`.

Automated renderer checks ran on an isolated GNOME/Mutter 51.0 Wayland compositor
with a 960x720@60 virtual monitor, using the i915 render device. They do not
establish behavior of the locked physical display or its configured input method.
The helper uses a private bus/runtime/configuration and removes its temporary
compositor/files at exit.

## Native input and performance

The real desktop input test passed in both modes, including “가나다 ” with trusted
compositionstart/update/end, Latin typing, Ctrl-A, ArrowLeft, Backspace/Delete,
Tab/Shift-Tab, trusted Enter click, and PageDown/PageUp in the 140px region.
Evidence: `artifacts/desktop-input.json` and its native event traces.

The test exposed three actual integration/engine issues, now fixed and rebuilt:

1. A host-requested IME disable acknowledgement was treated as user dismissal,
   blurring the newly focused button. The host now shares expected IME visibility
   with its input handler, matching Servo's desktop embedder behavior.
2. Servo always marked keyboard-activated clicks untrusted. Its keyboard path
   now preserves the originating key event's trust; programmatic `.click()` and
   untrusted keyboard events keep their old untrusted behavior.
3. Servo calculated PageDown as container height minus 152px, producing a negative
   delta in short regions. Page movement now has a positive bounded minimum and
   PageUp is its negative. Existing large-page deltas are preserved.

The latter two changes are reproducible in `patches/servo-keyboard-click.patch`;
bootstrap applies it after the existing patches. All five local engine patches
pass reverse-application checks. Input observation now runs after the entire
event-dispatch task, since microtasks can run between native event listeners.

`scripts/desktop-input.mjs` sends OS key events through Mutter RemoteDesktop,
checks focus before typing, and restores the original Fcitx activation state.
It tests editing, Tab traversal, real Hangul composition/commit, Enter button
activation, and PageDown scrolling. The Python helper releases pressed keys and
stops the remote input session on exit. DOM-generated events do not satisfy
these tests. Human physical mouse/keyboard tests remain a separate scope.

`scripts/desktop-benchmark.mjs` requires an O3 release bundle. It alternates 12
warm-filesystem process starts per engine after one warmup each, samples
process-tree PSS/RSS 40 times, and measures 40 native Enter activations per
engine. Startup is Rust main entry to a post-ready native present, excluding ELF
loading. Input latency is OS input to the next distinct native present after the
DOM acknowledgement, not optical pixel latency. Frame intervals are native
present intervals, not display scan-out timestamps. GPU memory is excluded.
Both modes link the Hermes library; web does not instantiate a Hermes heap.
The resulting report identifies the display/build/sample distributions.
See [final performance results](performance.md) and
[raw measurements](../artifacts/desktop-benchmark.json).

The desktop session initially reported locked via `org.gnome.ScreenSaver.GetActive`
and rejected RemoteDesktop creation with `Session creation inhibited`. The user
unlocked it before the native test. No desktop unlock was performed by the
agent. The input helper temporarily inhibits automatic idle during its test
session and releases that inhibitor on exit. The final release native input test
passed after unlocking. A later benchmark attempt lost focus and correctly
stopped before sending keys to another window; its incomplete data was excluded.
The final retry completed all 40 native activations per engine.

The final isolated renderer suite also exited successfully after detaching only
its own temporary portal/GVfs FUSE mounts. It leaves the user's display, bus and
runtime directory in place. All functional reports and the benchmark now refer
to the same final source hash.

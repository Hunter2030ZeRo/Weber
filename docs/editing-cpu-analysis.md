# Native editing CPU investigation — 2026-10-23

Follow-up: [native composition range optimization](native-editing-range-optimization.md)
records the subsequent compiled engine change and its longer same-app comparison.
The shorter observer A/B measurements below remain their original workload.

The alpha.3 6.51% / 6.01% figures were **input-block averages**, where 100% is
one logical CPU, not peaks or whole-machine percentages. The correctness fixture
read `textContent`, `innerHTML`, descendant count and Selection state, serialized
them and called the host telemetry bridge on every key, composition, input and
selection event. Servo's `Selection.Stringifier` requests a synchronous
`layout_reflow(QueryMsg::StyleQuery)` before producing rendered selected text.
That request may reuse clean layout; it does not necessarily recalculate the
whole document. The old CPU result includes all this instrumentation.

## Controlled comparison

`scripts/editing-cpu-native.mjs` uses the installed SDK editing fixture and the
unchanged optimized alpha.3 SpiderMonkey JIT runtime. F2 toggles only per-event
DOM observation; native editing, undo, layout, paint, IME and caret code stay on.
Cheap event counters and native host telemetry remain enabled in both modes.
F11 snapshots validate the DOM and event counters outside each timed interval.
The correctness test still defaults to its full observer.

An owned Hyprland 0.56.2 headless output (960×720, scale 1), nested in private
Mutter, receives real Wayland virtual-keyboard keycodes through Fcitx5/libhangul.
The five-key cycle composes `가`, commits with space, deletes the space and then
the syllable. Keys are scheduled every 85 ms, held for 25 ms. The driver avoids
reading the growing event log on every timed key. It verifies compositor focus
at block boundaries; no other application is launched in that private session.

After 10 warmup cycles and 5 seconds of idle, eight 50-cycle blocks alternate in
the order observed / quiet / quiet / observed / quiet / observed / observed /
quiet, all in one process. Every block checks 50 composition ends, actual input
events, empty final text and at most one descendant element. It does not measure
physical key-to-pixel latency or prove every intermediate frame was presented.
Composition-update/selection-change counts can differ because protocol and DOM
events coalesce; those counts and input scheduling lateness are retained.

Process-tree CPU uses `/proc` user+system ticks. Thread attribution uses scheduler
runtime nanoseconds. The compositor, input method and driver are excluded.
Thread sampling itself runs outside the input loop, at the interval boundaries.
The test includes a 150 ms tail for pending input/render work. This is an
interactive, paced CPU workload, not a throughput benchmark or toolkit comparison.

## Reproduction

Prepare the pinned runtime, SDK tarballs and native test tools as described in
[the alpha.3 report](native-editing-alpha3.md). Build the fixture with the cached
SDK dependencies, optionally specifying a different existing npm cache:

```sh
WEBER_NPM_CACHE="$PWD/artifacts/npm-cache" node scripts/editing-workflow.mjs --installed
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/nested-hyprland.mjs \
  scripts/editing-cpu-native.mjs target/package/weber-clipboard-jit/weber
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS WEBER_CPU_PERF=1 dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/nested-hyprland.mjs \
  scripts/editing-cpu-native.mjs target/package/weber-clipboard-jit/weber
perf report -i artifacts/editing-cpu-perf.data --stdio --no-children
```

The cache override is optional; the workflow otherwise uses its usual cache.
An empty cache must be populated by installing the scaffold's pinned dependencies
before using the offline workflow. `WEBER_CPU_CYCLES=5` runs a short diagnostic,
not the 50-cycle measurement. `WEBER_CPU_PERF=1` instead runs a **separate**
100-cycle quiet diagnostic with 499 Hz user-space CPU-clock/DWARF sampling.
Perf launches its own Weber child; recording starts only after warmup/idle and
stops after the input block through its control FIFO. `--user-callchains` avoids
requesting kernel callchains. These samples are excluded from A/B summaries and
are written to `editing-cpu-profile.json`. Artifacts stay local.

The JSON report records runtime build identity, fixture build/asset hash, CPU
model/kernel, each block, thread attribution, input lateness and event counters.
The runtime remains the existing alpha.3 build; changing diagnostic scripts or
fixtures does not mean the runtime was rebuilt or made faster.

## Profiling result and optimization boundary

The final eight-block A/B passed on an Intel Core Ultra 9 185H (22 logical CPUs),
CachyOS kernel `7.3.0-3-cachyos`. The runtime source fingerprint was
`27287f7014241b42d865394d2fb1089dea2e45f17536a1ae807fcf1edbef3107`;
the built fixture's `web.js` SHA-256 was
`8fc458e37e0d38f233768c91dd905c57a59b70c5c7c57b452d157a4052a87eaa`.
The host and fixture hashes are recorded separately because the diagnostics
changed while the runtime remained the published alpha.3 build.

| Mode | Mean CPU | Block CPU range | Mean CPU ms per key tap |
| --- | ---: | ---: | ---: |
| Full correctness observer | 5.71% | 5.56–5.98% | 4.89 |
| Observer disabled | 3.17% | 2.99–3.50% | 2.72 |

Each block lasted about 21.42 seconds. In order, block CPU was 5.556%, 2.988%,
3.034%, 5.556%, 3.174%, 5.742%, 5.976%, 3.501%. All 400 composition cycles / 2,000
timed key taps passed the assertions. Scheduling lateness p95 was at most
0.37 ms across blocks; idle added zero CPU ticks over five seconds.

Turning off the observer reduced measured CPU by **2.53 percentage points /
44.4% relative** in this experiment. This isolates the combined DOM observation,
serialization and reporting workload, including scheduling/render side effects;
it does not attribute that whole difference to `Selection.toString()` alone.
It is a measurement correction, not a 44.4% engine optimization. Quiet CPU still
rose from 2.99% in its first block to 3.50% in its last; the short run does not
isolate the cause or establish a long-term plateau.

Validation of the diagnostic change also passed the installed-SDK offline fixture
build, SDK check, JavaScript syntax checks and all 12 existing Hyprland native
editing scenarios (including Hangul, Hanja, clipboard, cancellation and undo).
Rebuilding the fixture through the cached SDK workflow reproduced the same asset
hash. No Rust/Servo runtime source changed, and no new runtime build or broad
alpha release certification is claimed for this commit.

The separate 100-cycle quiet run passed: 500 paced OS key taps, 100 composition
ends, 700 `input` events, empty final text and zero descendant elements. CPU was
1,320 ms over 42.67 seconds (3.09% of one logical CPU). Input scheduling lateness
p95 was 0.34 ms. This is driver scheduling accuracy, **not input latency**.

The 499 Hz `cpu-clock:u` profile collected 421 user-space samples with zero lost
samples. Main-thread scheduler CPU was 618 ms, script-thread CPU 391 ms, render
backend 104 ms, clipboard 76 ms, scene builder 74 ms and constellation 53 ms.
These are thread runtime, not elapsed work or GPU execution time. The process
user+system CPU and user-only perf samples are different denominators.

| Sample location | User CPU samples |
| --- | ---: |
| Script thread, Weber/Servo binary | 41.33% |
| Main thread, Weber binary | 14.96% |
| Main thread, Mesa Gallium driver | 13.30% |
| WebRender backend, Weber binary | 6.89% |
| Main thread, libc | 5.94% |
| Scene builder, Weber binary | 4.04% |

The largest named self-time function was `Document::live_range_replace_data_steps`
at 3.09% of user samples (13 samples), followed by DOM rooting at 1.66%. This
small sample is a lead, not evidence that live ranges explain most input CPU.
The cost is distributed across script, host dispatch, allocation and rendering;
there is no measured single dominant JavaScript/JIT bottleneck here.

Further runtime optimization should isolate (1) live-Range count and update cost
over long editing sessions, (2) main-thread dispatch/paint frequency and driver
submission, and (3) history/context copying on larger documents. Range entries
are weak and cleaned during GC; the source alone does not prove a leak. Dropping
DOM range updates, IME messages or undo semantics based only on this profile
would not be a justified fix. No production runtime CPU improvement is claimed
by this diagnostic change. Neither telemetry-free production CPU, other GUI
toolkits, real-keyboard latency nor full Simulacrum has been measured here.

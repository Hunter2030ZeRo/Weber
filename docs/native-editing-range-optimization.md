# Native composition range optimization — 2026-10-23

This change targets the existing Linux/Wayland Servo/SpiderMonkey JIT path.
It does not add an app API, integrate Static Hermes, change the garbage collector
or remove DOM/IME/undo behavior.

## Implementation

Native IME replacement used to clone a tracking Range, delete its selected text,
collapse/recreate the active selection, insert the new text, recreate another
active Range and then allocate a preedit Range even for a completed composition.
Many of these short-lived live ranges stayed in the document's weak range list
until normal GC and were visited during subsequent CharacterData changes.

For a replacement wholly inside one Text node, the native path now calls
`CharacterData.ReplaceData` once and collapses the selection to the new UTF-16
end position. Standard live-range adjustment, mutation observers and DOM
invalidation still run. Insertion returns rooted start/end node positions, so
composition setup no longer needs a tracking clone or a newly materialized
selection Range. A preedit Range is allocated only for ongoing composition.

Selections spanning nodes and insertions into element containers retain Servo's
normal Range deletion/insertion behavior. The returned positions describe the
actual inserted Text node. The changed code is reproduced by the existing
ordered `servo-native-editing.patch`, rather than an untracked engine edit.

One replacement can produce one CharacterData mutation record instead of separate
deletion/insertion records. Native editing does not promise a particular count
of mutation records. Existing independently retained live ranges must still
track edits, and original node/listener identity and undo remain covered.

## Comparison method

The existing CPU probe adds an endurance mode: eight quiet blocks of 100 cycles,
all within one warmed process. Each cycle uses real OS keys to compose `가`,
commit with space, then delete the space and syllable. Keys are scheduled every
85 ms and held for 25 ms. There are 800 cycles / 4,000 timed key taps per run,
about 5.7 minutes of active input, plus startup/warmup/idle. There is no forced GC
or full DOM telemetry in the measured loop; cheap event counters and native host
telemetry remain. CPU is user+system time of the Weber process tree, where
100% means one logical CPU; compositor/Fcitx/driver processes are excluded.

Use the **same saved built fixture** for both binaries. The benchmark supports
`WEBER_CPU_APPLICATION` for this purpose; new correctness-fixture cases must not
silently change the app assets in a before/after CPU comparison. Preserve reports
and traces after each run because the next run replaces their default filenames.

```sh
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS WEBER_CPU_ENDURANCE=1 \
  WEBER_CPU_APPLICATION="$PWD/artifacts/editing-cpu-fixture-alpha3" \
  dbus-run-session -- node scripts/headless-wayland.mjs \
  scripts/nested-hyprland.mjs scripts/editing-cpu-native.mjs \
  target/package/weber-editing-range/weber
```

The output is `artifacts/editing-cpu-endurance.json`; the default non-endurance
observer A/B and separate perf diagnostic remain available. The fixture asset
SHA-256, build identity, per-block scheduling lateness, event counts, process
memory and thread CPU are retained in each report. The known fixture asset hash
is `8fc458e37e0d38f233768c91dd905c57a59b70c5c7c57b452d157a4052a87eaa`.

## Acceptance scope

Three targeted native scenarios extend the existing editing gate: replacement
beside an emoji while an external live Range is retained, replacement spanning
two styled nodes with original node identity/undo, and composition into a truly
empty element without placeholder elements. They use Fcitx/OS input, not a
JavaScript editor or synthetic composition events. The old binary passed these
tests before the optimized binary was built.

This remains one small editable page on an isolated Hyprland output nested in
private Mutter, not a complete Simulacrum session, a physical keyboard latency
measurement, all-day endurance or a clean-machine/whole-beta certification.
Sequential before/after runs do not control every host load, thermal or power
state; per-block samples within one process are not independent launches.
Performance wins must be stated for the actual workload and build only.

## Recorded build and endurance result

The optimized locked/offline release build succeeded. Its source fingerprint is
`5e0252e128bc32b97d39a46c9e16258f5a13248290f0be32031e99d665678a4a`,
matching the current source-fingerprint tool. The before runtime is the alpha.3
build `27287f7014241b42d865394d2fb1089dea2e45f17536a1ae807fcf1edbef3107`.
Both report SpiderMonkey, release, no native CPU optimization and no linked AOT.
The local candidate is `target/package/weber-editing-range/weber`; this is not a
new npm or binary release, or a re-certification of all alpha distribution gates.

The same fixture hash ran on Intel Core Ultra 9 185H / 22 logical CPUs, CachyOS
kernel `7.3.0-3-cachyos`, isolated Hyprland 0.56.2 at 960×720, scale 1.

| Metric | Before | After |
| --- | ---: | ---: |
| Mean CPU across eight 100-cycle blocks | 3.583% | 3.328% |
| CPU ms per compose/commit/delete cycle | 15.29 | 14.20 |
| First block CPU | 3.234% | 3.070% |
| Last block CPU | 3.960% | 3.609% |
| Last-block script thread CPU | 755 ms | 594 ms |
| Total process CPU during timed blocks | 12.23 s | 11.36 s |

That is **7.1% less process CPU in this workload**; the absolute difference is
about 0.255 percentage points of one logical CPU. It is not the earlier 44.4%
observer-cost correction, nor a general speed/latency claim. CPU still rises
within each run. Remaining dispatch, rendering, history/context work and longer
resource behavior are not solved by reducing these temporary ranges.

All 800 compositions / 4,000 timed key taps passed in each run. Paint-side caret
geometry reports were 200 per 100-cycle block in **both** runs (1,600 total),
with native composition ends and input events checked. Thus no missing caret
update count explains the lower CPU. This does not measure every displayed pixel
or physical input latency. Input scheduling lateness p95 stayed below 0.37 ms.

The uncontrolled endurance runs started at PSS 108.64 / 123.61 MiB and ended at
127.15 / 140.24 MiB respectively. Additional private memory was 18.50 / 16.62 MiB.
The smaller growth does **not** establish lower total memory or a plateau: the
optimized process had higher starting and ending PSS. Executable/cache-history
effects require a separate fresh-copy comparison; they cannot simply be assumed.

A separate GNOME control used the existing `residency-benchmark.mjs`: four
interleaved launches per runtime, copying the executable and all private
libraries to fresh inodes and reading/hashing them identically before each
launch. The same app was measured without typing. Launch PSS p50 was **111.88
MiB before / 112.20 MiB after** (about 0.33 MiB higher); executable RSS p50 was
76.49 / 76.96 MiB. The large starting difference did not reproduce under this
control. This is a different compositor and no-typing workload; it does not
isolate the entire reason for the earlier Hyprland difference, prove a memory
win, or establish a long-run heap plateau. All eight short idle CPU samples
added zero CPU ticks, meaning below the accounting resolution.

Reproduction:

```sh
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS \
  WEBER_REPORT_PREFIX=editing-range-residency- dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/residency-benchmark.mjs \
  target/package/weber-clipboard-jit/weber target/package/weber-editing-range/weber \
  artifacts/editing-cpu-fixture-alpha3
```

Validation passed: 28 Rust host tests, Clippy (existing upstream warnings remain),
the installed-SDK fixture build, and 15 Hyprland / 14 GNOME native editing
scenarios. The 13 existing Hyprland form/window/IME scenarios also passed,
including real Solid Workbench Hangul typing, Ctrl+S and restart persistence.
Ordered application of 11 Servo patches reproduces all 44 affected
files. Hanja remains a Hyprland-specific gate. Physical keyboards, full rich
editing, GPU recovery, multi-output integration and all-day endurance remain
outside this increment's acceptance.

Raw local records: `editing-range-before.json`, `editing-range-after.json`, their
`.jsonl` traces, `editing-range-comparison.json`, `editing-range-after-hyprland.json`,
`editing-range-after-gnome.json`, and build/test/Clippy logs under `artifacts/`.
The broader IME record is `editing-range-after-ime-hyprland.json`.
The memory control is `editing-range-residency-benchmark.json` and its eight
per-launch `.smaps` files.

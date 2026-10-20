# Optimized desktop comparison — 2026-10-19

The current AOT path uses more memory and starts slower than the identical
SpiderMonkey application. Input/presentation timings are similar in this run.
This establishes a working measured prototype; it does not establish a
low-memory or startup advantage for this two-runtime design.

| Metric | Static Hermes native AOT | SpiderMonkey UI |
| --- | ---: | ---: |
| Startup median | 232.35 ms | 191.31 ms |
| Startup p95 | 253.65 ms | 199.06 ms |
| Process-tree PSS median | 162.17 MiB | 132.88 MiB |
| Process-tree RSS median | 210.54 MiB | 181.10 MiB |
| Input-to-next-present proxy median | 13.22 ms | 13.48 ms |
| Input-to-next-present proxy p95 | 16.35 ms | 16.79 ms |
| Native presentation interval median | 8.30 ms | 8.30 ms |
| Native presentation interval p95 | 8.92 ms | 8.83 ms |

AOT added approximately 41 ms to median startup and 29.29 MiB to median PSS.
The small input difference is not sufficient evidence of a speedup. There was
no Electron comparison. The native presentation cadence is approximately 120 Hz;
these are buffer-submission observations, not optical display measurements.

## Workload and method

- Same executable, embedded assets, shared Solid TSX shell/application and
  requested 960x720 logical window size; real GNOME desktop Wayland session.
  Animation runs while samples are taken. Web does not initialize a Hermes heap,
  but the same binary still links/loads the Hermes runtime library.
- Rust, C/C++ and both native AOT units use release/O3 settings. Servo DOM remains
  SpiderMonkey in both modes; AOT additionally uses its mirror DOM and synchronous
  adapter. This is a comparison of complete paths, not isolated JS engine speed.
- One warmup start per engine, then 12 starts each with alternating engine order.
  Startup is Rust main entry to the first distinct native present after app
  readiness/two animation frames. ELF loading is excluded. Filesystem caches
  were warm; this is not a cold-cache benchmark.
- Forty process-tree `/proc/*/smaps_rollup` samples per engine, 200 ms apart after
  a one-second warmup. No forced GC in this measurement. PSS/RSS do not establish
  total GPU allocation size.
- Forty native Enter activations per engine through GNOME Mutter RemoteDesktop.
  The owned window's focus is checked before input. All activations changed the
  real counter and produced trusted native clicks. Timing ends at the next
  distinct native present after the post-dispatch DOM acknowledgement. An older
  in-flight scene can affect this proxy; it is not exact input-to-visible-pixel
  latency. Callback observation itself uses a zero-delay task after dispatch.
- Presentation distributions contain 1,751 AOT and 1,752 web intervals after app
  readiness. They include animation and the input workload. Percentiles use
  nearest rank; no statistical confidence or long-term reliability is claimed.

Hardware: Intel Core Ultra 9 185H; Mesa Intel Arc Graphics (MTL), OpenGL 4.6 /
Mesa 26.2.4-arch3.1; Linux 7.2.11-1-cachyos x86_64; GNOME/Mutter 51.0. Toolchain:
Rust 1.99.0 (`b940084d7`, 2026-09-28), GCC 16.2.1 (20260810).

## Ownership checks are separate

The release stress run uses forced GC in both engines and a separate isolated
GNOME Wayland virtual display. It creates/removes 35 cohorts of 500 element/text
nodes with listener cycles, verifies an explicitly retained detached node, and
performs 20 complete dispose/remount sessions. AOT live wrappers and native
handles stayed at 249; its Hermes heap reservation stayed 12 MiB. The last 20
mutation cohorts changed PSS by +928 KiB for AOT and +328 KiB for web, below the
predefined 16 MiB tail-growth bound. This finite workload is not a universal
proof against leaks. Pending-task cancellation is also covered by the fixed
profile's native Solid scheduling/disposal scenario.

## Provenance and reproduction

Final source:
`0d161bba2bcc6bdf0ad79392f5c4694b955342723e51f8ebd7fe03f7f387f45f`.
Packaged executable:
`edcb7448f4fd0655f60a8f51d5b85f7dd478929064ba88313cedd9eeacaead98`.
Servo `aac43a3f31a259f04a574f5ec4e959c943ad7cc7` and Hermes
`17b37301da5da4a2cd55d78f9697c46c0fd96123`, with tracked local patches.

Run from the Weber source workspace in an unlocked GNOME session:

```sh
node scripts/desktop-benchmark.mjs target/package/weber-release/weber
```

Keep the owned test window focused during input sampling. The helper restores
the original Fcitx activation state and releases its temporary idle inhibitor.
Human physical keyboard/mouse behavior is separate from these OS-injected tests.

[Raw distributions and per-start traces](../artifacts/desktop-benchmark.json),
[ownership checkpoints](../artifacts/desktop-stress.json),
[native input evidence](../artifacts/desktop-input.json), and
[final source/package audit](../artifacts/standalone-milestone.json).

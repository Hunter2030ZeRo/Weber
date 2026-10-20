# Wayland window activation

Linux Wayland / JIT, SDK 0.5.0. Native build capability: `activationProtocol: 1`.
This increment adds no public SDK method and makes no focus guarantee.

## Host behavior

- Read `XDG_ACTIVATION_TOKEN` once and pass it to the initial window through the
  pinned winit 0.30.13 `WindowAttributesExtStartupNotify` API. Do not reuse it on
  later windows. No process-wide environment mutation or unsafe environment
  reset is needed after threads start.
- Exclude both `XDG_ACTIVATION_TOKEN` and `DESKTOP_STARTUP_ID` when spawning the
  optional Bun backend. Its own children cannot accidentally reuse the host's
  one-shot launch identifiers.
- Set the Wayland application identity from the packaged app ID, with
  `dev.weber.Preview` for the built-in screen.
- For an SDK `openWindow` requested from a focused source, request a fresh token
  using winit's actual asynchronous API. Match `ActivationTokenDone` by source
  native window **and** request serial before creating the destination window.
- Unfocused sources and unavailable protocol support use ordinary creation.
  A pending request has a 750 ms deadline; expiration proceeds without a token.
  Late unmatched token events are ignored. The compositor always decides focus.
- Pending entries occupy the existing 16-window budget. Canceling an opening
  window removes the entry even before it has a native handle. Closing or
  navigating its requesting document invalidates the delayed request.
- Capture the source document generation when the native command is submitted,
  rather than when the UI thread later handles it. This also rejects queued
  commands from a previous document. Failed-window pruning and close remove
  document-generation entries, avoiding an accumulating history of old IDs.
- Only pending activation requests schedule a deadline. Normal idle windows
  retain event-loop `Wait`; there is no activation polling thread or periodic
  idle timer. Existing coalesced window snapshots report observed focus.

`openWindow()` still resolves when creation is ready, not after paint or focus.
If a new independent window has already been created when its parent closes,
the child stays alive. In-flight work from a closed document must not create a
new window later. These are distinct lifetime cases.

## Validation

`activation-workflow.mjs` compiles a real Vite/Solid/TypeScript application and
Bun backend through the checkout SDK. `activation-native.mjs` runs it in an
isolated GNOME Wayland session. A separate GTK application mints a launch token
after receiving an OS F8 event; the token travels only through the private test
pipe and is not written to test reports.

The native check observes initial-window and child-window focus without using
post-launch activation helpers. F6 opens a child from an OS key event; F10 closes
it. The backend reports that neither launch environment variable was inherited.
Concurrent open/close does not resurrect a closed window. Parent close preserves
an already-created independent child, which is then closed through OS input;
last-window shutdown reaps the backend. Focus telemetry now identifies its
window, so a different window's old focus event cannot satisfy these assertions.

The first test assumptions incorrectly required every open to remain pending
until the following SDK call and every parent close to cancel an already-created
child. Native traces showed creation completed first. The final test records
`stateAtClose`, allows the existing independent-child contract, and still
rejects late creation after owner close and duplicate/resurrected windows.
`stateAtClose` is the SDK snapshot immediately before close submission, not a
measurement at host-side close processing. Even an `opening` snapshot can race
with token completion before close arrives. Deterministic coverage of the
pending-token cancellation branch is therefore not claimed by this test.

A host unit regression checks queued commands against a navigation generation,
isolation of another document and bounded tracking across 100 failed opens.
Actual navigation/token races, forced token timeout, absent-protocol fallback,
malicious focus-stealing resistance, other compositors and physical Korean IME
remain separate native checks. GTK/virtual keyboard validation does not replace
physical input or establish Windows/macOS support.

Reproduction after release build and runtime packaging:

```sh
node scripts/activation-workflow.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/activation-native.mjs target/package/weber-clipboard-jit/weber
```

Local evidence: `artifacts/activation-native.json`, its `.jsonl` trace,
`activation-workflow.json` and `preview-rust-tests.log`. The normal installed-SDK
and package acceptance checks remain required; this fixture itself uses the
checkout SDK.

## Final acceptance record

Final JIT source:
`a2d0b2663008b2b421d96b78ef23d0dac03db4f18ed9f6f5536da509736aff58`.
The release build, 20 host Rust tests, project Clippy and formatting pass. The
nine Servo patches and 318 prepared Stylo files still match their pinned source.
Engine implementation and pins are unchanged by this increment; AOT and the
full historical browser/WPT profile were not revalidated here.

All eight preview-audit gates pass on that source: document/portal preview,
browser clipboard shortcuts, SDK clipboard/GTK exchange, installed npm workflow,
packaged native execution/HMR, 50 and 200 window lifetimes, and the separate
activation check. The audit also verifies installed SDK files, tarball hashes,
runtime executable/private libraries and ordinary Notes assets. The shipped
Notes assets contain no test probe. No npm publication or release is performed.

The preview retry exposed GTK save-name selection preserving the `.txt` suffix,
which made the old automatic input write `output.txt.txt`. The test helper now
selects explicit entry boundaries with Home / Shift+End. It retains the original
exact filename/content and 256 KiB overwrite assertions; this changes test input,
not file-dialog behavior in the framework.

In a separate quiescent eight-launch comparison with fresh file copies, normal
Notes PSS medians are 113.19 MiB for the preceding font build and 113.47 MiB for
this build; ranges are 112.96–118.82 and 112.88–113.99 MiB. Median spawn → DOM-ready
is 204.55 → 206.71 ms. The short idle windows record no CPU ticks at 10 ms
resolution. These small samples show no large initial-memory penalty here;
they establish neither a performance improvement nor all-day stability.
Raw data: `artifacts/activation-residency-benchmark.json`.

The separate unchanged built-in animated/input/scroll screen records 231.27 ms
median spawn → first native app presentation over 12 warm-file launches
(211.39–252.01 ms). Forty trusted OS Enter updates give 25.38 ms median and
33.21 ms p95 from the host event to the native presentation following DOM
acknowledgement. These are not physical/optical input latencies.
An eight-second animated sample uses 14.13% of one logical CPU core and
126.34 MiB process-tree PSS median; compositor and external GPU costs are
excluded. This is a different workload from static Notes and a baseline screen,
not evidence of a CPU saving. Raw data: `artifacts/activation-desktop-benchmark.json`.

# Native text clipboard — SDK 0.3.2

Applications use JavaScript/TypeScript; the Rust host owns the platform connection.
The Notes template includes **Copy note** and **Paste** buttons using this API:

```ts
import { readText, writeText } from '@weber/sdk/clipboard';

await writeText('Hello from Weber 👋');
const text = await readText();
```

The native host must advertise `clipboardProtocol: 1` in `--build-info`.
This implementation uses the regular Wayland `wl_data_device` protocol on
winit's existing display connection. It does not use X11, shell clipboard
commands, a clipboard-manager protocol, Node.js or Bun.

## Contract

- `readText(): Promise<string>` reads the system text selection. Empty contents
  produce an empty string; unsupported text formats, invalid UTF-8, oversized
  contents and transfer failures reject the promise.
- `writeText(text): Promise<void>` offers text to other applications. Resolution
  means submission to the compositor, not an acknowledgment of a future paste.
  Wayland has no selection-set acknowledgment.
- The calling native window must have focus and the app must have the existing
  native capability. This is a trusted application API, not a browser permission
  prompt or a replacement for the web Clipboard API's user-activation policy.
- Text is limited to 8192 UTF-8 bytes. Writes reject NUL and non-string values.
  Both the SDK and native host validate writes; the native reader caps data while
  receiving it, rather than allocating the complete external payload first.
- At most 16 application requests may be pending. Results and cancellation belong
  to the originating window. Closing/navigating that window releases its results;
  cancellation discards results and does not roll back an already issued write.
- Pipe transfers and initialization waits have 3-second deadlines. SDK calls have
  a 10-second outer deadline. Reads and outgoing pipe writes are nonblocking on a
  worker; the UI does not wait for another application's clipboard transfer.
- Selection contents are served while the host is alive. Availability after exit
  depends on the desktop clipboard manager; Weber does not promise persistence.

One worker registers the data device before the first native window is created.
This avoids missing the first selection on Mutter, where selection offers are
sent when client focus changes. The initialization barriers wait for registry,
seat/device and keyboard setup before showing the window. This ordering follows
the [Mutter data-device implementation](https://github.com/GNOME/mutter/blob/main/src/wayland/meta-wayland-data-device.c).
Initialization failure stops host startup with an error rather than silently
returning an in-process clipboard. The worker sleeps on file-descriptor readiness
when idle; SDK polling exists only while a request is pending. App shutdown joins
the worker before releasing an owned display guard; this matters because winit's
`run_app` consumes the event loop. Focus changes use generation-tagged compositor
barriers before accepting reads, so a new focus cannot use an earlier selection.

## Scope

Linux Wayland text only. Primary selection, images, rich text, clipboard change
notifications, Windows and macOS backends are not implemented. The worker tracks
up to 8 seats and bounds offers/transfers; multi-seat and hotplug behavior still
need compositor testing.

`navigator.clipboard`, DOM clipboard events and standard browser copy/cut/paste
shortcuts are not redirected to this SDK yet. Servo's default clipboard delegate
remains separate. AOT runtime integration has not been validated for this API.

The native window's initial DOM focus now follows actual window focus instead of
being forced on at creation. Native focus remains the authority for SDK access.

## Reproduce

Prepare the current JIT runtime in `target/package/weber-clipboard-jit`, then:

```sh
node scripts/clipboard-workflow.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/clipboard-native.mjs
```

The GTK4/PyGObject peer is a separate process using GDK's clipboard API. The test
compositor has a private bus, display and temporary desktop profile; its Welcome
dialog is suppressed so it cannot steal focus. The user's desktop profile is
not changed. GTK uses the Wayland backend and Cairo renderer. Focus changes and
test actions use Mutter's virtual keyboard inside this private display.

The harness checks Notes Paste from GTK and Copy note to GTK, Korean/emoji and
multiline text, an 8192-byte escaped write, oversized external reads, malformed
writes, native request limits, invalid capability, background denial, recovery,
idle worker ticks and clean last-window shutdown. Rust tests separately check
request ownership, cancellation, nonblocking pipe reads, invalid UTF-8 and stalled
transfer expiration. These are distinct from physical input, other compositors,
full browser clipboard compatibility and performance comparisons.

After creating the local npm SDK tarball, use
`node scripts/clipboard-workflow.mjs --installed` to compile the same fixture with
the installed SDK rather than the source SDK. Native results are recorded in
`artifacts/clipboard-native.json`; the full trace and peer events remain local.

## Recorded result

The default JIT release compiled with `--release --locked --offline`; the optional
`layer-shell` feature also compiled. All 9 Rust tests passed, as did project
Clippy with warnings denied and formatting checks.

The installed SDK 0.3.2 passed the independent GTK ↔ Weber clipboard harness,
including the transfer limits and a zero-exit-code final-window shutdown. The
clipboard worker accumulated 0 CPU ticks during the harness's 2-second idle
sample; that is a finite-resolution thread measurement, not a whole-app CPU
result. The existing external npm install/check/build/package/relocation gates
and native Notes persistence, second window and Vite HMR gates also passed.

Verified source fingerprint:
`886718e544a46b78332048856c44b53fe394ec7d6b95e23aea1ad27cc0b688c7`.
`artifacts/clipboard-audit.json` checks that source identity against the runtime,
native result and npm artifacts, compares every installed SDK file with its
source, and verifies packaged executable, library and application asset hashes.
The normal Notes package is `target/package/weber-notes-npm`; test-instrumented
applications are kept separately. No new startup/memory advantage or AOT result
is claimed by this increment.

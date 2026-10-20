# Linux application preview milestone

This is the SDK 0.4.0 validation snapshot. Current document limits, portal
parenting and repeated lifecycle coverage are recorded in the
[SDK 0.5.0 foundation increment](linux-foundation-05.md).

Target: a Linux Wayland developer preview suitable for small notes, settings and
list applications written in HTML/CSS/JS/TS. This is not a completed cross-platform
beta or a claim of full browser/Electron compatibility.

Acceptance criteria:

1. Native textarea/input copy, cut and paste interoperate with an independent
   application. Failed or oversized default cuts preserve the selected text.
   Consecutive clipboard writes do not discard the last offered contents.
2. JS/TS applications can open and save UTF-8 text through the desktop file
   chooser, with cancellation, bounded transfers, explicit errors and safe
   replacement of selected files. No Node/Bun process is required for this API.
3. App errors and rejected promises have a visible diagnostic. Closing a window
   can be intercepted for unsaved changes; closing the last window terminates
   the host and releases pending native work.
4. The Notes example exercises file open/save and unsaved changes. Installed
   SDK/runtime packages pass native scenarios and existing multiwindow,
   persistence, Vite HMR, relocation and package-integrity checks.
5. Release build, meaningful Rust tests, formatting and project Clippy pass.
   Source identity, produced packages and native test results are recorded.

Contenteditable editing, rich clipboard formats, arbitrary browser permissions,
accessibility, physical Korean IME, output hotplug, installers/signing, clean-OS
bootstrap, Windows/macOS and Hermes-only DOM remain explicit subsequent scope.
Default execution remains Servo/SpiderMonkey JIT. No AOT improvement is assumed.

Status: acceptance criteria completed for SDK/runtime 0.4.0 on 2026-10-20.

## Recorded acceptance

| Gate | Result |
| --- | --- |
| Default input/textarea editing | Native virtual Ctrl+C/X/V with independent GTK; trusted events, custom copy, prevented paste, read-only controls, oversized cut preservation and recovery passed |
| Text files | Actual FileChooser portal open/save, explicit Cancel, invalid UTF-8 and oversized input rejection, 256 KiB escaped overwrite and AbortSignal passed |
| Lifecycle and diagnostics | Native Alt+F4 keep/discard, chooser-active final close, uncaught JS/rejected promises, and a real Servo screenshot of a startup failure passed |
| Existing SDK clipboard | Limits, ownership/cancellation checks, consecutive writes with one input serial, background denial, recovery and clean final close passed |
| Installed distribution | External npm install/check/build/package, relocation, integrity/rejection cases, two native launches without Node/Bun on PATH, Notes persistence/multiwindow and actual Vite HMR passed |
| Project checks | Release build, 13 Rust tests, project Clippy with warnings denied, formatting, JS syntax and diff checks passed |
| Servo patches | All seven patches apply in bootstrap order to the pinned clean source; all 14 touched files match the compiled checkout byte-for-byte |

Final source fingerprint:
`4f7b51b50090f4793823e55f9b500c3a79a083602710329e9eafecc98f861dc1`.
Servo remains `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`.
The default release advertises JIT-only SpiderMonkey, no AOT unit ABI, and file,
close-request, diagnostics and safe-cut protocols at version 1. The normal Notes
bundle is `target/package/weber-notes-npm`; local npm tarballs are SDK/runtime
0.4.0 under `target/npm`. They are not published to npm or GitHub Releases.

The final native runs use the installed SDK. The GTK FileChooser backend is
selected only in a private test profile inside GNOME headless Wayland, with a
private bus and virtual keyboard. App button/input setup is programmatic;
chooser navigation and native close/clipboard shortcuts use OS input injection.
The initial default GNOME/Nautilus chooser attempt failed to initialize its
accessibility service in that isolated environment and is not counted as a
passing backend. GTK backend coverage does not establish KDE/Nautilus coverage.

The clipboard thread accumulated 0 CPU ticks over its two-second idle sample.
This is a finite-resolution thread sample, not whole-app CPU or a new startup,
memory, Electron comparison or AOT performance result. The earlier locked WPT
profile was not rerun; these targeted native scenarios do not establish complete
browser or arbitrary Electron compatibility.

## Evidence and reproduction

Local reports are `artifacts/preview-native.json`,
`clipboard-browser-native.json`, `clipboard-native.json`,
`npm-distribution.json`, `npm-distribution-native.json` and
`preview-patches.json`. The error screenshot is
`artifacts/preview-error-capture.png`. These generated artifacts remain local.
`node scripts/preview-audit.mjs` verifies that all five integration results and
local npm runtime share the current source fingerprint, checks tarball hashes
and installed SDK bytes, and validates the normal Notes executable, private
libraries and application asset hashes. It also rejects test instrumentation in
the normal bundle. Its result is `artifacts/preview-audit.json`.

After building and preparing the default JIT host in
`target/package/weber-clipboard-jit` and creating local npm artifacts:

```sh
node scripts/preview-workflow.mjs --installed
node scripts/clipboard-workflow.mjs --installed
node scripts/npm-distribution-smoke.mjs
WEBER_TEST_FILE_CHOOSER=gtk dbus-run-session -- node scripts/headless-wayland.mjs scripts/preview-native.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/clipboard-native.mjs --browser
dbus-run-session -- node scripts/headless-wayland.mjs scripts/clipboard-native.mjs
dbus-run-session -- node scripts/headless-wayland.mjs scripts/npm-distribution-native.mjs
```

Run native suites sequentially. The tests own their temporary windows, files,
bus, profile and helper processes; they do not operate the user's desktop.

## Remaining scope

The chooser currently has no exported Wayland parent, so strict owner modality,
placement and activation remain unfinished. Clipboard/app-store values still
have an 8 KiB limit; file contents have a 256 KiB limit. Default contenteditable
editing, rich clipboard formats, full web Clipboard API permissions, physical
keyboard/IME, accessibility, output changes, process/GPU recovery, prolonged
stability, clean-OS bootstrap, installers/signing, Windows/macOS and AOT are not
accepted by this milestone. This completes the stated Linux preview target,
not a production-ready or cross-platform beta.

# Text files and application lifecycle — SDK 0.5.0

```ts
import { openTextFile, saveTextFile } from '@weber/sdk/files';
import { onCloseRequested } from '@weber/sdk/window';

const file = await openTextFile(); // { name, text }, or null on chooser cancel
if (file) await saveTextFile(file.text, file.name);
const stop = onCloseRequested(async () => await askWhetherToDiscardChanges());
// Call stop() when disposing the component which owns this handler.
```

This increment targets Linux Wayland. The Rust host uses
[XDG FileChooser](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileChooser.html)
and [Request](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html)
over D-Bus. It subscribes to the request response before issuing the chooser call
to avoid losing an immediate response. The selected local URI is validated and
converted by the host; app code receives a display name and file contents,
without arbitrary path-based filesystem access. No Node/Bun process is needed.

## File contract

- A calling native app window must be open and focused to start the chooser.
  Polling/cancellation remain available after the chooser takes focus.
- One worker serializes chooser/file operations. At most four requests/results
  may be retained across windows. Results, cancellation and cleanup belong to
  the requesting window. Close/navigation cancels its outstanding requests.
- Open accepts one local regular file, rejects final-component symlinks and
  non-regular paths, bounds reading before decoding, and rejects invalid UTF-8.
  Maximum file content is 262144 UTF-8 bytes. Images and binary files are outside
  this text API. No encoding conversion is inferred.
- Save validates the same byte limit and a suggested basename. The native
  chooser selects the destination. The host creates a private sibling temporary
  file exclusively, writes and syncs it, preserves existing file permissions,
  then renames it over the selected destination. Errors before replacement leave
  the original intact; a pre-existing temporary name is never deleted.
- Chooser cancellation returns `null`. Other failures reject. `AbortSignal`
  rejects with `AbortError` and closes the portal request. Cancellation cannot
  undo a replacement already issued to the filesystem.
- D-Bus method calls have a 3-second timeout, initial connection a 5-second
  deadline, active chooser a 120-second deadline, and SDK request a 125-second
  outer deadline. Queued requests can time out/cancel before becoming active.
- JSON requests are capped at the worst-case escaped 256 KiB text size. Storage/clipboard starts have their own bounded data contracts; window and
  backend control messages retain their smaller limits. SDK polling runs only while a
  request is pending; no file work runs while idle.
- The host exports the actual calling toplevel through xdg-foreign v2 (v1
  fallback) and passes `wayland:<handle>` as the portal parent. Exports last for
  that window's lifetime and are destroyed before its native surface. No handle
  supplied by application JavaScript is trusted. Compositors without xdg-foreign
  keep the empty-parent fallback. A bounded handshake runs during window creation,
  with no extra thread or idle timer. Explicit activation tokens and strict
  modality across all portal backends remain unverified. See the official
  [window identifier contract](https://flatpak.github.io/xdg-desktop-portal/docs/window-identifiers.html).
  Portals/backend availability are desktop prerequisites; this API is not a
  general filesystem API or a complete app sandbox.
- Replacement is atomic for observers on the same filesystem. Directory sync,
  crash/power-loss durability, external-edit conflict detection and saving
  through final symlinks are not promised by this preview.

## Close decisions and diagnostics

`onCloseRequested` registers one async handler per window. Return `true` to allow
close. Any other result or a thrown error preserves the window. Repeated native
or SDK close requests coalesce while a decision is pending. A generation and
request token prevent a stale/other-window response from closing a window.
Unsubscribe cancels an outstanding decision; later close requests proceed
normally. Closing a different window invokes that destination's handler.

Packaged apps load diagnostics before their entry script. Vite development
injects the same script before modules. Uncaught errors, failed resources and
unhandled rejections display the latest bounded plain-text diagnostic, with
Dismiss and Close buttons. Mount failures keep the app open for inspection;
explicit automated app-test mode still reports failure and exits. This is a JS
diagnostic, not recovery from a Rust panic, GPU crash or terminated Servo thread.

The Notes template includes file open/save, app-store save/reload, native text
clipboard and a discard decision. Busy operations and open discard decisions
disable editing. The app-store accepts 1 MiB of encoded JSON per value; the text-file API
supports 256 KiB of UTF-8. Saving a file does not replace the independent app-store note.

## Verification

Acceptance results are recorded in the milestone report after native execution.
Prepared-checkout entrypoints are `scripts/preview-workflow.mjs` (optionally
`--installed`) and `scripts/preview-native.mjs` under `headless-wayland.mjs`.
The test display/bus/profile are private and no input reaches the user's desktop.

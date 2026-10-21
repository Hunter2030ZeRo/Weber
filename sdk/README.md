# Weber SDK 0.6.0-alpha.3 (local developer alpha)

The SDK is an npm development dependency. Vite compiles the HTML/CSS/JS UI;
the separate native runtime embeds Servo and SpiderMonkey. Node/npm are build
tools, not prerequisites for the packaged JIT application.

This version is not published to npm. Install the local SDK tarball and, on
Linux x64, the local `@weber/runtime-linux-x64` tarball. No install scripts or
runtime downloads are used. `WEBER_SDK_SPEC=file:/absolute/path/to/sdk.tgz`
must select that tarball when creating a project with `weber init PROJECT workbench`.
Generated TypeScript paths resolve from that project's `node_modules`.

`@weber/sdk/clipboard` exports asynchronous `readText()` and `writeText(text)`.
It requires native `clipboardProtocol: 1` and a focused app window. Text is
limited to 256 KiB of UTF-8 text; writes reject NUL. This API uses the system
clipboard. Native hosts advertising `browserClipboardProtocol: 1`
also connect Servo's normal textarea/input copy/cut/paste shortcuts and clipboard
events to that same system clipboard without app shortcut handlers. This SDK
module does not polyfill `navigator.clipboard`; full web Clipboard API permission
semantics and contenteditable default paste remain outside the verified scope.
See the source repository's `docs/clipboard.md`.

`@weber/sdk/files` exports `openTextFile(options?)` and
`saveTextFile(text, suggestedName?, options?)`. Both ask the desktop file chooser;
cancel returns `null`. Open returns `{ name, text }`, save returns `{ name }`.
The Linux host requires `fileDialogProtocol: 1` and a working FileChooser portal.
UTF-8 files are limited to 256 KiB. `options.signal` cancels a pending request.
Hosts with `fileDialogParentProtocol: 1` export the calling Wayland window
through xdg-foreign v2/v1 and pass its identifier to the chooser. Compositors
without that protocol retain the unparented fallback.
The host performs file I/O and atomic replacement, without a Node/Bun runtime.

`@weber/sdk/storage` accepts values up to 1 MiB of encoded JSON, with 128 keys
and a 16 MiB quota per area. Queued/in-flight request payloads share a 4 MiB
budget and 32 pending slots; cancellation does not undo an issued write.

`onCloseRequested(async () => boolean)` from `@weber/sdk/window` intercepts native
and SDK close requests. Return `true` to close or `false` to keep editing; thrown
errors preserve the window. Keep one handler per window and call its returned
unsubscribe function on component cleanup. No handler means normal immediate
close. Packaged and Vite apps display uncaught JavaScript errors and unhandled
promise rejections in a dismissible diagnostic panel.

See `docs/linux-preview-milestone.md` for acceptance criteria and verification
boundaries. Contenteditable, cross-platform backends and Hermes-only DOM are
not included in this Linux preview target.

Project commands: `npm run dev`, `npm run check`, `npm run build`,
`npm start`, and `npm run package`. The final command produces `package/weber`,
private libraries, notices and `application/`. Launch `./weber --app ./application`
from that directory. Packaging verifies the runtime and application hashes.
`WEBER_HOST` explicitly overrides the installed runtime with a prepared bundle.

Runtime packages currently support Linux x64 with a compatible glibc loader,
Wayland compositor, system GPU/EGL drivers and fonts. Windows and macOS
packaging are not implemented. This local distribution is a developer alpha, not a beta release;
clean-machine compatibility and a complete third-party license audit remain.

Static Hermes AOT is experimental and requires the Weber source checkout and
its native toolchain. It still uses Servo's SpiderMonkey DOM adapter; a
Hermes-only DOM engine is not included. The local npm SDK defaults to JIT.

`@weber/sdk/system` exports `getSystemInfo()`, `refreshSystemInfo()`,
`onSystemChanged(listener)`, `openExternal(url, options?)`,
`showNotification(title, body?, options?)` and `dismissNotification(handle)`.
These require native `appIntegrationProtocol: 1`. System snapshots include
OS/architecture, displays and explicit capabilities; watches coalesce changes
without an idle timer. Refresh explicitly after an unused display is hotplugged.
Display names/coordinates are compositor metadata, not stable IDs or window
position permissions. Notification/external-URL capabilities describe host API
support; the desktop service must also exist.

`openExternal` allows http/https/mailto, rejects credentials and requires a focused
window. `true` means successful portal handoff, `null` user cancellation; it does
not prove a page loaded. `{ ask: true, signal }` requests a chooser and supports
cancellation. Notifications are plain text with no actions: title 1..256 UTF-8
bytes, body at most 4096 bytes, eight handles/window, 64/app. Requested expiry is
10s; handles are pruned after 30s on subsequent service work. Dismiss and
window-close cleanup are best effort; expired handles may reject dismissal.
Each service has eight pending slots and its own lazy worker, so a URL chooser
does not block notifications. Aborting cannot undo an already issued action.

Window additions: `setWindowDecorations`, `minimizeWindow`,
`requestWindowAttention`, `beginWindowDrag` and `beginWindowResize`.
Drag/resize must run in a real left-mouse-down handler on the focused window;
synthetic DOM events do not grant permission. The compositor ultimately decides
whether to honor requests. Wayland provides no reliable minimized query here
(`minimized: null`), force restore, arbitrary show/hide, absolute positioning or
always-on-top. `openWindow({ decorations, resizable })` applies creation options.

`workbench` is the integrated app template. It includes notes, text open/save,
clipboard, unsaved-close decisions, Ctrl+S/Ctrl+Shift+S/Ctrl+O/Ctrl+N, window
controls and a system inspector. Packaged apps include `<app-id>.desktop`.
After moving a bundle, run `weber launcher /absolute/bundle /output/app.desktop`
to generate a new launcher; the output must not already exist. Install it yourself
using the app ID filename. This command does not modify your desktop profile.

## Korean input (0.6.0-alpha.3)

Standard HTML `input`, `textarea` and basic `contenteditable="true"` use the compositor's IME through Wayland
text-input-v3. No Weber-specific text widget or IME API is needed. The runtime
preserves composition across focus handoff and handles an empty preedit when
the last Hangul jamo is deleted; readonly fields reject editing. Password fields
request the password input purpose. App shortcut handlers should respect
`KeyboardEvent.isComposing`. See [Korean IME acceptance](../docs/korean-ime.md)
for the earlier form-control milestone. The [alpha.3 editing report](../docs/native-editing-alpha3.md) records Hyprland/Fcitx reconversion, native selection/clipboard/undo and the remaining rich-editor limits.

# Weber SDK (local preview)

The SDK is an npm development dependency. Vite compiles the HTML/CSS/JS UI;
the separate native runtime embeds Servo and SpiderMonkey. Node/npm are build
tools, not prerequisites for the packaged JIT application.

This version is not published to npm. Install the local SDK tarball and, on
Linux x64, the local `@weber/runtime-linux-x64` tarball. No install scripts or
runtime downloads are used. `WEBER_SDK_SPEC=file:/absolute/path/to/sdk.tgz`
must select that tarball when creating a project with `weber init PROJECT notes`.
Generated TypeScript paths resolve from that project's `node_modules`.

`@weber/sdk/clipboard` exports asynchronous `readText()` and `writeText(text)`.
It requires native `clipboardProtocol: 1` and a focused app window. Text is
limited to 8192 UTF-8 bytes; writes reject NUL. This API uses the system
clipboard. Native hosts advertising `browserClipboardProtocol: 1`
also connect Servo's normal textarea/input copy/cut/paste shortcuts and clipboard
events to that same system clipboard without app shortcut handlers. This SDK
module does not polyfill `navigator.clipboard`; full web Clipboard API permission
semantics and contenteditable default paste remain outside the verified scope.
See the source repository's `docs/clipboard.md`.

Project commands: `npm run dev`, `npm run check`, `npm run build`,
`npm start`, and `npm run package`. The final command produces `package/weber`,
private libraries, notices and `application/`. Launch `./weber --app ./application`
from that directory. Packaging verifies the runtime and application hashes.
`WEBER_HOST` explicitly overrides the installed runtime with a prepared bundle.

Runtime packages currently support Linux x64 with a compatible glibc loader,
Wayland compositor, system GPU/EGL drivers and fonts. Windows and macOS
packaging are not implemented. This local distribution is not a beta release;
clean-machine compatibility and a complete third-party license audit remain.

Static Hermes AOT is experimental and requires the Weber source checkout and
its native toolchain. It still uses Servo's SpiderMonkey DOM adapter; a
Hermes-only DOM engine is not included. The local npm SDK defaults to JIT.

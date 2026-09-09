# Obscura desktop extensions

The checked-in patches apply to the submodule pinned at
`727cc46d56290995245fbe790caed52fc699452a`. Apply them from the
Electron checkout before building `weber-engine`:

```sh
git -C weber/vendor/obscura apply --check ../../patches/obscura/0001-desktop-raw-frame.patch
git -C weber/vendor/obscura apply ../../patches/obscura/0001-desktop-raw-frame.patch
```

`0001-desktop-raw-frame.patch` adds `Page::render_frame_rgba()` and the
corresponding runtime method. It calls Obscura's existing retained painter,
including the resource cache, resolved scroll state and canvas surfaces. It
moves the resulting pixmap bytes out without PNG encoding or decoding. The
existing PNG screenshot API remains available for `capturePage` diagnostics.

The `captureFrame` engine command returns `OBF1`, a little-endian 32-bit width,
a little-endian 32-bit height, and tightly packed premultiplied RGBA8 pixels.
The 12-byte header is included in the 64 MiB reply limit. Dimensions follow
the CSS viewport at scale 1; device-scale rasterization is not implemented
by this transport yet. Cairo ARGB32 consumers on little-endian platforms
must swap red and blue; the alpha channel is already premultiplied.

`0003-frame-invalidation.patch` adds a generation-based capture checkpoint.
Apply it after `0001` (it also applies after `0002`). The
`captureFrameIfChanged` engine command returns an empty successful response
when the document is unchanged, otherwise the same OBF1 frame. This skips
layout, rasterization and frame-buffer copying before they happen; it does
not hash rendered frames. Existing DOM, canvas, scroll and image activity
generations drive invalidation, with an added resource/font generation bump
so a CSSOM flush cannot lose pending presentation damage. Navigation,
viewport and surface changes invalidate the checkpoint. CSS and Web
Animations keep repainting until their active interval ends. Timer handling
continues independently in the renderer process. This removes redundant
static painting; it does not remove the renderer's event-loop wakeups.

`real-obscura-frame-invalidation` checks idle frame suppression, DOM changes,
timer-driven changes, resizing, canvas repaint, same-URL navigation and CSS
animation completion against the actual C ABI engine.

The input adapter in `weber-engine/src/desktop.rs` derives from the pinned
Obscura CDP input implementation under Apache-2.0. There is no separate
native input dispatcher in the pinned `Page` API. The adapter uses the same
trusted DOM event helpers as CDP, with request validation, execution deadlines,
mouse movement, focus, keyboard modifiers and cancelled key default actions.
It does not provide IME composition, touch, pointer capture, full hover event
sequences or complete contenteditable keyboard editing. These are explicit
desktop integration gaps rather than silently successful no-op commands.

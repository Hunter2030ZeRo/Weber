# Layer panel edges

The Linux layer-shell host accepts `WEBER_PANEL_EDGE=top|left` for `--panel-app`.
The default remains `top` (48 logical pixels). `left` uses 64 logical pixels and
anchors top/bottom/left, reserving that width from the compositor's work area.
Keyboard interactivity remains `None`; applications open an ordinary window for
keyboard/IME input. Compositor configure events determine the stretched dimension.

`--build-info` exposes `layerPanelEdges: ["top", "left"]` in builds with the
`layer-shell` feature. Unsupported values are rejected. The standalone layer probe
continues to use the top 48px surface and does not inherit the panel edge setting.

This is a Linux/Wayland embedding capability, not a portable dock API. Output
selection, arbitrary edges/thickness and transparent/blurred surfaces remain
separate work. Simulacrum's development runner and panel command select `left`;
the normal launcher retains its existing keyboard/IME window lifecycle.

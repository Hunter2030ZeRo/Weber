"""Owned GTK4 clipboard peer; only runs inside the isolated Wayland test display."""
import json
import os
import sys
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, GLib, Gio

if not os.environ.get("WEBER_TEST_DISPLAY", "").startswith("isolated GNOME"):
    raise SystemExit("Use the isolated Wayland harness")

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

app = Gtk.Application(application_id="dev.weber.ClipboardPeer", flags=Gio.ApplicationFlags.NON_UNIQUE)

def activate(application):
    window = Gtk.ApplicationWindow(application=application, title="Weber clipboard test peer")
    window.set_default_size(400, 220)
    window.set_child(Gtk.Label(label="Independent GTK clipboard test peer"))
    clipboard = window.get_display().get_clipboard()
    window.connect("notify::is-active", lambda *_: emit({"focus": window.is_active()}))
    window.connect("map", lambda *_: emit({"mapped": True, "focus": window.is_active()}))
    GLib.timeout_add(1000, lambda: emit({"mapped": window.get_mapped(), "visible": window.get_visible(), "focus": window.is_active()}))

    def command(_source, condition):
        line = sys.stdin.readline()
        if not line:
            application.quit()
            return False
        value = json.loads(line)
        request = value["id"]
        if value["op"] == "write":
            clipboard.set(value["text"])
            def submitted():
                window.get_display().sync()
                emit({"id": request, "ok": True})
                return False
            GLib.idle_add(submitted)
        elif value["op"] == "read":
            def complete(obj, result):
                try:
                    emit({"id": request, "text": obj.read_text_finish(result)})
                except Exception as error:
                    emit({"id": request, "error": str(error)})
            clipboard.read_text_async(None, complete)
        elif value["op"] == "stop":
            application.quit()
        elif value["op"] == "focus":
            window.present()
            emit({"id": request, "ok": True})
        return True
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command)
    window.present()
    emit({"ready": True})

app.connect("activate", activate)
app.run(None)

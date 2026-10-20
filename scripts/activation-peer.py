"""Mint a launch token from fresh input in an owned GTK Wayland window."""
import json
import os
import sys
import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, Gdk, Gio, GLib

if not os.environ.get("WEBER_TEST_DISPLAY", "").startswith("isolated GNOME"):
    raise SystemExit("Use the isolated Wayland harness")

def emit(value):
    print(json.dumps(value), flush=True)

app = Gtk.Application(application_id="dev.weber.ActivationPeer", flags=Gio.ApplicationFlags.NON_UNIQUE)

def activate(application):
    window = Gtk.ApplicationWindow(application=application, title="Weber activation test peer")
    window.set_default_size(400, 220)
    window.set_child(Gtk.Label(label="F8: authorize the owned Weber test launch"))
    window.connect("notify::is-active", lambda *_: emit({"focus": window.is_active()}))
    controller = Gtk.EventControllerKey()
    def key_pressed(controller, keyval, _keycode, _state):
        if keyval != Gdk.KEY_F8:
            return False
        context = window.get_display().get_app_launch_context()
        context.set_timestamp(controller.get_current_event_time())
        info = Gio.AppInfo.create_from_commandline("/usr/bin/true", "Weber test", Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION)
        # The token is sent only to this test's pipe, never to public logs.
        emit({"token": context.get_startup_notify_id(info, [])})
        return True
    controller.connect("key-pressed", key_pressed)
    window.add_controller(controller)
    def command(_source, _condition):
        line = sys.stdin.readline()
        if not line or json.loads(line).get("stop"):
            application.quit()
            return False
        return True
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command)
    window.present()
    emit({"ready": True})

app.connect("activate", activate)
app.run(None)

#!/usr/bin/env python3
"""GNOME compositor input injection for the owned Weber test window, never DOM events."""
import json
import os
import sys
import xml.etree.ElementTree as ET
from gi.repository import Gio, GLib

connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
destination = "org.gnome.Mutter.RemoteDesktop"
session_interface = "org.gnome.Mutter.RemoteDesktop.Session"

def request(path, interface, method, arguments=None):
    return connection.call_sync(destination, path, interface, method, arguments, None, Gio.DBusCallFlags.NONE, 5000, None)

session = request("/org/gnome/Mutter/RemoteDesktop", destination, "CreateSession").unpack()[0]
xml = request(session, "org.freedesktop.DBus.Introspectable", "Introspect").unpack()[0]
methods = {method.attrib["name"]: method for method in ET.fromstring(xml).findall(f"./interface[@name='{session_interface}']/method")}

def call(method, *values):
    spec = methods[method]
    signature = "(" + "".join(arg.attrib["type"] for arg in spec.findall("arg") if arg.attrib.get("direction", "in") == "in") + ")"
    return request(session, session_interface, method, GLib.Variant(signature, values))

pressed_keys = set()
pressed_buttons = set()
idle_cookie = None
pointer_stream = None
try:
    if "--describe" in sys.argv:
        print(xml, flush=True)
    else:
        try:
            idle_cookie = connection.call_sync("org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "Inhibit",
                GLib.Variant("(susu)", ("weber.native-tests", 0, "Temporary Weber native input verification", 8)), None, Gio.DBusCallFlags.NO_AUTO_START, 3000, None).unpack()[0]
        except GLib.Error:
            pass
        if os.environ.get("WEBER_TEST_ABSOLUTE_POINTER") == "1":
            if not os.environ.get("WEBER_TEST_DISPLAY", "").startswith("isolated GNOME"):
                raise RuntimeError("Absolute pointer setup requires the private test display")
            identity = connection.call_sync(destination, session, "org.freedesktop.DBus.Properties", "Get",
                GLib.Variant("(ss)", (session_interface, "SessionId")), None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
            screen = "org.gnome.Mutter.ScreenCast"
            cast = connection.call_sync(screen, "/org/gnome/Mutter/ScreenCast", screen, "CreateSession",
                GLib.Variant("(a{sv})", ({"remote-desktop-session-id": GLib.Variant("s", identity)},)), None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
            pointer_stream = connection.call_sync(screen, cast, screen + ".Session", "RecordMonitor",
                GLib.Variant("(sa{sv})", ("", {})), None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
        call("Start")
        print(json.dumps({"ready": True, "backend": "GNOME Mutter RemoteDesktop; OS input injection"}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            if command.get("stop"):
                break
            if "keycode" in command:
                call("NotifyKeyboardKeycode", int(command["keycode"]), bool(command["pressed"]))
                if command["pressed"]:
                    pressed_keys.add(int(command["keycode"]))
                else:
                    pressed_keys.discard(int(command["keycode"]))
            elif "keysym" in command:
                call("NotifyKeyboardKeysym", int(command["keysym"]), bool(command["pressed"]))
            elif "axis" in command:
                call("NotifyPointerAxis", float(command["axis"][0]), float(command["axis"][1]), 1)
            elif "motion" in command:
                call("NotifyPointerMotionRelative", float(command["motion"][0]), float(command["motion"][1]))
            elif "point" in command:
                if pointer_stream is None:
                    raise ValueError("Absolute pointer stream was not initialized")
                call("NotifyPointerMotionAbsolute", pointer_stream, float(command["point"][0]), float(command["point"][1]))
            elif "button" in command:
                call("NotifyPointerButton", int(command["button"]), bool(command["pressed"]))
                if command["pressed"]:
                    pressed_buttons.add(int(command["button"]))
                else:
                    pressed_buttons.discard(int(command["button"]))
            else:
                raise ValueError("Unsupported compositor input command")
            print(json.dumps({"ok": True, "command": command}), flush=True)
finally:
    for button in pressed_buttons:
        try:
            call("NotifyPointerButton", button, False)
        except GLib.Error:
            pass
    for code in pressed_keys:
        try:
            call("NotifyKeyboardKeycode", code, False)
        except GLib.Error:
            pass
    try:
        call("Stop")
    except GLib.Error:
        pass
    if idle_cookie is not None:
        try:
            connection.call_sync("org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "Uninhibit",
                GLib.Variant("(u)", (idle_cookie,)), None, Gio.DBusCallFlags.NO_AUTO_START, 3000, None)
        except GLib.Error:
            pass

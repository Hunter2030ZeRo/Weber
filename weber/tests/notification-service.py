"""Integration peer for the real private-host-to-session-D-Bus transport.

This is a test desktop service, not the runtime notification implementation.
Run inside dbus-run-session; owns no existing user's desktop service name.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from gi.repository import Gio, GLib

SERVICE = 'org.freedesktop.Notifications'
OBJECT = '/org/freedesktop/Notifications'
XML = '''<node><interface name="org.freedesktop.Notifications">
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/>
<arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
</interface></node>'''
loop = GLib.MainLoop()
records = []
errors = []
child = None
exit_code = 1
started = time.monotonic()
root = Path(__file__).resolve().parents[2]

def method(connection, sender, path, interface, name, parameters, invocation):
    try:
        values = parameters.unpack()
        if name == 'Notify':
            app, replace, icon, title, body, actions, hints, timeout = values
            index = len([r for r in records if r['method'] == 'Notify'])
            assert title == ['First', 'Second', 'Third'][index], title
            assert replace == (0 if index == 0 else 7), replace
            assert body == 'Text &lt; &amp; &gt;', body
            assert actions == ['default', 'Open'], actions
            assert hints['urgency'] == 0 and hints['suppress-sound'] is True, hints
            assert timeout == 0, timeout
            records.append({'method': name, 'title': title, 'replaceId': replace})
            invocation.return_value(GLib.Variant('(u)', (7,)))
            if index == 0:
                def click():
                    connection.emit_signal(sender, OBJECT, SERVICE, 'ActionInvoked', GLib.Variant('(us)', (7, 'default')))
                    return False
                GLib.timeout_add(20, click)
        else:
            assert name == 'CloseNotification' and values == (7,), values
            records.append({'method': name})
            connection.emit_signal(sender, OBJECT, SERVICE, 'NotificationClosed', GLib.Variant('(uu)', (7, 3)))
            invocation.return_value(GLib.Variant('()', ()))
    except Exception as error:
        errors.append(str(error))
        invocation.return_dbus_error('org.weber.TestFailure', str(error))

def acquired(connection, name):
    global child
    connection.register_object(OBJECT, Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], method, None, None)
    child = subprocess.Popen([sys.argv[1], str(root / 'weber/electron-runtime/bootstrap.cjs'),
                              str(root / 'weber/electron-runtime/notification-fixture')], start_new_session=True)

def poll():
    global exit_code
    if child and child.poll() is not None:
        exit_code = child.returncode
        loop.quit()
        return False
    if time.monotonic() - started > 25:
        errors.append('Integration timeout')
        loop.quit()
        return False
    return True

owner = Gio.bus_own_name(Gio.BusType.SESSION, SERVICE, Gio.BusNameOwnerFlags.NONE,
                        None, acquired, None)
GLib.timeout_add(50, poll)
loop.run()
if child:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
Gio.bus_unown_name(owner)
assert exit_code == 0 and not errors and len(records) == 4, (exit_code, errors, records)
print(json.dumps({'kind': 'native-notification-dbus-protocol', 'passed': True, 'records': records}))

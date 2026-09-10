"""Private D-Bus login1/UPower peers; idle time still comes from the real X server."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from gi.repository import Gio, GLib

LOGIN = 'org.freedesktop.login1'
POWER = 'org.freedesktop.UPower'
SESSION = '/org/freedesktop/login1/session/test'
root = Path(__file__).resolve().parents[2]
loop = GLib.MainLoop()
child = None
owned = set()
scheduled = False
battery = True
sent = False
exit_code = 1
started = time.monotonic()
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

def emit_events():
    global battery, sent
    battery = False
    bus.emit_signal(None, '/org/freedesktop/UPower', 'org.freedesktop.DBus.Properties',
                    'PropertiesChanged', GLib.Variant('(sa{sv}as)', (POWER, {'OnBattery': GLib.Variant('b', False)}, [])))
    for sleeping in [True, False]:
        bus.emit_signal(None, '/org/freedesktop/login1', LOGIN + '.Manager', 'PrepareForSleep', GLib.Variant('(b)', (sleeping,)))
    for name in ['Lock', 'Unlock']:
        bus.emit_signal(None, SESSION, LOGIN + '.Session', name, GLib.Variant('()', ()))
    sent = True
    return False

def get_property(connection, sender, path, interface, name):
    global scheduled
    if name == 'OnBattery':
        if not scheduled:
            scheduled = True
            GLib.timeout_add(100, emit_events)
        return GLib.Variant('b', battery)
    if name == 'LockedHint':
        return GLib.Variant('b', False)
    return None

def method(connection, sender, path, interface, name, args, invocation):
    invocation.return_value(GLib.Variant('(o)', (SESSION,)))

def register(path, xml):
    info = Gio.DBusNodeInfo.new_for_xml('<node>' + xml + '</node>').interfaces[0]
    bus.register_object(path, info, method, get_property, None)

register('/org/freedesktop/login1', '''<interface name="org.freedesktop.login1.Manager">
<method name="GetSessionByPID"><arg type="u" direction="in"/><arg type="o" direction="out"/></method>
<signal name="PrepareForSleep"><arg type="b"/></signal></interface>''')
register(SESSION, '''<interface name="org.freedesktop.login1.Session"><property name="LockedHint" type="b" access="read"/>
<signal name="Lock"/><signal name="Unlock"/></interface>''')
register('/org/freedesktop/UPower', '''<interface name="org.freedesktop.UPower"><property name="OnBattery" type="b" access="read"/></interface>''')

def acquired(connection, name):
    global child
    owned.add(name)
    if len(owned) == 2:
        environment = dict(os.environ, DBUS_SYSTEM_BUS_ADDRESS=os.environ['DBUS_SESSION_BUS_ADDRESS'])
        child = subprocess.Popen([sys.argv[1], str(root / 'weber/electron-runtime/bootstrap.cjs'),
                                  str(root / 'weber/electron-runtime/power-fixture')], env=environment, start_new_session=True)

def poll():
    global exit_code
    if child and child.poll() is not None:
        exit_code = child.returncode
        loop.quit()
        return False
    if time.monotonic() - started > 25:
        loop.quit()
        return False
    return True

owners = [Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, acquired, None) for name in [LOGIN, POWER]]
GLib.timeout_add(50, poll)
loop.run()
if child:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
for owner in owners:
    Gio.bus_unown_name(owner)
assert exit_code == 0 and sent, (exit_code, sent)
print(json.dumps({'kind': 'native-power-dbus-protocol', 'passed': True}))

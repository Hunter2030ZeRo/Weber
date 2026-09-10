"""Controlled desktop services over real D-Bus and Weber's native transport.

No real machine sleep or display power state is changed by this test.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from gi.repository import Gio, GLib

backend, scenario = sys.argv[1:3]
assert scenario in {'gnome', 'fallback', 'missing', 'failure', 'downgrade', 'lost', 'crash', 'host-crash', 'late'}
root = Path(__file__).resolve().parents[2]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
child = None
owners = {}
owned = set()
active = {}
records = []
pending = 0
weak_attempts = 0
next_cookie = 100
started = time.monotonic()
exit_code = None
temporary = tempfile.TemporaryDirectory(prefix='weber-inhibitor-test-')
assertion_file = Path(temporary.name) / 'host-exit-assertion.json'
GNOME = 'org.gnome.SessionManager'
POWER = 'org.freedesktop.PowerManagement'
SCREEN = 'org.freedesktop.ScreenSaver'
names = [] if scenario == 'missing' else [POWER, SCREEN] + ([] if scenario == 'fallback' else [GNOME])

def vanish():
    Gio.bus_unown_name(owners.pop(GNOME))
    records.append({'event': 'service-lost'})
    return False

def method(connection, sender, path, interface, name, parameters, invocation):
    global next_cookie, pending, weak_attempts
    service = GNOME if interface == GNOME else SCREEN if interface == SCREEN else POWER
    if name == 'Inhibit':
        args = parameters.unpack()
        mode = args[3] if service == GNOME else 8 if service == SCREEN else 4
        assert args[0] == 'weber-power-save-fixture', args
        if service == GNOME:
            assert args[1] == 0 and mode in [4, 8], args
        if mode == 4:
            weak_attempts += 1
        if (scenario == 'failure' and mode == 8) or (scenario == 'downgrade' and mode == 4 and weak_attempts > 1):
            records.append({'event': 'denied', 'service': service, 'mode': mode, 'held': len(active)})
            invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'Owned test denial')
            return
        cookie = next_cookie
        next_cookie += 1
        active[(sender, cookie)] = (service, mode)
        records.append({'event': 'acquire', 'service': service, 'mode': mode, 'cookie': cookie, 'held': len(active)})
        if scenario == 'late' and service == GNOME:
            pending += 1
            def reply():
                global pending
                invocation.return_value(GLib.Variant('(u)', (cookie,)))
                pending -= 1
                records.append({'event': 'late-reply', 'held': len(active)})
                return False
            GLib.timeout_add(1100, reply)
        else:
            invocation.return_value(GLib.Variant('(u)', (cookie,)))
        if scenario == 'lost' and service == GNOME:
            GLib.timeout_add(50, vanish)
    else:
        cookie = parameters.unpack()[0]
        lease = active.pop((sender, cookie), None)
        records.append({'event': 'release', 'service': service, 'cookie': cookie, 'valid': lease is not None, 'held': len(active)})
        invocation.return_value(GLib.Variant('()', ()))

def register(path, interface, gnome=False):
    parameters = '<arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/>' if gnome else '<arg type="s" direction="in"/><arg type="s" direction="in"/>'
    release = 'Uninhibit' if gnome else 'UnInhibit'
    xml = f'<node><interface name="{interface}"><method name="Inhibit">{parameters}<arg type="u" direction="out"/></method><method name="{release}"><arg type="u" direction="in"/></method></interface></node>'
    info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
    bus.register_object(path, info, method, None, None)

register('/org/gnome/SessionManager', GNOME, True)
register('/org/freedesktop/PowerManagement/Inhibit', POWER + '.Inhibit')
register('/org/freedesktop/ScreenSaver', SCREEN)

def changed(connection, sender, path, interface, name, parameters):
    unique, old, new = parameters.unpack()
    if unique.startswith(':') and old and not new:
        for key in list(active):
            if key[0] == unique:
                service, mode = active.pop(key)
                records.append({'event': 'disconnect', 'service': service, 'mode': mode, 'cookie': key[1], 'held': len(active)})

subscription = bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                                    '/org/freedesktop/DBus', None, Gio.DBusSignalFlags.NONE, changed)

def launch():
    global child
    child = subprocess.Popen([backend, str(root / 'weber/electron-runtime/bootstrap.cjs'),
                              str(root / 'weber/electron-runtime/power-save-fixture')],
                             env=dict(os.environ, WEBER_INHIBIT_CASE=scenario, WEBER_INHIBIT_ASSERTION_FILE=str(assertion_file)), start_new_session=True)

def acquired(connection, name):
    owned.add(name)
    if len(owned) == len(names):
        launch()

def poll():
    global exit_code
    if child and child.poll() is not None:
        exit_code = child.returncode
        if not active and not pending:
            loop.quit()
            return False
    if time.monotonic() - started > 18:
        loop.quit()
        return False
    return True

for name in names:
    owners[name] = Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, acquired, None)
if not names:
    launch()
GLib.timeout_add(25, poll)
try:
    loop.run()
finally:
    if child:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    bus.signal_unsubscribe(subscription)
    for owner in owners.values():
        Gio.bus_unown_name(owner)

expected = -signal.SIGKILL if scenario == 'crash' else 1 if scenario == 'host-crash' else 0
if scenario == 'host-crash':
    # Exit 1 is expected, but an assertion failure also exits 1. Require proof
    # that the ownership assertion actually ran before the fatal host handler.
    assert assertion_file.is_file(), records
    assert json.loads(assertion_file.read_text()) == {'ownershipInvalidated': True}
temporary.cleanup()
assert exit_code == expected and not active and not pending, (scenario, exit_code, active, records)
assert all(record['valid'] for record in records if record['event'] == 'release'), records
acquisitions = [record for record in records if record['event'] == 'acquire']
if scenario in ['gnome', 'fallback']:
    assert [record['mode'] for record in acquisitions] == [4, 8, 4, 8], records
    assert [record['held'] for record in acquisitions] == [1, 2, 2, 1], records
    assert len([record for record in records if record['event'] == 'release']) == 4, records
    assert all((record['service'] == GNOME) == (scenario == 'gnome') for record in acquisitions), records
elif scenario in ['failure', 'downgrade']:
    assert all(record['held'] == 1 for record in records if record['event'] == 'denied'), records
    assert len(acquisitions) == (1 if scenario == 'failure' else 2), records
elif scenario == 'missing':
    assert not acquisitions, records
elif scenario == 'lost':
    assert [record['service'] for record in acquisitions] == [GNOME, POWER], records
    assert any(record['event'] == 'disconnect' and record['service'] == GNOME for record in records), records
elif scenario == 'late':
    assert [record['service'] for record in acquisitions] == [GNOME, POWER], records
    assert any(record['event'] == 'late-reply' and record['held'] == 0 for record in records), records
elif scenario == 'host-crash':
    assert any(record['event'] == 'disconnect' for record in records), records
else:
    assert len(acquisitions) == 1, records
print(json.dumps({'kind': 'native-power-save-protocol', 'backend': backend, 'scenario': scenario, 'passed': True,
                  'acquisitions': len(acquisitions), 'remainingLeases': len(active), 'physicalSleepTested': False}))

"""Real Unix-FD logind protocol on an isolated bus; never shuts down the machine.

Run under dbus-run-session and xvfb-run. An optional host path tests the
production native transport without the engine; omission runs the full runtime.
"""
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
import traceback
from gi.repository import Gio, GLib

LOGIN = 'org.freedesktop.login1'
PATH = '/org/freedesktop/login1'
root = Path(__file__).resolve().parents[2]
backend = sys.argv[1]
host = str(Path(sys.argv[2]).resolve()) if len(sys.argv) > 2 else None
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
active = {}
records = []
mode = 'normal'
owner = None
owner_ready = threading.Event()
failure = []
children = []

def method(connection, sender, path, interface, name, parameters, invocation):
    if name == 'GetSessionByPID':
        invocation.return_dbus_error('org.freedesktop.login1.NoSessionForPID', 'No session in isolated fixture')
        return
    args = parameters.unpack()
    assert args[0] == 'shutdown' and args[3] == 'delay' and args[1] and args[2], args
    records.append(('request', mode))
    if mode == 'denied':
        invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'Fixture denial')
        return
    if mode == 'invalid':
        invocation.return_value(GLib.Variant('(h)', (42,)))
        return
    read_fd, write_fd = os.pipe()
    active[read_fd] = sender
    records.append(('acquire', read_fd))
    def released(fd, condition):
        active.pop(fd)
        os.close(fd)
        records.append(('release', fd))
        return False
    GLib.io_add_watch(read_fd, GLib.IO_HUP | GLib.IO_ERR, released)
    def reply():
        fds = Gio.UnixFDList.new()
        handle = fds.append(write_fd)
        os.close(write_fd)
        invocation.return_value_with_unix_fd_list(GLib.Variant('(h)', (handle,)), fds)
        records.append(('reply', read_fd))
        return False
    if mode == 'late':
        GLib.timeout_add(1400, reply)
    else:
        reply()

xml = '''<node><interface name="org.freedesktop.login1.Manager">
<method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="h" direction="out"/></method>
<method name="GetSessionByPID"><arg type="u" direction="in"/><arg type="o" direction="out"/></method>
<signal name="PrepareForShutdown"><arg type="b"/></signal></interface></node>'''
bus.register_object(PATH, Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], method, None, None)

def own():
    global owner
    owner_ready.clear()
    owner = Gio.bus_own_name_on_connection(bus, LOGIN, Gio.BusNameOwnerFlags.NONE,
                                          lambda *args: owner_ready.set(), None)

def on_main(function):
    done = threading.Event()
    def invoke():
        try:
            function()
        finally:
            done.set()
        return False
    GLib.idle_add(invoke)
    assert done.wait(3), 'main context stalled'

def wait_for(predicate, description, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError((description, list(active), records))

def prepare(value):
    bus.emit_signal(None, PATH, LOGIN + '.Manager', 'PrepareForShutdown', GLib.Variant('(b)', (value,)))
    bus.flush_sync(None)

class Client:
    def __init__(self):
        env = dict(os.environ, DBUS_SYSTEM_BUS_ADDRESS=os.environ['DBUS_SESSION_BUS_ADDRESS'])
        fixture = root / 'weber/electron-runtime/shutdown-fixture/main.cjs'
        if host:
            env['WEBER_POWER_MONITOR_HOST'] = host
            command = [backend, str(fixture)]
        else:
            command = [backend, str(root / 'weber/electron-runtime/bootstrap.cjs'), str(fixture.parent)]
        self.process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, bufsize=1, start_new_session=True)
        children.append(self.process)
        self.messages = []
        self.serial = 0
        def read():
            for line in self.process.stdout:
                try:
                    value = json.loads(line)
                    if value.get('shutdownFixture'):
                        self.messages.append(value)
                except (ValueError, AttributeError):
                    pass
        threading.Thread(target=read, daemon=True).start()
        wait_for(lambda: any(m.get('ready') for m in self.messages), 'client ready')
    def command(self, action, **values):
        self.serial += 1
        self.process.stdin.write(json.dumps(dict(id=self.serial, action=action, **values)) + '\n')
        self.process.stdin.flush()
        if action not in ['crash', 'host-crash']:
            wait_for(lambda: any(m.get('reply') == self.serial for m in self.messages), action)
    def add(self, name='handler', **values):
        self.mark = len(self.messages)
        self.command('add', name=name, **values)
    def acquired(self):
        wait_for(lambda: len(active) == 1 and any(m.get('status', {}).get('active') for m in self.messages[self.mark:]), 'FD acquired')
    def fired(self, name):
        wait_for(lambda: any(m.get('fired') == name for m in self.messages), 'shutdown listener fired')
    def quit(self):
        self.command('quit')
        assert self.process.wait(timeout=4) == 0
        wait_for(lambda: not active, 'no leases after quit')

def tests():
    global mode
    try:
        assert owner_ready.wait(3)
        c = Client()
        # First registration, shared observation, final removal.
        c.add('first'); c.acquired(); c.add('second')
        c.command('remove', name='first'); assert len(active) == 1
        c.command('remove', name='second'); wait_for(lambda: not active, 'last removal releases')
        # Ordinary decision releases; cancelled cycle reacquires for listeners.
        c.add('ordinary'); c.acquired(); prepare(True); c.fired('ordinary')
        wait_for(lambda: not active, 'ordinary decision releases')
        prepare(False); wait_for(lambda: len(active) == 1, 'rearm after aborted shutdown')
        c.command('removeAll'); wait_for(lambda: not active, 'removeAll releases')
        # once auto-removal must not release before preventDefault is applied.
        c.add('once', once=True, prevented=True); c.acquired(); prepare(True); c.fired('once')
        time.sleep(0.15); assert len(active) == 1, 'once cancellation lost its FD'
        if host:
            c.command('stale', generation=0)
            assert len(active) == 1, 'stale decision released current lease'
        prepare(False); wait_for(lambda: not active, 'cancelled once cycle releases without rearming')
        # A cancelled listener and missing JS work are bounded by native time.
        c.add('deadline', prevented=True); c.acquired(); prepare(True); c.fired('deadline')
        wait_for(lambda: not active, 'bounded cancellation release', timeout=6)
        prepare(False); wait_for(lambda: len(active) == 1, 'rearm after deadline')
        c.command('removeAll'); wait_for(lambda: not active, 'cleanup')
        # Daemon loss releases owned FD; same connection reacquiring the name
        # must also invalidate the old lifecycle (owner-watch vanished callback).
        c.add('loss'); c.acquired()
        on_main(lambda: Gio.bus_unown_name(owner))
        wait_for(lambda: not active, 'daemon loss releases')
        on_main(own); assert owner_ready.wait(3)
        wait_for(lambda: len(active) == 1, 'daemon recovery reacquires')
        c.command('removeAll'); wait_for(lambda: not active, 'cleanup before failures')
        # Denial and malformed FD replies remain observable and nonfatal.
        for value in ['denied', 'invalid']:
            mode = value
            previous = len([m for m in c.messages if m.get('status', {}).get('reason')])
            c.add(value)
            wait_for(lambda: len([m for m in c.messages if m.get('status', {}).get('reason')]) > previous, value)
            assert not active
            c.command('removeAll')
        # Disable while acquisition is outstanding. A late service reply must
        # not resurrect observation or leak the returned FD.
        mode = 'late'; c.add('late')
        wait_for(lambda: len(active) == 1, 'pending descriptor')
        c.command('removeAll'); wait_for(lambda: not active, 'late descriptor drained', timeout=3)
        mode = 'normal'
        c.add('exit', once=True, prevented=True); c.acquired(); prepare(True); c.fired('exit')
        c.quit()
        # Kernel/transport teardown releases active leases after either death.
        for action in (['crash', 'host-crash'] if host else ['crash']):
            prepare(False)
            c = Client(); c.add(action); c.acquired()
            c.command(action)
            if action == 'crash':
                assert c.process.wait(timeout=4) == -signal.SIGKILL
            wait_for(lambda: not active, action + ' releases')
            if action == 'host-crash':
                c.quit()
        assert len([r for r in records if r[0] == 'acquire']) == len([r for r in records if r[0] == 'release'])
        print(json.dumps({'kind': 'native-shutdown-fd-protocol', 'backend': backend, 'fullRuntime': not bool(host),
                          'passed': True, 'remainingLeases': len(active), 'physicalShutdownTested': False,
                          'checks': ['first-last', 'ordinary', 'once-cancel', 'deadline', 'daemon-loss-recovery',
                                     'denied', 'malformed-fd', 'late-reply', 'quit', 'crash']}), flush=True)
    except BaseException:
        failure.append(traceback.format_exc())
    finally:
        GLib.idle_add(lambda: (loop.quit(), False)[1])

own()
threading.Thread(target=tests, daemon=True).start()
loop.run()
for child in children:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
if owner is not None:
    Gio.bus_unown_name(owner)
if failure:
    raise AssertionError(failure[0])

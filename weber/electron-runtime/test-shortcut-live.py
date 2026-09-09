#!/usr/bin/env python3
"""Real X11 passive grabs, cross-process conflicts and release for Node/Bun."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


runtime = Path(__file__).resolve().parent
executable = sys.argv[1] if len(sys.argv) > 1 else "node"
focus_executable = os.environ.get(
    "WEBER_SHORTCUT_FOCUS", str(runtime.parents[1] / "out/runtime/weber-shortcut-focus"))
children = []
logs = []


def stop(child):
    # Each test process has its own session, including the host it launches.
    # A completed wait() has released its PID; never signal that number again.
    # With this single-threaded owner, a child that exits after poll() stays an
    # unreaped zombie, so its PID cannot be reused before the following signal.
    if child.returncode is not None or child.poll() is not None:
        return
    try:
        if os.getpgid(child.pid) != child.pid or os.getsid(child.pid) != child.pid:
            raise AssertionError("Shortcut test child no longer owns its process group")
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait(timeout=3)
        return
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        if child.returncode is None and child.poll() is None:
            try:
                if os.getpgid(child.pid) != child.pid or os.getsid(child.pid) != child.pid:
                    raise AssertionError("Shortcut test child no longer owns its process group")
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait(timeout=3)


def read_json(path):
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    if value.get("error"):
        raise AssertionError(value["error"])
    return value


def await_state(read, predicate, child, label, timeout=12):
    deadline = time.monotonic() + timeout
    state = {}
    while time.monotonic() < deadline:
        state = read()
        if predicate(state):
            return state
        if child.poll() is not None:
            raise AssertionError(f"{label}: process exited {child.returncode}: {state}")
        time.sleep(0.025)
    raise AssertionError(f"Timed out waiting for {label}: {state}")


def xdo(*arguments):
    return subprocess.check_output(
        ["xdotool", *map(str, arguments)], text=True, timeout=8).strip()


with tempfile.TemporaryDirectory(prefix="weber-shortcut-test-") as temporary:
    directory = Path(temporary)
    control = directory / "control.json"

    def launch(role):
        result = directory / f"{role}.json"
        log = (directory / f"{role}.log").open("a+")
        logs.append((role, log))
        environment = dict(os.environ, WEBER_SHORTCUT_ROLE=role,
                           WEBER_SHORTCUT_RESULT=str(result),
                           WEBER_SHORTCUT_CONTROL=str(control))
        child = subprocess.Popen(
            [executable, str(runtime / "bootstrap.cjs"), str(runtime / "shortcut-fixture")],
            env=environment, stdout=log, stderr=log, start_new_session=True)
        children.append(child)
        return child, lambda: read_json(result)

    try:
        helper_log = (directory / "focus.log").open("a+")
        logs.append(("independent-x11-client", helper_log))
        helper = subprocess.Popen([focus_executable], stdout=helper_log,
                                  stderr=subprocess.STDOUT, start_new_session=True)
        children.append(helper)

        def read_helper():
            helper_log.seek(0)
            text = helper_log.read(131073)
            if len(text) > 131072:
                raise AssertionError("Independent X11 helper exceeded its output limit")
            complete = text[:text.rfind("\n") + 1].splitlines()
            return json.loads(complete[-1]) if complete else {}

        focused = await_state(read_helper, lambda value: value.get("ready"), helper, "X11 helper map")
        assert focused["pid"] == helper.pid
        owner, read_owner = launch("owner")
        owner_state = await_state(read_owner, lambda value: value.get("ready"), owner, "owner registration")
        assert owner_state["synchronousRegistration"] is True
        assert owner_state["pid"] != focused["pid"]

        contender, read_contender = launch("contender")
        conflict = await_state(read_contender, lambda value: value.get("ready"), contender, "second process conflict")
        assert conflict["registered"] is False
        contender.wait(timeout=8)
        assert contender.returncode == 0

        def focus_other_client():
            xdo("windowraise", focused["windowId"])
            xdo("windowfocus", "--sync", focused["windowId"])
            assert int(xdo("getwindowfocus")) == focused["windowId"]
            assert int(xdo("getwindowpid", focused["windowId"])) == helper.pid

        def key(chord):
            focus_other_client()
            # No --window: the X server routes real input using the current focus
            # and its passive grabs, including when the focus is another process.
            xdo("key", "--clearmodifiers", chord)

        def callbacks(primary, secondary):
            return await_state(read_owner, lambda value: value.get("primary") == primary
                               and value.get("secondary") == secondary, owner, "shortcut callback")

        commands = iter(range(1, 100))

        def command(action):
            sequence = next(commands)
            staging = control.with_suffix(".tmp")
            staging.write_text(json.dumps({"id": sequence, "action": action}))
            os.replace(staging, control)
            return await_state(read_owner, lambda value: value.get("command") == sequence,
                               owner, action)

        key("ctrl+shift+F8")
        callbacks(1, 0)
        key("ctrl+shift+F9")
        callbacks(1, 1)
        assert read_helper()["primary"] == 0 and read_helper()["secondary"] == 0

        command("unregister-primary")
        key("ctrl+shift+F8")
        await_state(read_helper, lambda value: value.get("primary") == 1,
                    helper, "released F8 delivered to another process")
        key("ctrl+shift+F9")
        callbacks(1, 2)
        time.sleep(0.25)
        assert read_owner()["primary"] == 1

        command("unregister-all")
        key("ctrl+shift+F8")
        key("ctrl+shift+F9")
        await_state(read_helper, lambda value: value.get("primary") == 2
                    and value.get("secondary") == 1, helper, "all released keys delivered to another process")
        time.sleep(0.25)
        assert (read_owner()["primary"], read_owner()["secondary"]) == (1, 2)

        command("reregister-primary")
        key("ctrl+shift+F8")
        final = callbacks(2, 2)
        command("quit")
        owner.wait(timeout=8)
        assert owner.returncode == 0
        successor, read_successor = launch("after-exit")
        released = await_state(read_successor, lambda value: value.get("ready"), successor,
                               "registration after owner exit")
        assert released["registered"] is True
        successor.wait(timeout=8)
        assert successor.returncode == 0
        print(json.dumps({"ok": True, "runtime": executable,
                          "nativePlatform": "x11", "independentFocusPid": helper.pid,
                          "ownerPid": owner.pid, "conflictProcessPid": contender.pid,
                          "synchronousRegistration": True, "crossProcessConflict": True,
                          "unregisterStopsCallbacks": True, "unregisterAllStopsCallbacks": True,
                          "ownershipReleasedOnExit": True,
                          "callbacks": {"primary": final["primary"], "secondary": final["secondary"]},
                          "releasedKeysReceivedByOtherClient": read_helper()}, indent=2))
    except Exception:
        for label, log in logs:
            log.seek(0, os.SEEK_END)
            size = log.tell()
            log.seek(max(0, size - 65536))
            print(f"{label} output (last 64 KiB):\n{log.read()}", file=sys.stderr)
        raise
    finally:
        for child in reversed(children):
            stop(child)
        for _, log in logs:
            log.close()

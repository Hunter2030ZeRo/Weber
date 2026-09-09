#!/usr/bin/env python3
"""Real X11 input -> GTK menu -> original Electron MenuItem callback."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

runtime = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="weber-menu-test-") as temporary:
    result = Path(temporary) / "result.json"
    environment = dict(os.environ, WEBER_MENU_RESULT=str(result))
    command = [sys.argv[1] if len(sys.argv) > 1 else "node", str(runtime / "bootstrap.cjs"), str(runtime / "menu-fixture")]
    with tempfile.TemporaryFile(mode="w+") as log:
        child = subprocess.Popen(command, env=environment, stdout=log, stderr=log)
        def await_state(predicate):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    state = json.loads(result.read_text())
                except (FileNotFoundError, json.JSONDecodeError):
                    state = {}
                if state.get("error"):
                    raise AssertionError(state["error"])
                if predicate(state):
                    return state
                if child.poll() is not None:
                    raise AssertionError(f"Runtime exited with {child.returncode}: {state}")
                time.sleep(0.025)
            raise AssertionError(f"Timed out waiting for native menu state: {state}")

        def xdo(*arguments):
            return subprocess.check_output(["xdotool", *map(str, arguments)], text=True).strip()

        def choose(window, index):
            # Mouse input opens the actual OS menu bar. GTK keyboard navigation
            # activates the selected native menu item (no engine JS injection).
            xdo("windowraise", window)
            xdo("windowfocus", "--sync", window)
            xdo("mousemove", "--window", window, 18, 12)
            xdo("click", 1)
            xdo("key", "Home", *(["Down"] * index), "Return")

        try:
            state = await_state(lambda value: value.get("ready"))
            first = xdo("search", "--name", "^Weber menu first$").splitlines()[0]
            second = xdo("search", "--name", "^Weber menu second$").splitlines()[0]
            choose(first, 0)
            await_state(lambda value: value.get("clicks") == 1 and value.get("windowId") == state["firstId"])
            choose(second, 0)
            await_state(lambda value: value.get("clicks") == 2 and value.get("windowId") == state["secondId"])
            choose(second, 1)
            await_state(lambda value: value.get("checkbox"))
            choose(second, 2)
            await_state(lambda value: value.get("radio") == "first")
            xdo("key", "ctrl+shift+y")
            await_state(lambda value: value.get("accelerator") == 1)
            # The disabled item is skipped by native keyboard navigation, so
            # five Down presses reach Remove menu from the first enabled item.
            choose(second, 5)
            final = await_state(lambda value: value.get("removed"))
            child.wait(timeout=10)
            assert child.returncode == 0
            print(json.dumps({"ok": True, **final}, indent=2))
        except Exception:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)

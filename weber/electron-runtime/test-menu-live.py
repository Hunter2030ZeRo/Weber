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

        def menu_item(state, owner, command):
            return next((item for item in state.get("layouts", {}).get(str(owner), {}).get("items", [])
                         if item["commandId"] == command and item["mapped"] and item["translated"]
                         and item["width"] > 0 and item["height"] > 0), None)

        def click_item(owner, command):
            snapshot = await_state(lambda value: menu_item(value, owner, command))
            item = menu_item(snapshot, owner, command)
            print(json.dumps({"input": "mouse-click", "windowId": owner, "item": item}), flush=True)
            xdo("mousemove", "--sync", item["x"] + item["width"] // 2, item["y"] + item["height"] // 2)
            xdo("click", 1)

        def choose(window, owner, command):
            # Use measured GTK screen geometry, then send real X11 mouse events
            # to BOTH the menu bar and popup item. No activation is injected.
            xdo("windowraise", window)
            xdo("windowfocus", "--sync", window)
            click_item(owner, state["topCommandId"])
            click_item(owner, state["commandIds"][command])

        try:
            state = await_state(lambda value: value.get("ready"))
            first = xdo("search", "--name", "^Weber menu first$").splitlines()[0]
            second = xdo("search", "--name", "^Weber menu second$").splitlines()[0]
            choose(first, state["firstId"], "click")
            await_state(lambda value: value.get("clicks") == 1 and value.get("windowId") == state["firstId"])
            choose(second, state["secondId"], "click")
            await_state(lambda value: value.get("clicks") == 2 and value.get("windowId") == state["secondId"])
            choose(second, state["secondId"], "enabled")
            await_state(lambda value: value.get("checkbox"))
            choose(second, state["secondId"], "first")
            await_state(lambda value: value.get("radio") == "first")
            xdo("key", "ctrl+shift+y")
            await_state(lambda value: value.get("accelerator") == 1)
            choose(second, state["secondId"], "remove")
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

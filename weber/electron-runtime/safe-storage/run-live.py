#!/usr/bin/env python3
"""Own the entire temporary HOME and D-Bus session; never use a user's keyring."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix="weber-safe-storage-test-") as temporary:
    root = Path(temporary)
    env = dict(os.environ, HOME=temporary, WEBER_SAFE_TEST_ROOT=temporary, XDG_CURRENT_DESKTOP="GNOME")
    for key, directory in [("XDG_DATA_HOME", "data"), ("XDG_CONFIG_HOME", "config"),
                           ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "runtime")]:
        (root / directory).mkdir(mode=0o700)
        env[key] = str(root / directory)
    for key in ("DBUS_SESSION_BUS_ADDRESS", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID"):
        env.pop(key, None)
    result = subprocess.run(["dbus-run-session", "--", "node", str(Path(__file__).with_name("live.cjs")), *sys.argv[1:]],
                            env=env, timeout=100)
    sys.exit(result.returncode)

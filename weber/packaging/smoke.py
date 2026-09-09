#!/usr/bin/env python3
"""Verify an extracted development bundle, then run its real TOML selector."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def process_stat(pid):
    source = Path(f"/proc/{pid}/stat").read_text()
    fields = source[source.rindex(")") + 2:].split()
    return {"pid": pid, "state": fields[0], "group": int(fields[2]),
            "session": int(fields[3]), "start": int(fields[19])}


class OwnedProcesses:
    """Track launch identities and signal pinned pidfds, never a numeric PGID."""

    def __init__(self, process):
        self.process = process
        initial = process_stat(process.pid)
        if initial["group"] != process.pid or initial["session"] != process.pid:
            raise RuntimeError("Fixture did not enter its own process session")
        self.known = {process.pid: initial}

    def inspect(self):
        group = []
        for entry in Path("/proc").iterdir():
            if entry.name.isdigit():
                try:
                    item = process_stat(int(entry.name))
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    continue
                if item["group"] == self.process.pid and item["session"] == self.process.pid:
                    group.append(item)
        # A reused numeric group/session ID does not establish ownership.
        if group and not any(self.known.get(item["pid"], {}).get("start") == item["start"] for item in group):
            raise RuntimeError("Cannot verify ownership of remaining fixture processes")
        self.known.update((item["pid"], item) for item in group)
        for pid, known in self.known.items():
            try:
                current = process_stat(pid)
            except (FileNotFoundError, ProcessLookupError):
                continue
            if current["start"] == known["start"] and current["state"] not in {"Z", "X"} and (
                    current["group"] != self.process.pid or current["session"] != self.process.pid):
                raise RuntimeError(f"Owned fixture process escaped its session: {pid}")
        return [item for item in group if item["state"] not in {"Z", "X"}]

    def signal(self, signum):
        for known in self.inspect():
            descriptor = None
            try:
                descriptor = os.pidfd_open(known["pid"])
                current = process_stat(known["pid"])
                if (current["start"], current["group"], current["session"]) != (
                        known["start"], self.process.pid, self.process.pid):
                    continue
                # The descriptor pins this exact process identity across exit
                # and PID reuse after the check. No post-reap killpg is used.
                signal.pidfd_send_signal(descriptor, signum)
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)

    def cleanup(self):
        for signum, duration in ((None, 0.2), (signal.SIGTERM, 0.75), (signal.SIGKILL, 0.75)):
            if signum is not None:
                self.signal(signum)
            deadline = time.monotonic() + duration
            while True:
                live = self.inspect()
                reaped = self.process.poll() is not None
                if not live and reaped:
                    return
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.025)
        raise RuntimeError("Fixture cleanup could not establish a quiescent process session")


def verify(root):
    manifest = json.loads((root / "bundle-manifest.json").read_text())
    expected = {"bundle-manifest.json"}
    for item in manifest["files"]:
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(f"Unsafe manifest path: {relative}")
        path = root / relative
        if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
            raise RuntimeError(f"Missing ordinary bundle file: {relative}")
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
        if path.stat().st_size != item["bytes"] or hasher.hexdigest() != item["sha256"]:
            raise RuntimeError(f"Bundle file hash mismatch: {relative}")
        expected.add(relative.as_posix())
    actual = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()}
    if actual != expected:
        raise RuntimeError(f"Unexpected bundle files: {sorted(actual - expected)}")
    return manifest


def run(root, backend, output):
    manifest = verify(root)
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("The Linux smoke verifier needs Python pidfd support")
    if int(os.readlink("/proc/self")) != os.getpid():
        raise RuntimeError("The smoke verifier needs /proc in its own PID namespace")
    descriptor = os.pidfd_open(os.getpid())
    os.close(descriptor)  # Check kernel support before creating any children.
    if os.environ.get("WEBER_UNSANDBOXED_DEVELOPMENT") != "1":
        raise RuntimeError("Set WEBER_UNSANDBOXED_DEVELOPMENT=1 explicitly for this trusted development fixture")
    environment = dict(os.environ)
    # Exercise adjacent-bundle discovery; stale checkout overrides must not mask
    # a missing packaged binary. Keep the caller's deliberate development gate.
    for name in ("WEBER_RUNTIME_ROOT", "WEBER_DESKTOP_HOST", "WEBER_OBSCURA_RENDERER", "WEBER_ENTRY", "WEBER_BACKEND_LAUNCHER"):
        environment.pop(name, None)
    with tempfile.TemporaryDirectory(prefix="weber-bundle-smoke-") as temporary:
        result_path = Path(temporary) / "result.json"
        environment["WEBER_LIVE_RESULT"] = str(result_path)
        process = subprocess.Popen([str(root / "weber-backend"), "run", "--project", str(root / "examples" / backend)],
                                   cwd=temporary, env=environment, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=True)
        tracker = OwnedProcesses(process)
        try:
            deadline = time.monotonic() + 110
            while True:
                tracker.inspect()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(f"Packaged {backend} fixture timed out")
                try:
                    stdout, stderr = process.communicate(timeout=min(0.1, remaining))
                    break
                except subprocess.TimeoutExpired:
                    pass
        finally:
            tracker.cleanup()
        if process.returncode != 0:
            raise RuntimeError(f"Packaged {backend} fixture exited {process.returncode}:\n{stderr[-16000:]}\n{stdout[-16000:]}")
        if backend == "native":
            lines = [line for line in stdout.splitlines() if line.startswith("{")]
            result = json.loads(lines[-1]) if lines else {}
            if result.get("backend") != "native" or result.get("framePresented") is not True or result.get("dom", {}).get("answer") != 42:
                raise RuntimeError(f"Native packaged fixture did not render/evaluate: {result}")
        else:
            result = json.loads(result_path.read_text())
            if result.get("windowsPresented") != 2:
                raise RuntimeError(f"Packaged {backend} fixture did not present two windows: {result}")
        if result.get("ok") is not True:
            raise RuntimeError(f"Packaged fixture failed: {result}")
        evidence = {"ok": True, "backend": backend, "bundleCommit": manifest["source"]["weberCommit"],
                    "usedAdjacentRuntimeDiscovery": True, "osSandbox": False, "fixture": result}
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--backend", choices=("node", "bun", "native"), default="node")
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    try:
        run(arguments.bundle.resolve(), arguments.backend, arguments.output)
    except (RuntimeError, OSError, ValueError) as error:
        parser.exit(1, f"Weber development bundle smoke failed: {error}\n")

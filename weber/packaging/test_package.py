"""Checks meaningful packaging risks without pretending to run a GUI."""

import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


def module(name, filename):
    specification = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    result = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(result)
    return result


package = module("weber_development_package", "package.py")
smoke = module("weber_development_smoke", "smoke.py")


class DevelopmentBundleTests(unittest.TestCase):
    def test_archive_is_identical_across_source_mtime_and_creation_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for label, order in (("first", ("z", "a")), ("second", ("a", "z"))):
                tree = root / label / "bundle"
                tree.mkdir(parents=True)
                for filename in order:
                    (tree / filename).write_text(filename)
                (tree / "z").chmod(0o755)
                package.archive_tree(tree, root / f"{label}.tar.gz", 123)
            self.assertEqual((root / "first.tar.gz").read_bytes(), (root / "second.tar.gz").read_bytes())
            with tarfile.open(root / "first.tar.gz") as archive:
                self.assertEqual(archive.getmember("bundle/z").mode, 0o755)
                self.assertEqual(archive.getmember("bundle/a").uid, 0)
                self.assertEqual(archive.getmember("bundle/a").mtime, 123)

    def test_verifier_detects_modified_missing_and_extra_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "payload"
            payload.write_text("original")
            manifest = {"files": [{"path": "payload", "bytes": payload.stat().st_size, "sha256": package.digest(payload)}]}
            (root / "bundle-manifest.json").write_text(json.dumps(manifest))
            smoke.verify(root)
            payload.write_text("modified")
            with self.assertRaisesRegex(RuntimeError, "hash mismatch"):
                smoke.verify(root)
            payload.write_text("original")
            (root / "extra").write_text("unexpected")
            with self.assertRaisesRegex(RuntimeError, "Unexpected bundle files"):
                smoke.verify(root)
            (root / "extra").unlink()
            payload.unlink()
            with self.assertRaisesRegex(RuntimeError, "Missing ordinary bundle file"):
                smoke.verify(root)

    def test_manifest_cannot_escape_extracted_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "bundle"
            root.mkdir()
            (root / "bundle-manifest.json").write_text(json.dumps({"files": [{"path": "../outside"}]}))
            with self.assertRaisesRegex(RuntimeError, "Unsafe manifest path"):
                smoke.verify(root)

    def test_cleanup_does_not_signal_a_reused_process_identity(self):
        tracker = object.__new__(smoke.OwnedProcesses)
        tracker.process = mock.Mock(pid=100)
        known = {"pid": 101, "start": 123, "group": 100, "session": 100}
        current = {**known, "start": 456}
        with mock.patch.object(tracker, "inspect", return_value=[known]), \
             mock.patch.object(smoke.os, "pidfd_open", return_value=9), \
             mock.patch.object(smoke.os, "close") as close, \
             mock.patch.object(smoke, "process_stat", return_value=current), \
             mock.patch.object(smoke.signal, "pidfd_send_signal") as send:
            tracker.signal(signal.SIGKILL)
            send.assert_not_called()
            close.assert_called_once_with(9)

    def test_cleanup_reaps_parent_and_terminates_owned_stubborn_helper(self):
        if not hasattr(os, "pidfd_open") or int(os.readlink("/proc/self")) != os.getpid():
            self.skipTest("Needs Linux pidfds and matching /proc PID namespace")
        helper = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(30)"
        parent = (
            "import subprocess,sys; "
            f"p=subprocess.Popen([sys.executable, '-c', {helper!r}], stdout=subprocess.PIPE, text=True); "
            "p.stdout.readline(); print('ready', flush=True); sys.stdin.readline()"
        )
        process = subprocess.Popen([sys.executable, "-c", parent], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        tracker = smoke.OwnedProcesses(process)
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            children = [item for item in tracker.inspect() if item["pid"] != process.pid]
            self.assertEqual(len(children), 1)
            process.stdin.write("exit\n")
            process.stdin.flush()
            process.wait(timeout=3)
            tracker.cleanup()
            self.assertEqual(tracker.inspect(), [])
        finally:
            tracker.cleanup()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()


if __name__ == "__main__":
    unittest.main()

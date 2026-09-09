#!/usr/bin/env python3
"""Run pinned, unmodified VS Code app code through Weber and record a blocker.

This is a startup diagnostic. A completed probe is never a VS Code compatibility
pass: ready remains false until a separate functional acceptance test exists.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request

PIN = json.loads(Path(__file__).with_name("pin.json").read_text())
MAX_ARCHIVE = 1024 * 1024 * 1024
MAX_APP = 3 * 1024 * 1024 * 1024
MAX_LOG = 4 * 1024 * 1024
KEEP_LOG = 256 * 1024


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class MicrosoftRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in {
            "update.code.visualstudio.com", "vscode.download.prss.microsoft.com"
        }:
            raise RuntimeError(f"Unexpected distribution redirect: {newurl}")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download(directory: Path) -> tuple[Path, dict]:
    archive = directory / "vscode.tar.gz"
    opener = urllib.request.build_opener(MicrosoftRedirects())
    request = urllib.request.Request(PIN["archive_url"], headers={"User-Agent": "Weber-startup-probe/0.1"})
    deadline = time.monotonic() + 180
    size = 0
    with opener.open(request, timeout=30) as response, archive.open("wb") as output:
        final_url = response.geturl()
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARCHIVE or time.monotonic() > deadline:
                raise RuntimeError("VS Code download exceeded its size or time limit")
            output.write(chunk)
    return archive, {"url": final_url, "bytes": size, "sha256": sha256(archive)}


def extract_app(archive: Path, directory: Path) -> tuple[Path, dict]:
    prefix = PurePosixPath("VSCode-linux-x64/resources/app")
    selected = []
    size = 0
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = PurePosixPath(member.name)
            if ".." in name.parts or name.is_absolute():
                raise RuntimeError(f"Unsafe archive path: {member.name}")
            if name == prefix or prefix in name.parents:
                size += member.size
                selected.append(member)
                if size > MAX_APP or len(selected) > 200_000:
                    raise RuntimeError("VS Code application exceeds extraction limits")
        # Extract only app resources, never the bundled Chromium/Electron binary.
        source.extractall(directory, members=selected, filter="data")
    app = directory.joinpath(*prefix.parts)
    package = json.loads((app / "package.json").read_text())
    product = json.loads((app / "product.json").read_text())
    if package.get("version") != PIN["version"] or product.get("commit") != PIN["commit"]:
        raise RuntimeError(f"Pinned VS Code version/commit mismatch: {package.get('version')} / {product.get('commit')}")
    entry = (app / package.get("main", "index.js")).resolve()
    if not entry.is_relative_to(app.resolve()) or not entry.is_file():
        raise RuntimeError("VS Code package main is not an application file")
    return app, {"version": package["version"], "commit": product["commit"],
                 "entry": str(entry.relative_to(app)), "entry_sha256": sha256(entry),
                 "package_sha256": sha256(app / "package.json"), "extracted_bytes": size,
                 "files": len(selected), "app_modified": False, "bundled_electron_extracted": False}


def provenance(repo: Path, runtime: Path, node: str, temporary: Path) -> dict:
    existing = runtime / "dist"
    manifest = json.loads((existing / "source-manifest.json").read_text())
    if not manifest.get("sources"):
        raise RuntimeError("Weber has no compiled original Electron source manifest")
    rebuilt = temporary / "recompiled-electron"
    result = subprocess.run([node, str(runtime / "build.cjs"), str(repo), str(rebuilt)],
                            capture_output=True, text=True, timeout=60, check=False)
    if result.returncode:
        raise RuntimeError("Original Electron source recompilation failed: " + result.stderr[-4000:])
    if json.loads((rebuilt / "source-manifest.json").read_text()) != manifest:
        raise RuntimeError("Installed Electron source manifest differs from a fresh compilation")
    verified = []
    for item in manifest["sources"]:
        source = (repo / item["path"]).resolve()
        if not source.is_relative_to(repo / "lib") or sha256(source) != item["sha256"]:
            raise RuntimeError(f"Original Electron source hash mismatch: {item['path']}")
        compiled_path = Path(item["path"]).relative_to("lib").with_suffix(".js")
        compiled = sha256(existing / compiled_path)
        if compiled != sha256(rebuilt / compiled_path):
            raise RuntimeError(f"Compiled Electron module differs from current source: {compiled_path}")
        verified.append({**item, "compiled_sha256": compiled})
    versions = subprocess.check_output([node, "-p", "JSON.stringify(process.versions)"], text=True, timeout=10)
    return {"compiled_original_sources_verified": True, "source_count": len(verified),
            "sources": verified, "bootstrap_sha256": sha256(runtime / "bootstrap.cjs"),
            "bindings_sha256": sha256(runtime / "bindings.cjs"),
            "node_versions": json.loads(versions), "weber_commit": os.environ.get("GITHUB_SHA"),
            "method": "Fresh compilation and byte-for-byte JS digest comparison against the current Electron source tree"}


def stop_group(process: subprocess.Popen, sig: int) -> None:
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def startup(command: list[str], app: Path, temporary: Path, timeout: float) -> dict:
    env = os.environ.copy()
    # The official distribution's own package.json selects its unmodified main.
    env.pop("WEBER_ENTRY", None)
    env.pop("NODE_OPTIONS", None)
    env["WEBER_PROJECT_DIR"] = str(app)
    process = subprocess.Popen(command, cwd=app, env=env, start_new_session=True,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    counts = {"stdout": 0, "stderr": 0}
    overflow = threading.Event()

    def consume(name, pipe):
        while chunk := pipe.read(8192):
            counts[name] += len(chunk)
            captured[name].extend(chunk)
            # Keep a bounded tail: Node may print a long minified source line
            # before the useful exception message and stack trace.
            if len(captured[name]) > KEEP_LOG:
                del captured[name][:-KEEP_LOG]
            if counts[name] > MAX_LOG:
                overflow.set()
                stop_group(process, signal.SIGKILL)
        pipe.close()

    readers = [threading.Thread(target=consume, args=(name, pipe), daemon=True)
               for name, pipe in [("stdout", process.stdout), ("stderr", process.stderr)]]
    for reader in readers:
        reader.start()
    timed_out = False
    started = time.monotonic()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        stop_group(process, signal.SIGTERM)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            stop_group(process, signal.SIGKILL)
            process.wait(timeout=5)
    finally:
        # Reap anything the app started in its dedicated process group, including
        # an early-exit main that left a helper process holding a log pipe open.
        stop_group(process, signal.SIGKILL)
        for reader in readers:
            reader.join(timeout=5)
    text = {name: bytes(value).decode("utf-8", errors="replace") for name, value in captured.items()}
    error = None
    stack = []
    for line in (text["stderr"] + "\n" + text["stdout"]).splitlines():
        clean = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
        if error is None and re.search(r"(?:^|\s)(?:[A-Za-z]+Error|Error)(?:\s*\[[^]]+\])?:", clean):
            error = clean[:2000]
        elif error is not None and clean.startswith("at ") and len(stack) < 12:
            stack.append(clean[:1000])
    if error is None:
        error = ("Startup exceeded the diagnostic deadline; readiness was not established" if timed_out else
                 "Startup output exceeded the diagnostic limit" if overflow.is_set() else
                 f"Process exited with code {process.returncode}; no readiness acceptance test was performed")
    return {"exit_code": process.returncode, "timed_out": timed_out,
            "duration_seconds": round(time.monotonic() - started, 3),
            "output_limit_exceeded": overflow.is_set(), "error": error, "stack": stack,
            "stdout_tail": text["stdout"][-12000:], "stderr_tail": text["stderr"][-12000:],
            "output_bytes": counts, "command": command}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    runtime = (args.runtime_root or repo / "weber/electron-runtime").resolve()
    report = {"kind": "vscode-startup-diagnostic", "ready": False,
              "readiness_checked": False, "diagnostic_completed": False,
              "version": PIN["version"], "commit": PIN["commit"],
              "source_url": PIN["source_url"], "pin": PIN,
              "bundled_electron_executed": False, "stage": "setup"}
    try:
        if not 1 <= args.timeout <= 120:
            raise ValueError("Startup timeout must be between 1 and 120 seconds")
        if os.name != "posix" or os.uname().sysname != "Linux" or os.uname().machine != "x86_64":
            raise RuntimeError("This pinned distribution probe requires Linux x86_64")
        if os.environ.get("WEBER_UNSANDBOXED_DEVELOPMENT") != "1":
            raise RuntimeError("The development host requires explicit WEBER_UNSANDBOXED_DEVELOPMENT=1")
        with tempfile.TemporaryDirectory(prefix="weber-vscode-probe-") as scratch:
            temporary = Path(scratch)
            report["stage"] = "provenance"
            report["provenance"] = provenance(repo, runtime, args.node, temporary)
            report["stage"] = "download"
            archive, report["archive"] = download(temporary)
            report["stage"] = "extract"
            app, report["application"] = extract_app(archive, temporary)
            report["stage"] = "startup"
            command = [args.node, str(runtime / "bootstrap.cjs"), str(app), "--new-window",
                       "--disable-extensions", "--skip-welcome", "--skip-release-notes",
                       "--user-data-dir", str(temporary / "user-data"),
                       "--extensions-dir", str(temporary / "extensions")]
            report.update(startup(command, app, temporary, args.timeout))
            report["diagnostic_completed"] = True
            report["stage"] = "complete"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report.get(key) for key in
                     ["kind", "diagnostic_completed", "ready", "version", "stage", "error", "exit_code", "timed_out"]}))
    return 0 if report["diagnostic_completed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

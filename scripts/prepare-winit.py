"""Materialize the checksum-pinned winit crate and the Wayland surrounding-text patch.

Never edit the shared Cargo cache or silently replace an edited prepared tree.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--offline", action="store_true")
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
pin = json.loads((root / "patches/winit-source.json").read_text())
package = "winit-" + pin["version"]
cache = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
archives = sorted(cache.glob(f"registry/cache/*/{package}.crate"))
archives.append(root / "target/source-archives" / f"{package}.crate")
archive = next((p for p in archives if p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest() == pin["checksum"]), None)
if archive is None:
    if args.offline:
        raise SystemExit(f"Missing checksum-matching Cargo cache archive: {package}.crate")
    download = root / "target/source-archives" / f"{package}.crate"
    download.parent.mkdir(parents=True, exist_ok=True)
    if not download.exists() or hashlib.sha256(download.read_bytes()).hexdigest() != pin["checksum"]:
        with urllib.request.urlopen(pin["url"], timeout=60) as response:
            data = response.read(16 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != pin["checksum"]:
            raise SystemExit("winit archive checksum mismatch")
        download.write_bytes(data)
    archive = download

def tree(path):
    result = {}
    for item in sorted(path.rglob("*")):
        if item.is_symlink():
            raise SystemExit(f"Unexpected symlink in prepared winit: {item}")
        if item.is_file():
            result[item.relative_to(path).as_posix()] = hashlib.sha256(item.read_bytes()).hexdigest()
    return result

with tempfile.TemporaryDirectory(prefix="weber-winit-") as directory:
    clean = Path(directory) / package
    clean.mkdir()
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = PurePosixPath(member.name)
            if name.parts[0] != package or any(part in {"..", ""} for part in name.parts):
                raise SystemExit("Invalid winit archive path")
            if member.isdir():
                continue
            if not member.isfile():
                raise SystemExit("Unsupported winit archive entry")
            target = clean.joinpath(*name.parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            stream = source.extractfile(member)
            if stream is None:
                raise SystemExit("Missing winit archive content")
            target.write_bytes(stream.read())
    patch = root / "patches/winit-surrounding-text.patch"
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=clean, check=True)
    subprocess.run(["git", "apply", str(patch)], cwd=clean, check=True)
    expected = tree(clean)
    destination = root / "vendor/winit"
    if destination.exists():
        if tree(destination) != expected:
            raise SystemExit("Prepared winit differs from pinned archive + patch; preserving local edits")
    elif args.check:
        raise SystemExit("Prepared winit missing; run python3 scripts/prepare-winit.py")
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".winit-", dir=destination.parent) as staging:
            prepared = Path(staging) / "winit"
            shutil.copytree(clean, prepared)
            prepared.rename(destination)
    result = {"passed": True, "version": pin["version"], "archiveSha256": pin["checksum"],
              "patchSha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "files": len(expected),
              "preparedSourceMatches": True}
    if args.check:
        (root / "artifacts").mkdir(exist_ok=True)
        (root / "artifacts/winit-patches.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))

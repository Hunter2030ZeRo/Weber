#!/usr/bin/env python3
"""Assemble built Linux development binaries and collect dependency source notices."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile


ELECTRON_COMMIT = "c1aad3df47dcae19bad6d12157c7f06ad72ea409"
LEGAL_NAME = re.compile(r"^(?:LICEN[CS]E|NOTICE|COPYING|COPYRIGHT|PATENTS)(?:[._-].*)?$", re.I)
RUNTIME_HELPERS = (
    "bootstrap.cjs", "bindings.cjs", "commonjs-loader.cjs", "electron-api.cjs",
    "host-client.cjs", "ipc-reply-queue.cjs", "menu-binding.cjs", "protocol-binding.cjs", "clipboard-binding.cjs", "display-binding.cjs", "notification-binding.cjs", "message-port-binding.cjs", "global-shortcut-binding.cjs", "platform-app.cjs",
)


def command(arguments: list[str], cwd: Path | None = None) -> str:
    return subprocess.check_output(arguments, cwd=cwd, text=True, stderr=subprocess.PIPE).strip()


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def copy_file(source: Path, destination: Path, executable: bool = False) -> None:
    if not source.is_file() or source.is_symlink():
        raise RuntimeError(f"Expected an ordinary built file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o755 if executable else 0o644)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    path.chmod(0o644)


def legal_files(directory: Path, recursive: bool = True) -> list[Path]:
    result = []
    for current, directories, files in os.walk(directory, followlinks=False):
        directories[:] = sorted(name for name in directories
                                if name not in {".git", "target", "node_modules", ".github"}
                                and not (Path(current) / name).is_symlink()) if recursive else []
        result.extend(Path(current) / name for name in sorted(files)
                      if LEGAL_NAME.match(name) and not (Path(current) / name).is_symlink())
    return sorted(result)


def cargo_licenses(repo: Path, bundle: Path, target: str) -> dict:
    """Collect normal dependency closures, including their published notices.

    Cargo's resolved normal graph may include proc-macro crates. It does not prove
    which machine-code sections survived the final link; the manifest says so.
    """
    roots = [("weber/Cargo.toml", "weber-engine"),
             ("weber/runtime-config/Cargo.toml", "weber-runtime-config"),
             ("weber/native-example/Cargo.toml", "weber-native-example")]
    collected = {}
    locks = []
    for manifest, package_name in roots:
        # Other members of the engine workspace were not necessarily built.
        # Cargo may fetch their locked package sources to describe the graph;
        # it never builds or downloads executable artifacts in this operation.
        metadata = json.loads(command(["cargo", "metadata", "--format-version", "1", "--locked",
                                       "--filter-platform", target,
                                       "--manifest-path", str(repo / manifest)], repo))
        packages = {item["id"]: item for item in metadata["packages"]}
        nodes = {item["id"]: item for item in metadata["resolve"]["nodes"]}
        pending = [item["id"] for item in packages.values() if item["name"] == package_name]
        if len(pending) != 1:
            raise RuntimeError(f"Expected one Cargo package named {package_name}")
        visited = set()
        while pending:
            identity = pending.pop()
            if identity in visited:
                continue
            visited.add(identity)
            package = packages[identity]
            directory = Path(package["manifest_path"]).parent
            source = package.get("source") or "workspace:" + str(directory.relative_to(repo))
            key = f"{package['name']}-{package['version']}-{hashlib.sha256(source.encode()).hexdigest()[:12]}"
            if key not in collected:
                paths = []
                available = legal_files(directory)
                declared = package.get("license_file")
                if declared:
                    filename = (directory / declared).resolve()
                    if filename.is_file() and filename not in available:
                        # A workspace package may intentionally inherit a root license.
                        available.append(filename)
                for index, filename in enumerate(sorted(available)):
                    relative = filename.relative_to(directory) if filename.is_relative_to(directory) else Path(f"declared-{index}-{filename.name}")
                    destination = Path("licenses/cargo") / key / relative
                    copy_file(filename, bundle / destination)
                    paths.append(destination.as_posix())
                collected[key] = {"name": package["name"], "version": package["version"],
                                  "source": source, "declaredLicense": package.get("license"),
                                  "files": sorted(paths), "noticeFilesFound": bool(paths)}
            for dependency in nodes[identity]["deps"]:
                if any(kind["kind"] is None for kind in dependency["dep_kinds"]):
                    pending.append(dependency["pkg"])
        lock = Path(metadata["workspace_root"]) / "Cargo.lock"
        if not lock.is_file():
            raise RuntimeError(f"Missing resolved lockfile: {lock}")
        destination = Path("build-inputs") / str(lock.relative_to(repo))
        copy_file(lock, bundle / destination)
        locks.append({"path": destination.as_posix(), "sha256": digest(lock)})
    return {"scope": "Resolved normal dependency closures for engine, launcher and native example; may include proc macros. Available notices are collected, and missing files remain explicit. This is not a complete legal audit of native transitive components.",
            "packages": [collected[key] for key in sorted(collected)], "lockfiles": locks}


def elf_requirements(path: Path) -> dict:
    with path.open("rb") as stream:
        magic = stream.read(4)
    if magic != b"\x7fELF":
        raise RuntimeError(f"Expected Linux ELF binary: {path}")
    versions = command(["readelf", "--version-info", str(path)])
    requirements = {}
    for family in ("GLIBC", "GLIBCXX", "CXXABI"):
        values = set(re.findall(rf"\b{family}_([0-9]+(?:\.[0-9]+)+)\b", versions))
        if values:
            requirements[family] = max(values, key=lambda value: tuple(map(int, value.split("."))))
    dynamic = command(["readelf", "--dynamic", str(path)])
    return {"requiredSymbolVersions": requirements,
            "neededSharedLibraries": sorted(re.findall(r"\(NEEDED\).*\[([^\]]+)\]", dynamic))}


def archive_tree(source: Path, destination: Path, epoch: int) -> None:
    """Stable order, owner, timestamp and gzip header for identical build inputs."""
    with destination.open("wb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path in [source, *sorted(source.rglob("*"))]:
                    if path.is_symlink():
                        raise RuntimeError(f"Unexpected symlink in assembled bundle: {path}")
                    info = archive.gettarinfo(str(path), arcname=str(path.relative_to(source.parent)))
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mtime = epoch
                    info.mode = 0o755 if path.is_dir() or os.access(path, os.X_OK) else 0o644
                    if path.is_file():
                        with path.open("rb") as stream:
                            archive.addfile(info, stream)
                    else:
                        archive.addfile(info)


def build(repo: Path, output: Path) -> Path:
    if platform.system() != "Linux":
        raise RuntimeError("This development bundle targets Linux only")
    revision = command(["git", "rev-parse", "HEAD"], repo)
    obscura = repo / "weber/vendor/obscura"
    obscura_revision = command(["git", "rev-parse", "HEAD"], obscura)
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH") or command(["git", "show", "-s", "--format=%ct", "HEAD"], repo))
    target = next(line.split(": ", 1)[1] for line in command(["rustc", "-vV"]).splitlines() if line.startswith("host: "))
    name = f"weber-{target}-development-{revision[:12]}"
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"{name}.tar.gz"
    if destination.exists():
        raise RuntimeError(f"Output already exists: {destination}")
    with tempfile.TemporaryDirectory(prefix="weber-bundle-") as temporary:
        bundle = Path(temporary) / name
        bundle.mkdir()
        binary_sources = {
            "weber-backend": "weber/runtime-config/target/release/weber-backend",
            "electron-runtime/bin/weber-desktop-host": "out/runtime/weber-desktop-host",
            "electron-runtime/bin/weber-obscura-renderer": "out/runtime/obscura/weber-obscura-renderer",
            "examples/native/weber-native-example": "weber/native-example/target/release/weber-native-example",
        }
        runtime = repo / "weber/electron-runtime"
        addon = "dist/native/weber_platform.node"
        binary_sources[f"electron-runtime/{addon}"] = f"weber/electron-runtime/{addon}"
        for relative, source in binary_sources.items():
            copy_file(repo / source, bundle / relative, executable=True)
        for filename in RUNTIME_HELPERS:
            copy_file(runtime / filename, bundle / "electron-runtime" / filename)
        manifest = json.loads((runtime / "dist/source-manifest.json").read_text())
        for item in manifest["sources"]:
            if digest(repo / item["path"]) != item["sha256"]:
                raise RuntimeError(f"Compiled Electron source is stale: {item['path']}")
        for path in sorted((runtime / "dist").rglob("*")):
            if path.is_file():
                if path == runtime / addon:
                    continue  # Already copied and inspected as a native binary.
                if path.suffix not in {".js", ".map", ".json"}:
                    raise RuntimeError(f"Unexpected compiler output in runtime: {path}")
                copy_file(path, bundle / "electron-runtime/dist" / path.relative_to(runtime / "dist"))
        for backend in ("node", "bun"):
            project = bundle / "examples" / backend
            for filename in ("main.cjs", "preload.cjs", "index.html", "package.json"):
                copy_file(runtime / "fixture" / filename, project / filename)
            (project / "weber.toml").write_text(f'[backend]\nkind = "{backend}"\nentry = "main.cjs"\n')
        copy_file(repo / "weber/native-example/index.html", bundle / "examples/native/index.html")
        (bundle / "examples/native/weber.toml").write_text('[backend]\nkind = "native"\nexecutable = "weber-native-example"\n')
        for label, directory, required in (("electron", repo, True), ("weber", repo / "weber", False), ("obscura", obscura, True)):
            files = legal_files(directory, recursive=False)
            if required and not files:
                raise RuntimeError(f"Missing upstream license/notice files: {directory}")
            for path in files:
                copy_file(path, bundle / "licenses" / label / path.name)
        licenses = cargo_licenses(repo, bundle, target)
        write_json(bundle / "licenses/cargo-inventory.json", licenses)
        patches = []
        for patch in sorted((repo / "weber/patches/obscura").glob("*.patch")):
            relative = "build-inputs/obscura-patches/" + patch.name
            copy_file(patch, bundle / relative)
            patches.append({"path": relative, "sha256": digest(patch)})
        copy_file(runtime / "package-lock.json", bundle / "build-inputs/electron-runtime-package-lock.json")
        copy_file(repo / "weber/packaging/README.md", bundle / "README.md")
        copy_file(repo / "weber/packaging/smoke.py", bundle / "smoke.py")
        dirty = command(["git", "diff", "--name-only", "HEAD"], repo).splitlines()
        # Patched submodule is expected; enumerate its precise diff hash as well.
        engine_diff = subprocess.check_output(["git", "diff", "HEAD", "--binary"], cwd=obscura)
        files = [{"path": str(path.relative_to(bundle)), "bytes": path.stat().st_size, "sha256": digest(path)}
                 for path in sorted(bundle.rglob("*")) if path.is_file()]
        write_json(bundle / "bundle-manifest.json", {
            "schema": 1, "kind": "linux-development-runtime", "osSandbox": False,
            "source": {"weberCommit": revision, "electronCommit": ELECTRON_COMMIT,
                       "obscuraCommit": obscura_revision, "obscuraWorkingDiffSha256": hashlib.sha256(engine_diff).hexdigest(),
                       "trackedWorkingTreeChanges": dirty, "obscuraPatches": patches},
            "build": {"sourceDateEpoch": epoch, "target": target, "machine": platform.machine(),
                      "libc": list(platform.libc_ver()), "rustc": command(["rustc", "--version"])},
            "requirements": {"externalJavaScriptBackends": ["Node.js 24", "Bun (CommonJS only; use the tested CI version)"],
                             "nativeBackendNeedsNodeOrBun": False, "system": ["Linux with glibc", "GTK 3", "X11 display", "fontconfig and fonts", "libstdc++"],
                             "compatibilityNote": "ELF symbol versions below are direct requirements, not a promise of portability. Use the same or newer compatible distribution as the build; system shared libraries can impose additional requirements.",
                             "binaries": {relative: elf_requirements(bundle / relative) for relative in sorted(binary_sources)}},
            "licensing": {"cargoInventory": "licenses/cargo-inventory.json", "completeThirdPartyAudit": False},
            "files": files,
        })
        archive_tree(bundle, destination, epoch)
    (output / f"{name}.tar.gz.sha256").write_text(f"{digest(destination)}  {destination.name}\n")
    print(json.dumps({"archive": str(destination), "sha256": digest(destination), "bytes": destination.stat().st_size}))
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, default=Path("out/development-bundle"))
    arguments = parser.parse_args()
    try:
        build(arguments.repo.resolve(), arguments.output.resolve())
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Cannot assemble Weber development bundle: {error}\n")

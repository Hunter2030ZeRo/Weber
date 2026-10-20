#!/usr/bin/env python3
"""Relocatable Linux bundle; system glibc, graphics drivers and fonts remain prerequisites."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--profile", choices=["dev", "release"], default="release")
parser.add_argument("--output", type=pathlib.Path, default=root / "target/package/weber")
parser.add_argument("--binary", type=pathlib.Path)
options = parser.parse_args()
binary = options.binary or root / "target" / ("debug" if options.profile == "dev" else "release") / "weber-servo"
output = options.output.resolve()
if output == root or root in output.parents and "target" not in output.relative_to(root).parts:
    raise SystemExit("Package output must be outside sources or under target/")
output.mkdir(parents=True, exist_ok=True)
(output / "lib").mkdir(exist_ok=True)
patchelf = shutil.which("patchelf")
if not patchelf:
    raise SystemExit("patchelf is required for relocatable ELF loader paths")
shutil.copy2(binary, output / "weber")
dependencies = {}
link_env = {**os.environ, "LD_LIBRARY_PATH": str(root / "target/hermes/lib") + ":" + str(root / "target/hermes/jsi")}
for line in subprocess.check_output(["ldd", str(binary)], text=True, env=link_env).splitlines():
    if "not found" in line:
        raise SystemExit(line)
    match = re.search(r"^\s*(\S+) => (/\S+)", line)
    if not match:
        continue
    name, path = match.groups()
    if "/" in name:
        if pathlib.Path(name).name.startswith("ld-linux"):
            continue
        raise SystemExit(f"Absolute DT_NEEDED entry cannot be bundled safely: {name}")
    # Keep glibc paired with the host loader. GPU/Wayland libraries opened with
    # dlopen also come from the host, rather than bundling a mismatched driver.
    if name in {"libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1", "libresolv.so.2"}:
        continue
    target = output / "lib" / name
    shutil.copy2(pathlib.Path(path).resolve(), target)
    subprocess.run([patchelf, "--set-rpath", "$ORIGIN", str(target)], check=True)
    dependencies[name] = {"source": path, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
subprocess.run([patchelf, "--set-rpath", "$ORIGIN/lib", str(output / "weber")], check=True)
build = json.loads(subprocess.check_output([str(output / "weber"), "--build-info"], text=True))
if build["profile"] != ("debug" if options.profile == "dev" else "release"):
    raise SystemExit("Selected binary does not match requested package profile")
notices = output / "notices"
notices.mkdir(exist_ok=True)
for name, source in {"Servo-MPL-2.0": root / "vendor/servo/LICENSE", "Hermes-MIT": root / "vendor/hermes/LICENSE"}.items():
    if source.is_file():
        shutil.copy2(source, notices / name)
for package in ["icu", "fontconfig", "freetype2", "zlib", "bzip2", "libpng", "expat", "brotli", "gcc-libs"]:
    source = pathlib.Path("/usr/share/licenses") / package
    if source.is_dir():
        shutil.copytree(source, notices / package, dirs_exist_ok=True)
shutil.copytree(root / "patches", output / "patches", dirs_exist_ok=True)
(output / "README.txt").write_text("Weber Linux Wayland prototype\n\n" +
    ("This host supports native AOT and SpiderMonkey JIT.\n" if build.get("aotAvailable", True) else "This is a SpiderMonkey JIT-only host; Hermes is not linked.\n") +
    "Run ./weber for the embedded demo, or ./weber --app ./application for a packaged app.\nRequires compatible Linux glibc/loader, Wayland/EGL/GPU drivers and fonts.\nNo host installation is performed. See manifest.json for build/dependency hashes.\n")

manifest = {"profile": options.profile, "build": build, "executableSha256": hashlib.sha256((output / "weber").read_bytes()).hexdigest(), "privateLibraries": dependencies, "hostPrerequisites": ["compatible glibc/loader", "Wayland compositor", "system GPU/EGL/Wayland drivers", "fonts"]}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps({"bundle": str(output), "profile": options.profile, "privateLibraries": len(dependencies), "sizeBytes": sum(path.stat().st_size for path in output.rglob("*") if path.is_file())}, indent=2))

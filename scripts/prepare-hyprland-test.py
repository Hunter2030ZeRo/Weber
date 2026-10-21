"""Prepare optional CachyOS x86-64-v3 Hyprland test binaries inside target/.

These pinned test tools are never installed into the OS or shipped with Weber.
Host ABI libraries must be compatible; other systems can supply their own
Hyprland prefix with WEBER_TEST_HYPRLAND_ROOT.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

project = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--offline', action='store_true')
args = parser.parse_args()
root = project / 'target/test-tools/hyprland'
cache = root / 'packages'
cache.mkdir(parents=True, exist_ok=True)
records = json.loads((project / 'native/testing/hyprland-test-packages.json').read_text())
for record in records:
    path = cache / record['url'].rsplit('/', 1)[1]
    if not path.exists():
        if args.offline:
            raise SystemExit(f'Missing test package: {path.name}')
        urllib.request.urlretrieve(record['url'], path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
        raise SystemExit(f'Test package checksum mismatch: {path.name}')
    # The pinned archives were also verified against the configured distro keyring
    # when selected. Reverify available signatures without changing any keyring.
    signature = path.with_name(path.name + '.sig')
    if signature.exists():
        subprocess.run(['gpgv', '--keyring', '/etc/pacman.d/gnupg/pubring.gpg', str(signature), str(path)], check=True)
    subprocess.run(['tar', '--zstd', '-xf', str(path), '-C', str(root), '--exclude=.PKGINFO', '--exclude=.BUILDINFO', '--exclude=.MTREE'], check=True)
(root / 'packages.json').write_text(json.dumps(records, indent=2) + '\n')
print(root)

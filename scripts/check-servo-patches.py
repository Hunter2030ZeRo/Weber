"""Check ordered Servo patches against pristine pinned sources and the build tree."""
import json
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
vendor = root / "vendor/servo"
revision = "aac43a3f31a259f04a574f5ec4e959c943ad7cc7"
names = ["transient-observers", "sync-host", "time-origin", "keyboard-click",
         "binary-host", "small-dom-scheduling", "safe-cut", "document-envelope", "font-lifecycle", "ime-composition"]
patches = [root / "patches" / f"servo-{name}.patch" for name in names]


def git(args, cwd=vendor):
    return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.STDOUT)


assert git(["rev-parse", "HEAD"]).decode().strip() == revision
paths = sorted({line[6:] for patch in patches for line in patch.read_text().splitlines()
                if line.startswith("+++ b/")})
with tempfile.TemporaryDirectory(prefix="weber-servo-patches-") as directory:
    clean = Path(directory)
    for name in paths:
        path = clean / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(git(["show", f"{revision}:{name}"]))
    for patch in patches:
        git(["apply", "--check", str(patch)], clean)
        git(["apply", str(patch)], clean)
    for name in paths:
        assert (clean / name).read_bytes() == (vendor / name).read_bytes(), name

result = {"passed": True, "revision": revision, "patches": [p.name for p in patches],
          "files": paths, "compiledCheckoutMatchesCleanApply": True}
(root / "artifacts/preview-patches.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))

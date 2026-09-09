#!/usr/bin/env python3
"""Read-only full-Electron-build preflight. Does not imply engine replacement."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path.cwd())
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
disk = shutil.disk_usage(root)
free = disk.free
memory = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
for path in [Path('/sys/fs/cgroup/memory.max'), Path('/sys/fs/cgroup/memory/memory.limit_in_bytes')]:
    try:
        value = path.read_text().strip()
        if value.isdigit():
            memory = min(memory, int(value))
    except OSError:
        pass
files = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'], text=True).split('\0')
# Evidence of source dependencies, not a complete semantic dependency graph.
references = []
for name in files:
    if not name.startswith(('shell/', 'lib/')) or not name.endswith(('.h', '.cc', '.ts')):
        continue
    path = root / name
    if not path.is_file():
        continue
    count = len(re.findall(r'content::|content/public/|third_party/blink/|ui/views/', path.read_text(errors='replace')))
    if count:
        references.append({'path': name, 'references': count})
references.sort(key=lambda item: (-item['references'], item['path']))
tools = {name: shutil.which(name) for name in ['git', 'python3', 'gn', 'gclient', 'autoninja', 'ninja', 'clang++']}
report = {
    'source_commit': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
    'free_disk_bytes': free,
    'disk_total_bytes': disk.total,
    'effective_memory_bytes': memory,
    'cpu_count': os.cpu_count(),
    'documented_baseline_free_disk_bytes': 100_000_000_000,
    'documented_baseline_memory_bytes': 8_000_000_000,
    'requirement_source': 'https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/build_instructions.md',
    'tools': tools,
    'chromium_dependency_tree_present': (root.parent / 'content/public').is_dir(),
    'source_files_with_chromium_references': len(references),
    'source_reference_samples': references[:30],
    'resource_prerequisites_met': free >= 100_000_000_000 and memory >= 8_000_000_000,
    'mvp_complete': False,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))

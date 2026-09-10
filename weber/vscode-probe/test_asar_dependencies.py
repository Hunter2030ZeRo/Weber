"""Behavioral fixtures for authentic ASAR dependency expansion, without Electron."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import asar_dependencies as asar


def archive_bytes(header: dict | str, body: bytes = b'') -> bytes:
    """Chromium Pickle: uint32-size pickle, then a pickle containing JSON string."""
    data = (header if isinstance(header, str) else json.dumps(header)).encode('utf-8')
    payload = struct.pack('<I', len(data)) + data
    payload += b'\0' * (-len(payload) % 4)
    header_pickle = struct.pack('<I', len(payload)) + payload
    return struct.pack('<II', 4, len(header_pickle)) + header_pickle + body


def files_archive(files: dict[str, bytes], unpacked: set[str] | None = None,
                  executable: set[str] | None = None) -> bytes:
    tree, body = {'files': {}}, bytearray()
    for path, data in files.items():
        node = tree['files']
        parts = path.split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {'files': {}})['files']
        entry = {'size': len(data)}
        if path in (unpacked or set()):
            entry['unpacked'] = True
        else:
            entry['offset'] = str(len(body))
            body.extend(data)
        if path in (executable or set()):
            entry['executable'] = True
        node[parts[-1]] = entry
    return archive_bytes(tree, bytes(body))


@unittest.skipUnless(os.name == 'posix', 'Requires POSIX no-follow filesystem operations')
class AsarDependenciesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='weber-asar-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / 'app'
        self.app.mkdir()
        self.archive = self.app / 'node_modules.asar'

    def write(self, path: str, data: bytes):
        file = self.app / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        return file

    def rejected(self, message: str | None = None):
        if message:
            with self.assertRaisesRegex(asar.AsarExpansionError, message):
                asar.expand_dependencies(self.app)
        else:
            with self.assertRaises(asar.AsarExpansionError):
                asar.expand_dependencies(self.app)

    def test_expands_packed_and_unpacked_sources_preserving_bytes_and_metadata(self):
        files = {
            '@vscode/spdlog/package.json': b'{"name":"@vscode/spdlog","main":"index.js"}',
            '@vscode/spdlog/index.js': b'module.exports=require("./build/Release/spdlog.node");',
            '@vscode/spdlog/build/Release/spdlog.node': b'\x7fELF\x00fixture-addon',
            'tool/bin/run': b'#!/bin/sh\nexit 0\n',
            'empty.txt': b'',
        }
        native = '@vscode/spdlog/build/Release/spdlog.node'
        original = files_archive(files, {native}, {'tool/bin/run'})
        self.archive.write_bytes(original)
        unpacked = self.write('node_modules.asar.unpacked/' + native, files[native])
        package = self.write('package.json', b'{"main":"out/main.js"}')
        main = self.write('out/main.js', b'import "@vscode/spdlog";')
        duplicate = self.write('node_modules/empty.txt', b'')
        duplicate_info = duplicate.stat()

        report = asar.expand_dependencies(self.app)
        for path, data in files.items():
            self.assertEqual((self.app / 'node_modules' / path).read_bytes(), data)
        self.assertEqual(self.archive.read_bytes(), original)
        self.assertEqual(unpacked.read_bytes(), files[native])
        self.assertEqual(package.read_bytes(), b'{"main":"out/main.js"}')
        self.assertEqual(main.read_bytes(), b'import "@vscode/spdlog";')
        self.assertEqual(duplicate.stat().st_ino, duplicate_info.st_ino)
        self.assertEqual(duplicate.stat().st_mtime_ns, duplicate_info.st_mtime_ns)
        self.assertEqual((self.app / 'node_modules/tool/bin/run').stat().st_mode & 0o777, 0o755)
        self.assertEqual(report['archiveSHA256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(report['fileCount'], 5)
        self.assertEqual(report['expandedFiles'], 4)
        self.assertEqual(report['preservedFiles'], 1)
        self.assertEqual(report['expandedBytes'], sum(map(len, files.values())))
        self.assertEqual(report['nativeAddonCount'], 1)
        self.assertTrue(report['sourceBytesPreserved'])
        self.assertFalse(report['transparentAsarFilesystem'])
        expected = hashlib.sha256()
        for path, data in sorted(files.items()):
            expected.update(f'{path}\0{len(data)}\0{hashlib.sha256(data).hexdigest()}\n'.encode())
        self.assertEqual(report['filesSHA256'], expected.hexdigest())
        second = asar.expand_dependencies(self.app)
        self.assertEqual(second['expandedFiles'], 0)
        self.assertEqual(second['preservedFiles'], 5)
        self.assertEqual(second['filesSHA256'], report['filesSHA256'])

    def test_collision_is_rejected_before_any_new_file_is_written(self):
        self.archive.write_bytes(files_archive({'a/new.js': b'new', 'z.js': b'one'}))
        old = self.write('node_modules/z.js', b'two')
        self.rejected('collision')
        self.assertEqual(old.read_bytes(), b'two')
        self.assertFalse((self.app / 'node_modules/a').exists())

    def test_unpacked_helpers_without_executable_header_can_run_without_special_bits(self):
        files = {'tool/bin/run': b'#!/bin/sh\nprintf authentic-helper\n',
                 'tool/data.txt': b'non-executable data'}
        self.archive.write_bytes(files_archive(files, set(files)))
        helper = self.write('node_modules.asar.unpacked/tool/bin/run', files['tool/bin/run'])
        helper.chmod(0o4755)
        data = self.write('node_modules.asar.unpacked/tool/data.txt', files['tool/data.txt'])
        data.chmod(0o644)
        report = asar.expand_dependencies(self.app)
        output = self.app / 'node_modules/tool/bin/run'
        self.assertEqual(subprocess.check_output([str(output)]), b'authentic-helper')
        self.assertEqual(output.stat().st_mode & 0o7777, 0o755)
        self.assertEqual((self.app / 'node_modules/tool/data.txt').stat().st_mode & 0o7777, 0o644)
        self.assertEqual(helper.stat().st_mode & 0o7777, 0o4755)
        self.assertEqual(report['newExecutableFiles'], 1)

    def test_missing_or_wrong_size_unpacked_file_is_rejected_before_writes(self):
        native = 'z/native.node'
        self.archive.write_bytes(files_archive({'a.js': b'good', native: b'ELF'}, {native}))
        self.rejected()
        self.assertFalse((self.app / 'node_modules').exists())
        self.write('node_modules.asar.unpacked/' + native, b'wrong-size')
        self.rejected('size mismatch')
        self.assertFalse((self.app / 'node_modules').exists())

    def test_rejects_truncation_and_inconsistent_pickle_lengths(self):
        good = files_archive({'a': b'123'})
        variants = [good[:7], good[:15], good[:-1]]
        for offset, value in [(0, 8), (4, 9), (8, 1), (12, 0), (12, 0xffffffff)]:
            bad = bytearray(good)
            struct.pack_into('<I', bad, offset, value)
            variants.append(bytes(bad))
        for data in variants:
            with self.subTest(length=len(data), prefix=data[:16]):
                self.archive.write_bytes(data)
                self.rejected()

    def test_rejects_paths_links_duplicate_json_keys_and_file_bounds(self):
        entries = [
            {'../escape': {'size': 1, 'offset': '0'}},
            {'..': {'files': {'escape': {'size': 1, 'offset': '0'}}}},
            {'/absolute': {'size': 1, 'offset': '0'}},
            {'C:drive': {'size': 1, 'offset': '0'}},
            {'a\\b': {'size': 1, 'offset': '0'}},
            {'nul\0name': {'size': 1, 'offset': '0'}},
            {'link': {'link': '../escape'}},
            {'a': {'size': 2, 'offset': '0'}},
            {'a': {'size': 1, 'offset': '99999999999999999999'}},
            {'a': {'size': -1, 'offset': '0'}},
            {'a': {'size': True, 'offset': '0'}},
            {'a': {'size': 1.5, 'offset': '0'}},
            {'a': {'size': 1, 'offset': '-1'}},
            {'a': {'size': 1, 'offset': 0}},
            {'a': {'size': 1, 'offset': '0', 'unpacked': 'yes'}},
            {'a': {'files': {}, 'size': 1}},
        ]
        for files in entries:
            with self.subTest(files=files):
                self.archive.write_bytes(archive_bytes({'files': files}, b'x'))
                self.rejected()
        self.archive.write_bytes(archive_bytes('{"files":{"a":{},"a":{}}}'))
        self.rejected('Duplicate')
        self.assertFalse((self.app / 'node_modules').exists())
        self.assertFalse((self.root / 'escape').exists())

    def test_rejects_symlinks_in_destination_and_unpacked_ancestors(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'index.js').write_bytes(b'original')
        self.archive.write_bytes(files_archive({'pkg/index.js': b'original'}))
        modules = self.app / 'node_modules'
        modules.symlink_to(outside, target_is_directory=True)
        self.rejected()
        modules.unlink()
        modules.mkdir()
        (modules / 'pkg').symlink_to(outside, target_is_directory=True)
        self.rejected()
        (modules / 'pkg').unlink()
        (modules / 'pkg').mkdir()
        (modules / 'pkg/index.js').symlink_to(outside / 'index.js')
        self.rejected()
        self.assertEqual((outside / 'index.js').read_bytes(), b'original')

        self.archive.write_bytes(files_archive({'pkg/native.node': b'ELF'}, {'pkg/native.node'}))
        (outside / 'native.node').write_bytes(b'ELF')
        unpacked = self.app / 'node_modules.asar.unpacked'
        unpacked.symlink_to(outside, target_is_directory=True)
        self.rejected()
        unpacked.unlink()
        unpacked.mkdir()
        (unpacked / 'pkg').symlink_to(outside, target_is_directory=True)
        self.rejected()
        self.assertFalse((modules / 'pkg/native.node').exists())

    def test_rejects_archive_and_application_ancestor_symlinks(self):
        outside = self.root / 'archive'
        outside.write_bytes(files_archive({'a': b'x'}))
        self.archive.symlink_to(outside)
        self.rejected()
        self.archive.unlink()
        self.archive.write_bytes(outside.read_bytes())
        link = self.root / 'app-link'
        link.symlink_to(self.app, target_is_directory=True)
        with self.assertRaises(asar.AsarExpansionError):
            asar.expand_dependencies(link)

    def test_bounds_on_header_files_total_entries_depth_and_individual_size(self):
        self.archive.write_bytes(files_archive({'a/b': b'12', 'c': b'34'}))
        for name, value in [('MAX_ARCHIVE', 16), ('MAX_HEADER', 8), ('MAX_FILES', 1),
                            ('MAX_ENTRIES', 1), ('MAX_TOTAL', 3), ('MAX_DEPTH', 1), ('MAX_FILE', 1)]:
            with self.subTest(limit=name), patch.object(asar, name, value):
                self.rejected()
        self.assertFalse((self.app / 'node_modules').exists())


if __name__ == '__main__':
    unittest.main()

"""Expand authentic ASAR dependencies for an optional temporary-app diagnostic.

This changes dependency layout, not application source. It does not implement
Electron's transparent ASAR filesystem and must not replace the strict probe.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
import struct

MAX_ARCHIVE = 1024 * 1024 * 1024
MAX_HEADER = 32 * 1024 * 1024
MAX_FILE = 512 * 1024 * 1024
MAX_TOTAL = 3 * 1024 * 1024 * 1024
MAX_FILES = 200_000
MAX_ENTRIES = 250_000
MAX_DEPTH = 64
CHUNK = 1024 * 1024


class AsarExpansionError(ValueError):
    pass


def _fail(message: str) -> None:
    raise AsarExpansionError(message)


@contextmanager
def _directory(root: int, parts: tuple[str, ...], create: bool = False):
    """Walk relative to owned directory descriptors, never following symlinks."""
    descriptor = os.dup(root)
    try:
        for part in parts:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=descriptor)
            except FileNotFoundError:
                if not create:
                    yield None
                    return
                try:
                    os.mkdir(part, 0o755, dir_fd=descriptor)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def _regular(root: int, parts: tuple[str, ...]):
    with _directory(root, parts[:-1]) as parent:
        if parent is None:
            _fail(f"Missing ASAR file: {'/'.join(parts)}")
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=parent)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                _fail(f"ASAR path is not a regular file: {'/'.join(parts)}")
            yield descriptor
        finally:
            os.close(descriptor)


def _chunks(descriptor: int, offset: int, size: int):
    while size:
        chunk = os.pread(descriptor, min(CHUNK, size), offset)
        if not chunk:
            _fail("Truncated ASAR source data")
        yield chunk
        offset += len(chunk)
        size -= len(chunk)


def _digest(chunks) -> str:
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk)
    return digest.hexdigest()


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _fail(f"Duplicate ASAR header key: {key!r}")
        value[key] = item
    return value


def _header(archive: int, archive_size: int) -> tuple[dict, int]:
    prefix = os.pread(archive, 16, 0)
    if len(prefix) != 16:
        _fail("Truncated ASAR pickle header")
    size_payload, header_size, header_payload, json_size = struct.unpack('<IIII', prefix)
    if size_payload != 4 or not 8 <= header_size <= MAX_HEADER or header_size % 4:
        _fail("Invalid ASAR pickle header length")
    if header_payload != header_size - 4 or header_payload != (4 + json_size + 3) & ~3:
        _fail("Inconsistent ASAR JSON pickle length")
    if not json_size or 8 + header_size > archive_size:
        _fail("Truncated or empty ASAR JSON header")
    raw = os.pread(archive, json_size, 16)
    if len(raw) != json_size:
        _fail("Truncated ASAR JSON header")
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise AsarExpansionError("Invalid ASAR JSON header") from error
    if not isinstance(value, dict) or not isinstance(value.get('files'), dict):
        _fail("ASAR header has no file tree")
    return value, 8 + header_size


def _entries(header: dict, body_size: int) -> list[dict]:
    files, total, visited = [], 0, 0
    pending = [((), header['files'], False)]
    while pending:
        parent, children, inherited_unpacked = pending.pop()
        if len(parent) >= MAX_DEPTH:
            _fail("ASAR tree exceeds depth limit")
        for name, entry in children.items():
            visited += 1
            if visited > MAX_ENTRIES:
                _fail("ASAR tree exceeds entry limit")
            if (not name or name in ('.', '..') or any(c in name for c in '/\\:\0')
                    or any(ord(c) < 32 for c in name)
                    or len(name.encode('utf-8')) > 255):
                _fail(f"Unsafe ASAR path component: {name!r}")
            parts = (*parent, name)
            if len('/'.join(parts).encode('utf-8')) > 4096:
                _fail("ASAR path exceeds length limit")
            if not isinstance(entry, dict) or 'link' in entry:
                _fail("ASAR links and non-object entries are unsupported")
            unpacked = entry.get('unpacked', inherited_unpacked)
            executable = entry.get('executable', False)
            if type(unpacked) is not bool or type(executable) is not bool:
                _fail("Invalid ASAR unpacked/executable flag")
            if 'files' in entry:
                if not isinstance(entry['files'], dict) or 'size' in entry or 'offset' in entry:
                    _fail("Invalid ASAR directory entry")
                pending.append((parts, entry['files'], unpacked))
                continue
            size = entry.get('size')
            if type(size) is not int or not 0 <= size <= MAX_FILE:
                _fail("ASAR file exceeds size limit or has invalid size")
            total += size
            if total > MAX_TOTAL or len(files) >= MAX_FILES:
                _fail("ASAR dependency expansion exceeds file/byte limit")
            offset = 0
            if not unpacked:
                raw_offset = entry.get('offset')
                if (not isinstance(raw_offset, str) or not raw_offset.isascii()
                        or not raw_offset.isdecimal() or len(raw_offset) > 20):
                    _fail("Invalid ASAR file offset")
                offset = int(raw_offset)
                if offset > body_size or size > body_size - offset:
                    _fail("ASAR file offset/size lies outside archive")
            files.append(dict(parts=parts, size=size, offset=offset,
                              unpacked=unpacked, executable=executable))
    return sorted(files, key=lambda entry: entry['parts'])


def _source(app: int, archive: int, body_offset: int, entry: dict):
    if entry['unpacked']:
        with _regular(app, ('node_modules.asar.unpacked', *entry['parts'])) as source:
            if os.fstat(source).st_size != entry['size']:
                _fail(f"Unpacked ASAR file size mismatch: {'/'.join(entry['parts'])}")
            yield from _chunks(source, 0, entry['size'])
    else:
        yield from _chunks(archive, body_offset + entry['offset'], entry['size'])


def _output_mode(app: int, entry: dict) -> int:
    if entry['unpacked']:
        # ASAR omits `executable` for unpacked entries. Their real file mode
        # remains authoritative, including helper binaries such as ripgrep.
        with _regular(app, ('node_modules.asar.unpacked', *entry['parts'])) as source:
            executable = bool(os.fstat(source).st_mode & stat.S_IXUSR)
    else:
        executable = entry['executable']
    # Never copy setuid, setgid, sticky bits or writable group/other modes.
    return 0o755 if executable else 0o644


def _existing(app: int, archive: int, body_offset: int, entry: dict) -> bool:
    parts = ('node_modules', *entry['parts'])
    with _directory(app, parts[:-1]) as parent:
        if parent is None:
            return False
        try:
            info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(info.st_mode) or info.st_size != entry['size']:
            _fail(f"Dependency collision or non-regular destination: {'/'.join(parts)}")
        with _regular(parent, (parts[-1],)) as existing:
            offset = 0
            for chunk in _source(app, archive, body_offset, entry):
                if os.pread(existing, len(chunk), offset) != chunk:
                    _fail(f"Dependency collision: {'/'.join(parts)}")
                offset += len(chunk)
            if os.fstat(existing).st_size != offset:
                _fail(f"Dependency changed during comparison: {'/'.join(parts)}")
    return True


def _expand(app: int) -> dict:
    with _regular(app, ('node_modules.asar',)) as archive:
        archive_size = os.fstat(archive).st_size
        if not 16 <= archive_size <= MAX_ARCHIVE:
            _fail("ASAR archive exceeds size limit or is truncated")
        header, body_offset = _header(archive, archive_size)
        entries = _entries(header, archive_size - body_offset)
        archive_hash = _digest(_chunks(archive, 0, archive_size))
        aggregate = hashlib.sha256()
        # Validate every input and collision before creating any dependency.
        for entry in entries:
            entry['sha256'] = _digest(_source(app, archive, body_offset, entry))
            entry['output_mode'] = _output_mode(app, entry)
            entry['existing'] = _existing(app, archive, body_offset, entry)
            aggregate.update(('/'.join(entry['parts']) + '\0' + str(entry['size']) + '\0'
                              + entry['sha256'] + '\n').encode('utf-8'))
        expanded_count = expanded_bytes = 0
        for entry in entries:
            if entry['existing']:
                continue
            parts = ('node_modules', *entry['parts'])
            with _directory(app, parts[:-1], create=True) as parent:
                descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=parent)
                try:
                    with os.fdopen(descriptor, 'wb') as output:
                        digest = hashlib.sha256()
                        for chunk in _source(app, archive, body_offset, entry):
                            output.write(chunk)
                            digest.update(chunk)
                        if digest.hexdigest() != entry['sha256']:
                            _fail("ASAR source changed during expansion")
                        os.fchmod(output.fileno(), entry['output_mode'])
                except BaseException:
                    os.unlink(parts[-1], dir_fd=parent)
                    raise
            expanded_count += 1
            expanded_bytes += entry['size']
        return {
            'kind': 'temporary-asar-dependency-expansion',
            'archive': 'node_modules.asar', 'archiveBytes': archive_size,
            'archiveSHA256': archive_hash, 'sourceBytesPreserved': True,
            'appSourceModified': False, 'packageLayoutExpanded': True,
            'fileCount': len(entries), 'dependencyBytes': sum(e['size'] for e in entries),
            'expandedFiles': expanded_count, 'expandedBytes': expanded_bytes,
            'preservedFiles': len(entries) - expanded_count,
            'nativeAddonCount': sum(e['parts'][-1].endswith('.node') for e in entries),
            'newExecutableFiles': sum(not e['existing'] and e['output_mode'] == 0o755 for e in entries),
            'permissionPolicy': 'New files use 0755/0644 from unpacked owner-execute or packed executable flag; existing modes retained',
            'filesSHA256': aggregate.hexdigest(),
            'filesHashFormat': 'Sorted path + NUL + decimal size + NUL + file SHA256 + LF; UTF-8',
            'transparentAsarFilesystem': False,
        }


def expand_dependencies(app: Path) -> dict:
    """Expand only node_modules.asar in an already-temporary application tree.

    The caller must discard this temporary tree on failure: I/O failure during
    writing can leave previously completed new dependency files in place.
    Application source, package.json, the archive and unpacked inputs are never
    opened for writing. Existing dependencies are retained only byte-for-byte.
    """
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW'):
        _fail('ASAR expansion requires POSIX no-follow filesystem operations')
    absolute = Path(os.path.abspath(app))
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        with _directory(descriptor, absolute.parts[1:]) as root:
            if root is None:
                _fail('Temporary application directory does not exist')
            return _expand(root)
    except (OSError, UnicodeError) as error:
        raise AsarExpansionError(f'ASAR expansion filesystem/path failure: {error}') from error
    finally:
        os.close(descriptor)

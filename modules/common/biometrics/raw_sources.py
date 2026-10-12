"""Read-only inspection of server-owned cold archives before selected retention.

This adapter has the same bounded reader interface as retained artifacts, but
its inspection is only evidence about the current source. Selection must pass
the inspected descriptor to RawArtifactStore.retain(expected=...) before a
replay dataset can claim that bytes have been frozen.
"""
from contextlib import contextmanager
import gzip
import hashlib
import os
from pathlib import Path

from .raw_artifacts import (RawArtifact, RawLimits, BoundedRawReader, SOURCE_NAME,
                            CHUNK, _identity, _regular)
from .raw_records import inventory_retained


def archive_names(directory, *, maximum_entries=10000):
    if type(maximum_entries) is not int or maximum_entries <= 0:
        raise ValueError('Invalid archive discovery bound')
    root = Path(directory)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Invalid RAW archive directory')
    names = []
    with os.scandir(root) as entries:
        for count, entry in enumerate(entries, 1):
            if count > maximum_entries:
                raise ValueError('RAW archive discovery entry limit exceeded')
            if SOURCE_NAME.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                names.append(entry.name)
    return sorted(names)


class ArchiveSource:
    def __init__(self, directory, name, limits=RawLimits()):
        root = Path(directory)
        if root.is_symlink() or not root.is_dir() or not isinstance(name, str) or not SOURCE_NAME.fullmatch(name):
            raise ValueError('Invalid RAW archive source')
        self.path, self.limits = root / name, limits

    def _open(self):
        fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = _regular(fd)
            if info.st_size > self.limits.compressed_bytes:
                raise ValueError('RAW compressed byte limit exceeded')
            return fd, info
        except BaseException:
            os.close(fd)
            raise

    def _hash(self, fd):
        digest, size = hashlib.sha256(), 0
        while True:
            chunk = os.read(fd, CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > self.limits.compressed_bytes:
                raise ValueError('RAW compressed byte limit exceeded')
            digest.update(chunk)
        return digest.hexdigest(), size

    def inspect(self):
        fd, before = self._open()
        with os.fdopen(fd, 'rb') as source:
            digest, size = self._hash(source.fileno())
            source.seek(0)
            expanded = 0
            with gzip.GzipFile(fileobj=source) as stream:
                while True:
                    chunk = stream.read(min(CHUNK, self.limits.expanded_bytes - expanded + 1))
                    if not chunk:
                        break
                    expanded += len(chunk)
                    if expanded > self.limits.expanded_bytes:
                        raise ValueError('RAW expanded byte limit exceeded')
            if _identity(before) != _identity(_regular(source.fileno())):
                raise ValueError('RAW archive changed during inspection')
        descriptor = RawArtifact(digest + '.RAW.gz', digest, size, expanded)
        # Reopening with this exact hash detects replacement between passes.
        inventory = inventory_retained(self, descriptor)
        return {'source_name': self.path.name, 'retained': False,
                'artifact': descriptor, 'inventory': inventory}

    @contextmanager
    def open_raw(self, descriptor):
        if not isinstance(descriptor, RawArtifact) or descriptor.expanded_bytes > self.limits.expanded_bytes:
            raise ValueError('Invalid inspected RAW descriptor')
        fd, before = self._open()
        with os.fdopen(fd, 'rb') as source:
            digest, size = self._hash(source.fileno())
            if (digest, size) != (descriptor.sha256, descriptor.compressed_bytes):
                raise ValueError('RAW archive changed since inspection')
            source.seek(0)
            with gzip.GzipFile(fileobj=source) as stream:
                yield BoundedRawReader(stream, descriptor.expanded_bytes)
            if _identity(before) != _identity(_regular(source.fileno())):
                raise ValueError('RAW archive changed during reading')

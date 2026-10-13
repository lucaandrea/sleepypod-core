"""Private retained RAW artifacts; all directories are server-owned configuration.

Copy gzip bytes rather than keeping a checksum or a link into the rolling
archive. Publication and quota checks share a process lock. Readers verify the
retained checksum before exposing a bounded decompression stream.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import gzip
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import uuid

CHUNK = 64 * 1024
SOURCE_NAME = re.compile(r'[A-Za-z0-9_.-]+\.RAW\.gz\Z')
ARTIFACT_NAME = re.compile(r'[a-f0-9]{64}\.RAW\.gz\Z')
PART_NAME = re.compile(r'\.part-[a-f0-9]{32}\Z')


@dataclass(frozen=True)
class RawLimits:
    compressed_bytes: int = 256 * 1024 * 1024
    expanded_bytes: int = 512 * 1024 * 1024
    total_bytes: int = 1024 * 1024 * 1024
    minimum_free_bytes: int = 512 * 1024 * 1024
    max_artifacts: int = 1024

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in vars(self).values()):
            raise ValueError('RAW limits must be positive integers')


@dataclass(frozen=True)
class RawArtifact:
    name: str
    sha256: str
    compressed_bytes: int
    expanded_bytes: int

    def __post_init__(self):
        if not ARTIFACT_NAME.fullmatch(self.name) or self.name != self.sha256 + '.RAW.gz':
            raise ValueError('Invalid retained RAW identity')
        if any(type(value) is not int or value < 0 for value in (self.compressed_bytes, self.expanded_bytes)):
            raise ValueError('Invalid retained RAW size')


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('RAW input must be a regular file')
    return info


class BoundedRawReader:
    def __init__(self, stream, limit):
        self.stream, self.limit, self.position = stream, limit, 0

    def read(self, size=-1):
        if type(size) is not int or size < 0 or size > 1_000_000:
            raise ValueError('RAW reads must be bounded to at most one record')
        data = self.stream.read(min(size, self.limit - self.position + 1))
        self.position += len(data)
        if self.position > self.limit:
            raise ValueError('RAW expanded byte limit exceeded')
        if size > 0 and not data and self.position != self.limit:
            raise ValueError('RAW expanded size mismatch')
        return data

    def tell(self):
        return self.position


class RawArtifactStore:
    def __init__(self, directory, limits=RawLimits(), *, read_only=False):
        self.read_only = read_only
        self.directory = Path(directory)
        self.limits = limits
        if not read_only:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink() or not self.directory.is_dir():
            raise ValueError('Retained RAW directory must not be a symlink')
        if not read_only:
            os.chmod(self.directory, 0o700)

    @contextmanager
    def _lock(self):
        flags = os.O_RDONLY if self.read_only else os.O_CREAT | os.O_RDWR
        fd = os.open(self.directory / '.lock', flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            _regular(fd)
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def _usage(self):
        used, count = 0, 0
        for entry in self.directory.iterdir():
            if ARTIFACT_NAME.fullmatch(entry.name) or PART_NAME.fullmatch(entry.name):
                info = entry.lstat()
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('Invalid retained RAW directory entry')
                used += info.st_size
                count += int(bool(ARTIFACT_NAME.fullmatch(entry.name)))
        return used, count

    def _sync_directory(self):
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def retain(self, archive_directory, name, expected=None, *, publish=None):
        """Retain one source, optionally committing references under the lock."""
        if publish is not None and (not callable(publish) or expected is None):
            raise ValueError('Publication requires a callable and inspected descriptor')
        if self.read_only:
            raise ValueError('Retained RAW store is read-only')
        with self._lock():
            descriptor = self._retain_locked(archive_directory, name, expected)
            if publish is not None:
                publish(descriptor)
            return descriptor

    def retain_batch(self, archive_directory, selections, *, publish):
        """Publish a whole selected batch while holding the file lifecycle lock.

        The trusted callback begins and commits SQLite only after every copy is
        verified. Never enter with an existing SQLite transaction or reacquire
        the file lock inside the callback. A failed callback leaves complete
        unreferenced files, but cannot publish a partial dataset.
        """
        if self.read_only:
            raise ValueError('Retained RAW store is read-only')
        if not isinstance(selections, (list, tuple)) or not 1 <= len(selections) <= self.limits.max_artifacts or not callable(publish):
            raise ValueError('Invalid retained RAW batch')
        frozen, hashes = [], set()
        for selection in selections:
            if not isinstance(selection, (list, tuple)) or len(selection) != 2:
                raise ValueError('Expected source name and inspected descriptor')
            name, expected = selection
            if not isinstance(name, str) or not SOURCE_NAME.fullmatch(name) or not isinstance(expected, RawArtifact):
                raise ValueError('Invalid inspected RAW selection')
            if expected.sha256 in hashes:
                raise ValueError('Select each retained artifact once')
            hashes.add(expected.sha256)
            frozen.append((name, expected))
        with self._lock():
            descriptors = tuple(self._retain_locked(archive_directory, name, expected) for name, expected in frozen)
            return publish(descriptors)

    def _retain_locked(self, archive_directory, name, expected):
        if self.read_only:
            raise ValueError('Retained RAW store is read-only')
        if not isinstance(name, str) or not SOURCE_NAME.fullmatch(name):
            raise ValueError('Invalid RAW archive filename')
        if expected is not None and not isinstance(expected, RawArtifact):
            raise ValueError('Expected an inspected RAW descriptor')
        # Exact retained bytes are independent of the rolling source. Reuse
        # them only after checking both compressed identity and expanded size.
        if expected is not None:
            cached = self.directory / expected.name
            if cached.exists() or cached.is_symlink():
                fd = self._verify(expected)
                with os.fdopen(fd, 'rb') as source, gzip.GzipFile(fileobj=source) as stream:
                    reader = BoundedRawReader(stream, expected.expanded_bytes)
                    while reader.read(CHUNK):
                        pass
                self._sync_directory()
                return expected
        archive = Path(archive_directory)
        if archive.is_symlink() or not archive.is_dir():
            raise ValueError('Invalid RAW archive directory')
        # A dead copier can leave a private temporary file, never a published
        # descriptor. The shared lock proves no other copier is using it.
        for entry in self.directory.iterdir():
            if PART_NAME.fullmatch(entry.name):
                entry.unlink()
        source_fd = os.open(archive / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        temporary = self.directory / ('.part-' + uuid.uuid4().hex)
        try:
            before = _regular(source_fd)
            if before.st_size > self.limits.compressed_bytes:
                raise ValueError('RAW compressed byte limit exceeded')
            if shutil.disk_usage(self.directory).free - before.st_size < self.limits.minimum_free_bytes:
                raise ValueError('Insufficient free space for retained RAW input')
            digest, copied = hashlib.sha256(), 0
            target_fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(target_fd, 'wb') as target:
                while True:
                    data = os.read(source_fd, CHUNK)
                    if not data:
                        break
                    copied += len(data)
                    if copied > self.limits.compressed_bytes:
                        raise ValueError('RAW compressed byte limit exceeded')
                    digest.update(data)
                    target.write(data)
                target.flush()
                os.fsync(target.fileno())
            if _identity(before) != _identity(_regular(source_fd)):
                raise ValueError('RAW archive changed during retention')
            expanded = 0
            with gzip.open(temporary, 'rb') as stream:
                while True:
                    data = stream.read(min(CHUNK, self.limits.expanded_bytes - expanded + 1))
                    if not data:
                        break
                    expanded += len(data)
                    if expanded > self.limits.expanded_bytes:
                        raise ValueError('RAW expanded byte limit exceeded')
            sha256 = digest.hexdigest()
            descriptor = RawArtifact(sha256 + '.RAW.gz', sha256, copied, expanded)
            if expected is not None and descriptor != expected:
                raise ValueError('RAW archive changed since inspection')
            destination = self.directory / descriptor.name
            if destination.exists() or destination.is_symlink():
                os.close(self._verify(descriptor))
                self._sync_directory()
                return descriptor
            # Include the unpublished copy when checking the publication quota.
            used, count = self._usage()
            if count >= self.limits.max_artifacts:
                raise ValueError('Retained RAW artifact count exceeded')
            if used > self.limits.total_bytes:
                raise ValueError('Retained RAW storage quota exceeded')
            os.replace(temporary, destination)
            self._sync_directory()
            return descriptor
        finally:
            os.close(source_fd)
            temporary.unlink(missing_ok=True)

    def _verify(self, descriptor):
        if not isinstance(descriptor, RawArtifact):
            raise ValueError('Expected retained RAW descriptor')
        if descriptor.compressed_bytes > self.limits.compressed_bytes or descriptor.expanded_bytes > self.limits.expanded_bytes:
            raise ValueError('Retained RAW exceeds configured limits')
        fd = os.open(self.directory / descriptor.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = _regular(fd)
            if info.st_size != descriptor.compressed_bytes:
                raise ValueError('Retained RAW size mismatch')
            digest, count = hashlib.sha256(), 0
            while True:
                data = os.read(fd, CHUNK)
                if not data:
                    break
                count += len(data)
                if count > descriptor.compressed_bytes:
                    raise ValueError('Retained RAW changed during verification')
                digest.update(data)
            if _identity(info) != _identity(_regular(fd)):
                raise ValueError('Retained RAW changed during verification')
            if digest.hexdigest() != descriptor.sha256:
                raise ValueError('Retained RAW checksum mismatch')
            os.lseek(fd, 0, os.SEEK_SET)
            return fd
        except BaseException:
            os.close(fd)
            raise

    @contextmanager
    def open_raw(self, descriptor):
        with self._lock():
            fd = self._verify(descriptor)
            with os.fdopen(fd, 'rb') as source, gzip.GzipFile(fileobj=source) as stream:
                yield BoundedRawReader(stream, descriptor.expanded_bytes)

    def collect_released(self, connection, *, now_ms, minimum_age_ms=3_600_000,
                         maximum_entries=10_000):
        """Collect only explicitly released metadata with no live references.

        Unknown files and metadata are preserved, including crash orphans. The
        file mutex also covers readers and reference publication. BEGIN
        IMMEDIATE prevents reference changes between the last check and unlink.
        Tombstones remain in SQLite; scanning present files avoids repeatedly
        selecting absent tombstones and starving later eligible files.
        """
        if self.read_only:
            raise ValueError('Retained RAW store is read-only')
        if (type(now_ms) is not int or now_ms < 0 or type(minimum_age_ms) is not int
                or minimum_age_ms < 0 or type(maximum_entries) is not int
                or maximum_entries <= 0):
            raise ValueError('Invalid RAW collection bounds')
        if connection.in_transaction:
            raise ValueError('RAW collection requires an independent transaction')
        removed = []
        with self._lock():
            # Bound traversal before deleting anything; never partially process
            # a directory that exceeds the agreed inventory budget.
            names = []
            with os.scandir(self.directory) as entries:
                for count, entry in enumerate(entries, 1):
                    if count > maximum_entries:
                        raise ValueError('RAW collection entry limit exceeded')
                    if ARTIFACT_NAME.fullmatch(entry.name):
                        names.append(entry.name)
            connection.execute('BEGIN IMMEDIATE')
            try:
                for name in sorted(names):
                    eligible = connection.execute(
                        """SELECT content_hash FROM biometric_raw_artifacts AS artifact
                           WHERE name = ? AND released_at_ms IS NOT NULL
                             AND released_at_ms <= ?
                             AND NOT EXISTS (
                               SELECT 1 FROM biometric_dataset_raw_artifacts AS reference
                               WHERE reference.artifact_hash = artifact.content_hash
                                 AND reference.released_at_ms IS NULL)""",
                        (name, now_ms - minimum_age_ms)).fetchone()
                    if eligible is None:
                        continue
                    if name != eligible[0] + '.RAW.gz':
                        raise ValueError('Released RAW metadata identity mismatch')
                    path = self.directory / name
                    if not stat.S_ISREG(path.lstat().st_mode):
                        raise ValueError('Released RAW artifact must be a regular file')
                    path.unlink()
                    removed.append(name)
                if removed:
                    self._sync_directory()
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return removed

    def collect_orphans(self, connection, *, now_ms, minimum_age_ms=3_600_000,
                        maximum_entries=10_000):
        """Reconcile old unpublished copies without guessing metadata ownership.

        Publication holds this same mutex through its SQLite commit. A file with
        any metadata row is preserved, including released tombstones; its normal
        release collector owns that lifecycle. Unknown names are never touched.
        """
        if self.read_only:
            raise ValueError('Retained RAW store is read-only')
        if (type(now_ms) is not int or now_ms < 0 or type(minimum_age_ms) is not int
                or minimum_age_ms < 0 or type(maximum_entries) is not int
                or maximum_entries <= 0):
            raise ValueError('Invalid RAW collection bounds')
        if connection.in_transaction:
            raise ValueError('RAW collection requires an independent transaction')
        with self._lock():
            names = []
            with os.scandir(self.directory) as entries:
                for count, entry in enumerate(entries, 1):
                    if count > maximum_entries:
                        raise ValueError('RAW collection entry limit exceeded')
                    if ARTIFACT_NAME.fullmatch(entry.name) or PART_NAME.fullmatch(entry.name):
                        names.append(entry.name)
            connection.execute('BEGIN IMMEDIATE')
            try:
                candidates = []
                for name in sorted(names):
                    # Check both identities so inconsistent metadata cannot make
                    # a referenced file look like an orphan.
                    if ARTIFACT_NAME.fullmatch(name) and connection.execute(
                            'SELECT 1 FROM biometric_raw_artifacts WHERE name = ? OR content_hash = ?',
                            (name, name[:-7])).fetchone() is not None:
                        continue
                    path = self.directory / name
                    info = path.lstat()
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError('Orphan RAW artifact must be a regular file')
                    if info.st_mtime_ns > (now_ms - minimum_age_ms) * 1_000_000:
                        continue
                    candidates.append(path)
                # Complete the bounded inventory and metadata checks first.
                for path in candidates:
                    path.unlink()
                if candidates:
                    self._sync_directory()
                connection.commit()
                return [path.name for path in candidates]
            except BaseException:
                connection.rollback()
                raise

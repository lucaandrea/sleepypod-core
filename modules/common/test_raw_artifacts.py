"""Retained RAW bytes survive rolling archive removal, with bounded reads."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import gzip
import hashlib
import os
from pathlib import Path

import pytest

from common.biometrics.raw_artifacts import RawArtifactStore, RawArtifact, RawLimits


def fixture(tmp_path, payload=b'synthetic waveform bytes' * 100):
    archive = tmp_path / 'archive'
    archive.mkdir()
    compressed = gzip.compress(payload, mtime=0)
    (archive / '1.RAW.gz').write_bytes(compressed)
    store = RawArtifactStore(tmp_path / 'retained', RawLimits(4096, 65536, 8192, 1))
    return archive, store, compressed


def read_all(store, descriptor):
    chunks = []
    with store.open_raw(descriptor) as stream:
        while True:
            chunk = stream.read(1024)
            if not chunk:
                break
            chunks.append(chunk)
    return b''.join(chunks)


def test_retains_private_immutable_bytes_and_reuses_identical_content(tmp_path):
    payload = b'original samples' * 100
    archive, store, compressed = fixture(tmp_path, payload)
    descriptor = store.retain(archive, '1.RAW.gz')
    assert descriptor.sha256 == hashlib.sha256(compressed).hexdigest()
    assert descriptor.compressed_bytes == len(compressed)
    assert descriptor.expanded_bytes == len(payload)
    assert store.retain(archive, '1.RAW.gz') == descriptor
    (archive / '1.RAW.gz').unlink()
    assert read_all(store, descriptor) == payload
    assert (store.directory / descriptor.name).stat().st_mode & 0o777 == 0o600
    assert store.directory.stat().st_mode & 0o777 == 0o700
    assert len(list(store.directory.glob('*.RAW.gz'))) == 1
    assert not list(store.directory.glob('.part-*'))


def test_rejects_paths_symlinks_and_non_regular_archive_inputs(tmp_path):
    archive, store, _ = fixture(tmp_path)
    for name in ['../1.RAW.gz', '/etc/passwd', '1.RAW', '']:
        with pytest.raises(ValueError):
            store.retain(archive, name)
    (archive / '2.RAW.gz').symlink_to(archive / '1.RAW.gz')
    with pytest.raises(OSError):
        store.retain(archive, '2.RAW.gz')
    os.mkfifo(archive / '3.RAW.gz')
    with pytest.raises(ValueError, match='regular'):
        store.retain(archive, '3.RAW.gz')
    with pytest.raises(ValueError):
        RawArtifact('../file', 'x', 1, 1)


def test_compressed_expanded_and_free_space_limits_leave_no_partial_artifact(tmp_path):
    archive, store, compressed = fixture(tmp_path, b'a' * 10000)
    for limits, message in [
        (RawLimits(len(compressed) - 1, 65536, 8192, 1), 'compressed'),
        (RawLimits(4096, 9999, 8192, 1), 'expanded'),
        (RawLimits(4096, 65536, 8192, 2**62), 'free space'),
    ]:
        store.limits = limits
        with pytest.raises(ValueError, match=message):
            store.retain(archive, '1.RAW.gz')
        assert not list(store.directory.glob('*.RAW.gz'))
        assert not list(store.directory.glob('.part-*'))


def test_corruption_and_wrong_descriptors_fail_before_reading(tmp_path):
    archive, store, _ = fixture(tmp_path)
    descriptor = store.retain(archive, '1.RAW.gz')
    with pytest.raises(ValueError, match='size mismatch'):
        read_all(store, replace(descriptor, compressed_bytes=descriptor.compressed_bytes + 1))
    with pytest.raises(ValueError, match='expanded size mismatch'):
        read_all(store, replace(descriptor, expanded_bytes=descriptor.expanded_bytes + 1))
    with pytest.raises(ValueError, match='expanded byte limit'):
        read_all(store, replace(descriptor, expanded_bytes=descriptor.expanded_bytes - 1))
    path = store.directory / descriptor.name
    corrupted = bytearray(path.read_bytes())
    corrupted[-1] ^= 1
    path.write_bytes(corrupted)
    with pytest.raises(ValueError, match='checksum'):
        read_all(store, descriptor)
    with pytest.raises(ValueError, match='checksum'):
        store.retain(archive, '1.RAW.gz')


def test_serializes_quota_publication_and_recovers_crashed_staging_file(tmp_path):
    archive, store, _ = fixture(tmp_path, os.urandom(1024))
    (archive / '2.RAW.gz').write_bytes(gzip.compress(os.urandom(1024), mtime=0))
    store.limits = RawLimits(4096, 65536, 1500, 1)
    (store.directory / ('.part-' + 'a' * 32)).write_bytes(b'crashed copy')
    def retain(name):
        try:
            return store.retain(archive, name)
        except ValueError as error:
            return str(error)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(retain, ['1.RAW.gz', '2.RAW.gz']))
    assert sum(isinstance(row, RawArtifact) for row in results) == 1
    assert any(isinstance(row, str) and 'quota' in row for row in results)
    assert len(list(store.directory.glob('*.RAW.gz'))) == 1
    assert not list(store.directory.glob('.part-*'))


def test_rejects_unbounded_reads_and_invalid_gzip(tmp_path):
    archive, store, _ = fixture(tmp_path)
    descriptor = store.retain(archive, '1.RAW.gz')
    with store.open_raw(descriptor) as stream:
        with pytest.raises(ValueError, match='bounded'):
            stream.read()
        assert stream.read(0) == b''
    (archive / '2.RAW.gz').write_bytes(b'not gzip')
    with pytest.raises(OSError):
        store.retain(archive, '2.RAW.gz')
    assert not list(store.directory.glob('.part-*'))


def test_reuses_identical_content_at_exact_publication_quota(tmp_path):
    archive, store, compressed = fixture(tmp_path)
    store.limits = RawLimits(4096, 65536, len(compressed), 1)
    first = store.retain(archive, '1.RAW.gz')
    assert store.retain(archive, '1.RAW.gz') == first
    assert store._usage() == (len(compressed), 1)


def test_changed_archive_is_not_published(tmp_path, monkeypatch):
    archive, store, _ = fixture(tmp_path)
    original_read = os.read
    changed = False
    def read(fd, count):
        nonlocal changed
        data = original_read(fd, count)
        if data and not changed:
            changed = True
            (archive / '1.RAW.gz').write_bytes(gzip.compress(b'replaced source', mtime=0))
        return data
    monkeypatch.setattr(os, 'read', read)
    with pytest.raises(ValueError, match='changed during retention'):
        store.retain(archive, '1.RAW.gz')
    assert not list(store.directory.glob('*.RAW.gz'))
    assert not list(store.directory.glob('.part-*'))


def test_count_budget_applies_even_to_tiny_files_but_allows_idempotent_retry(tmp_path):
    archive, store, _ = fixture(tmp_path, b'one')
    store.limits = replace(store.limits, max_artifacts=1)
    first = store.retain(archive, '1.RAW.gz')
    assert store.retain(archive, '1.RAW.gz') == first
    (archive / '2.RAW.gz').write_bytes(gzip.compress(b'two', mtime=0))
    with pytest.raises(ValueError, match='artifact count'):
        store.retain(archive, '2.RAW.gz')
    assert read_all(store, first) == b'one'
    assert not list(store.directory.glob('.part-*'))


def test_read_only_store_does_not_create_or_change_storage_and_rejects_mutations(tmp_path):
    archive, store, _ = fixture(tmp_path)
    descriptor = store.retain(archive, '1.RAW.gz')
    os.chmod(store.directory, 0o750)
    reader = RawArtifactStore(store.directory, store.limits, read_only=True)
    assert store.directory.stat().st_mode & 0o777 == 0o750
    assert read_all(reader, descriptor) == b'synthetic waveform bytes' * 100
    with pytest.raises(ValueError, match='read-only'):
        reader.retain(archive, '1.RAW.gz')
    with pytest.raises(ValueError, match='read-only'):
        reader.collect_released(None, now_ms=1000)
    missing = tmp_path / 'missing'
    with pytest.raises(ValueError):
        RawArtifactStore(missing, read_only=True)
    assert not missing.exists()
    (store.directory / '.lock').unlink()
    with pytest.raises(FileNotFoundError):
        read_all(reader, descriptor)
    assert not (store.directory / '.lock').exists()

    os.mkfifo(store.directory / '.lock')
    with pytest.raises(ValueError, match='regular file'):
        read_all(reader, descriptor)


def test_reuses_exact_retained_bytes_without_the_original_archive_and_checks_expanded_size(tmp_path):
    archive, store, _ = fixture(tmp_path)
    descriptor = store.retain(archive, '1.RAW.gz')
    (archive / '1.RAW.gz').unlink()
    archive.rmdir()
    seen = []
    assert store.retain(archive, '1.RAW.gz', expected=descriptor, publish=seen.append) == descriptor
    assert seen == [descriptor]
    with pytest.raises(ValueError, match='expanded size mismatch'):
        store.retain(archive, '1.RAW.gz', expected=replace(descriptor, expanded_bytes=descriptor.expanded_bytes + 1))
    with pytest.raises(ValueError, match='expanded byte limit'):
        store.retain(archive, '1.RAW.gz', expected=replace(descriptor, expanded_bytes=descriptor.expanded_bytes - 1))

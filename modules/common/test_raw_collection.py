"""Released files cannot race verified reads or reference publication."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import gzip
from pathlib import Path
import sqlite3
from threading import Event

import pytest

from common.biometrics.raw_artifacts import RawArtifactStore, RawLimits


def fixture(tmp_path):
    archive = tmp_path / 'archive'
    archive.mkdir()
    (archive / '1.RAW.gz').write_bytes(gzip.compress(b'samples' * 100, mtime=0))
    store = RawArtifactStore(tmp_path / 'retained', RawLimits(4096, 65536, 8192, 1))
    descriptor = store.retain(archive, '1.RAW.gz')
    database = tmp_path / 'references.db'
    connection = sqlite3.connect(database)
    connection.execute('PRAGMA foreign_keys = ON')
    connection.execute('CREATE TABLE biometric_datasets (id TEXT PRIMARY KEY)')
    connection.execute("INSERT INTO biometric_datasets VALUES ('dataset')")
    migration = Path(__file__).parents[2] / 'src/db/biometrics-migrations/0028_retained_raw_artifacts.sql'
    connection.executescript(migration.read_text())
    connection.execute('INSERT INTO biometric_raw_artifacts VALUES (?, ?, ?, ?, ?, ?)',
                       (descriptor.sha256, descriptor.name, descriptor.compressed_bytes,
                        descriptor.expanded_bytes, 1000, 2000))
    connection.commit()
    return archive, store, descriptor, database, connection


def test_collects_only_released_unreferenced_bytes_after_grace(tmp_path):
    _, store, descriptor, _, db = fixture(tmp_path)
    try:
        db.execute('INSERT INTO biometric_dataset_raw_artifacts VALUES (?, ?, ?, ?, ?)',
                   ('link', 'dataset', descriptor.sha256, 0, None))
        db.commit()
        assert store.collect_released(db, now_ms=10000, minimum_age_ms=1000) == []
        db.execute('UPDATE biometric_dataset_raw_artifacts SET released_at_ms = 2000')
        db.commit()
        assert store.collect_released(db, now_ms=2999, minimum_age_ms=1000) == []
        assert store.collect_released(db, now_ms=3000, minimum_age_ms=1000) == [descriptor.name]
        assert not (store.directory / descriptor.name).exists()
        assert store.collect_released(db, now_ms=4000, minimum_age_ms=1000) == []
        # Metadata/links remain as tombstones, including their original identity.
        assert db.execute('SELECT released_at_ms FROM biometric_raw_artifacts').fetchone() == (2000,)
        assert db.execute('SELECT artifact_hash FROM biometric_dataset_raw_artifacts').fetchone() == (descriptor.sha256,)
    finally:
        db.close()


def test_preserves_unknown_files_and_rejects_unbounded_or_nested_collection(tmp_path):
    _, store, descriptor, _, db = fixture(tmp_path)
    try:
        unknown = store.directory / ('f' * 64 + '.RAW.gz')
        unknown.write_bytes(b'unknown future artifact')
        assert store.collect_released(db, now_ms=2000, minimum_age_ms=0) == [descriptor.name]
        assert unknown.exists()
        db.execute('BEGIN')
        with pytest.raises(ValueError, match='independent transaction'):
            store.collect_released(db, now_ms=3000)
        db.rollback()
        for kwargs in [{'now_ms': -1}, {'now_ms': True}, {'now_ms': 3000, 'minimum_age_ms': -1},
                       {'now_ms': 3000, 'maximum_entries': 0}]:
            with pytest.raises(ValueError, match='bounds'):
                store.collect_released(db, **kwargs)
        with pytest.raises(ValueError, match='entry limit'):
            store.collect_released(db, now_ms=3000, maximum_entries=1)
    finally:
        db.close()


def test_rejects_released_symlinks_and_metadata_identity_mismatch(tmp_path):
    _, store, descriptor, _, db = fixture(tmp_path)
    try:
        path = store.directory / descriptor.name
        path.unlink()
        victim = tmp_path / 'unrelated'
        victim.write_text('keep')
        path.symlink_to(victim)
        with pytest.raises(ValueError, match='regular file'):
            store.collect_released(db, now_ms=3000, minimum_age_ms=0)
        assert victim.read_text() == 'keep'
        assert not db.in_transaction
        db.execute('UPDATE biometric_raw_artifacts SET content_hash = ?', ('f' * 64,))
        db.commit()
        with pytest.raises(ValueError, match='identity mismatch'):
            store.collect_released(db, now_ms=3000, minimum_age_ms=0)
    finally:
        db.close()


def test_reader_holds_file_until_stream_is_closed(tmp_path):
    _, store, descriptor, database, db = fixture(tmp_path)
    db.close()
    started = Event()

    def collect():
        with closing(sqlite3.connect(database)) as connection:
            started.set()
            return store.collect_released(connection, now_ms=3000, minimum_age_ms=0)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with store.open_raw(descriptor) as stream:
            future = pool.submit(collect)
            assert started.wait(2)
            assert not future.done()
            assert stream.read(7) == b'samples'
        assert future.result(timeout=2) == [descriptor.name]


def test_reference_publication_completes_before_collection_can_check(tmp_path):
    archive, store, descriptor, database, db = fixture(tmp_path)
    started = Event()
    pending = []

    def collect():
        with closing(sqlite3.connect(database)) as connection:
            started.set()
            return store.collect_released(connection, now_ms=3000, minimum_age_ms=0)

    with ThreadPoolExecutor(max_workers=1) as pool:
        def publish(actual):
            assert actual == descriptor
            pending.append(pool.submit(collect))
            assert started.wait(2)
            assert not pending[0].done()
            with db:
                db.execute('UPDATE biometric_raw_artifacts SET released_at_ms = NULL')
                db.execute('INSERT INTO biometric_dataset_raw_artifacts VALUES (?, ?, ?, ?, ?)',
                           ('link', 'dataset', descriptor.sha256, 0, None))

        assert store.retain(archive, '1.RAW.gz', expected=descriptor, publish=publish) == descriptor
        assert pending[0].result(timeout=2) == []
    db.close()
    assert (store.directory / descriptor.name).exists()


def test_failed_publisher_leaves_valid_bytes_and_releases_file_lock(tmp_path):
    archive, store, descriptor, _, db = fixture(tmp_path)
    try:
        # Exercise fresh publication, not just the deduplicated path.
        (store.directory / descriptor.name).unlink()

        def fail(actual):
            assert actual == descriptor
            raise RuntimeError('publication failed')

        with pytest.raises(ValueError, match='inspected descriptor'):
            store.retain(archive, '1.RAW.gz', publish=fail)
        with pytest.raises(RuntimeError, match='publication failed'):
            store.retain(archive, '1.RAW.gz', expected=descriptor, publish=fail)
        with store.open_raw(descriptor) as stream:
            assert stream.read(7) == b'samples'
        assert not list(store.directory.glob('.part-*'))
        assert store.collect_released(db, now_ms=3000, minimum_age_ms=0) == [descriptor.name]
    finally:
        db.close()

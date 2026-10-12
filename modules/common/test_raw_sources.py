"""Inspection cannot substitute mutable archive names for frozen dataset bytes."""
import gzip
import importlib.util
from pathlib import Path

import pytest

from common.biometrics import raw_records
from common.biometrics.raw_sources import ArchiveSource, archive_names
from common.biometrics.raw_artifacts import RawArtifactStore, RawLimits

spec = importlib.util.spec_from_file_location('_source_raw_parser', Path(__file__).with_name('cbor_raw.py'))
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


def archive(tmp_path, monkeypatch):
    monkeypatch.setattr(raw_records, 'read_raw_record', parser.read_raw_record)
    root = tmp_path / 'archive'
    root.mkdir()
    payload = b'\xa1\x64type\x61x'
    encoded = b'\xa2\x63seq\x01\x64data\x48' + payload
    (root / '1.RAW.gz').write_bytes(gzip.compress(encoded, mtime=0))
    return root


def test_inspects_without_retention_then_freezes_exact_selected_bytes(tmp_path, monkeypatch):
    root = archive(tmp_path, monkeypatch)
    source = ArchiveSource(root, '1.RAW.gz')
    inspection = source.inspect()
    assert inspection['retained'] is False
    assert inspection['inventory']['decoded_records'] == 1
    assert sorted(p.name for p in tmp_path.iterdir()) == ['archive']
    store = RawArtifactStore(tmp_path / 'retained', RawLimits(4096, 65536, 8192, 1))
    saved = store.retain(root, '1.RAW.gz', expected=inspection['artifact'])
    assert saved == inspection['artifact']
    (root / '1.RAW.gz').unlink()
    assert list(raw_records.iter_retained_records(store, saved)) == [{'type': 'x'}]


def test_source_replacement_requires_reinspection_and_publishes_nothing(tmp_path, monkeypatch):
    root = archive(tmp_path, monkeypatch)
    source = ArchiveSource(root, '1.RAW.gz')
    descriptor = source.inspect()['artifact']
    (root / '1.RAW.gz').write_bytes(gzip.compress(b'new archive', mtime=0))
    with pytest.raises(ValueError, match='changed since inspection'):
        with source.open_raw(descriptor):
            pass
    store = RawArtifactStore(tmp_path / 'retained', RawLimits(4096, 65536, 8192, 1))
    with pytest.raises(ValueError, match='changed since inspection'):
        store.retain(root, '1.RAW.gz', expected=descriptor)
    assert not list(store.directory.glob('*.RAW.gz'))
    assert not list(store.directory.glob('.part-*'))


def test_discovery_is_bounded_and_excludes_symlinks_and_nonarchives(tmp_path, monkeypatch):
    root = archive(tmp_path, monkeypatch)
    (root / '2.RAW.gz').symlink_to(root / '1.RAW.gz')
    (root / 'partial.tmp').write_bytes(b'ignored')
    assert archive_names(root) == ['1.RAW.gz']
    with pytest.raises(ValueError, match='entry limit'):
        archive_names(root, maximum_entries=2)
    with pytest.raises(ValueError):
        ArchiveSource(root, '../outside.RAW.gz')
    with pytest.raises(OSError):
        ArchiveSource(root, '2.RAW.gz').inspect()

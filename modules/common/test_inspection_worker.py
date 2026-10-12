import gzip
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from common.biometrics.inspection_worker import run


def request(root, after=None, payload=None):
    output = BytesIO()
    run(BytesIO(payload if payload is not None else json.dumps({
        'version': 'raw-inspection-work-v1', 'after_name': after}).encode()), output, root)
    return json.loads(output.getvalue())


def write_archive(root, name):
    payload = b'\xa1\x64type\x61x'
    (root / name).write_bytes(gzip.compress(b'\xa2\x63seq\x01\x64data\x48' + payload, mtime=0))


def test_inspects_one_archive_at_a_time_without_retention(tmp_path):
    write_archive(tmp_path, 'b.RAW.gz')
    write_archive(tmp_path, 'a.RAW.gz')
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    first = request(tmp_path)
    assert first['status'] == 'inspected'
    assert first['nextCursor'] == 'a.RAW.gz'
    assert first['inspection']['retained'] is False
    assert first['inspection']['inventory']['decoded_records'] == 1
    assert first['inspection']['artifact']['sha256'] == first['inspection']['inventory']['artifact_sha256']
    assert request(tmp_path, first['nextCursor'])['nextCursor'] == 'b.RAW.gz'
    assert request(tmp_path, 'b.RAW.gz') == {'status': 'complete', 'nextCursor': None}
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before


def test_missing_directory_and_corruption_have_explicit_results(tmp_path):
    assert request(tmp_path / 'missing') == {'status': 'archive_unavailable', 'nextCursor': None}
    assert not (tmp_path / 'missing').exists()
    (tmp_path / 'a.RAW.gz').write_bytes(b'not gzip')
    write_archive(tmp_path, 'b.RAW.gz')
    assert request(tmp_path) == {'status': 'source_unavailable', 'nextCursor': 'a.RAW.gz'}
    assert request(tmp_path, 'a.RAW.gz')['status'] == 'inspected'


@pytest.mark.parametrize('payload', [
    b'{}', b'[]', b'x' * 1025,
    b'{"version":"raw-inspection-work-v1","after_name":null,"after_name":null}',
    b'{"version":"raw-inspection-work-v1","after_name":"../a.RAW.gz"}',
    b'{"version":"raw-inspection-work-v1","after_name":0}',
    b'{"version":"raw-inspection-work-v1","after_name":null,"path":"/tmp"}',
])
def test_rejects_invalid_work_before_filesystem_access(tmp_path, payload):
    with pytest.raises(ValueError):
        request(tmp_path / 'missing', payload=payload)


def test_fixed_cli_returns_metadata_and_private_failure(tmp_path):
    write_archive(tmp_path, 'a.RAW.gz')
    command = [sys.executable, '-B', '-m', 'common.biometrics.inspection_worker', '--archive-directory', str(tmp_path)]
    env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
    result = subprocess.run(command, input=json.dumps({'version': 'raw-inspection-work-v1', 'after_name': None}).encode(), capture_output=True, env=env, timeout=10)
    assert result.returncode == 0 and not result.stderr
    assert json.loads(result.stdout)['inspection']['source_name'] == 'a.RAW.gz'
    failed = subprocess.run(command, input=b'private malformed input', capture_output=True, env=env, timeout=10)
    assert failed.returncode == 1 and not failed.stdout
    assert failed.stderr == b'RAW inspection worker failed\n'

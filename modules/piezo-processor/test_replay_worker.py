"""Real subprocess protocol for shipped retained waveform processing."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics.config import manifest
from common.biometrics import replay_worker
from test_retained_replay import fixture, run


def work(snapshot):
    return {'version': 'retained-waveform-work-v1', 'input': snapshot,
            'configs': {side: deepcopy(manifest()['defaults']) for side in ('left', 'right')}}


def child(tmp_path, directory, payload):
    return subprocess.run([sys.executable, '-m', 'common.biometrics.replay_worker',
        '--retained-directory', str(directory)], input=payload, capture_output=True,
        cwd=tmp_path, env={'PYTHONPATH': str(Path(__file__).resolve().parent.parent),
            'LANG': 'C.UTF-8', 'TZ': 'UTC'}, timeout=20)


def test_real_worker_streams_provisional_readings_then_one_success_result(tmp_path):
    store, snapshot, _ = fixture(tmp_path)
    before = {entry.name: (entry.stat().st_mtime_ns, entry.stat().st_mode) for entry in store.directory.iterdir()}
    expected_rows = []
    expected = run(store, snapshot, expected_rows.append)
    completed = child(tmp_path, store.directory, json.dumps(work(snapshot)).encode())
    assert completed.returncode == 0, completed.stderr
    assert completed.stderr == b''
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    assert len(events) == len(expected_rows) + 1
    assert events[-1] == {'type': 'result', 'result': expected}
    for event, row in zip(events[:-1], expected_rows):
        assert event['type'] == 'reading'
        value = event['reading']
        assert value['heartRate'] == row.candidate.heart_rate
        assert value['timestampMs'] == row.timestamp_ms
        assert value['configHash'] == row.candidate.run_context.config_hash
        assert value['hrvMetric'] == 'window_ibi_variability_v1'
        assert value['side'] == row.side
    assert {entry.name: (entry.stat().st_mtime_ns, entry.stat().st_mode) for entry in store.directory.iterdir()} == before


def test_late_missing_artifact_has_no_success_event_or_sensitive_diagnostics(tmp_path):
    store, snapshot, _ = fixture(tmp_path, split_at=136)
    (store.directory / snapshot['artifacts'][1]['artifact']['name']).unlink()
    completed = child(tmp_path, store.directory, json.dumps(work(snapshot)).encode())
    assert completed.returncode == 1
    assert completed.stderr == b'Retained waveform worker failed\n'
    assert all(json.loads(line)['type'] == 'reading' for line in completed.stdout.splitlines())
    assert b'configHash' in completed.stdout  # Partial output must not be mistaken for success.


@pytest.mark.parametrize('payload', [b'{"version":1,"version":2}', b'{"value":NaN}', b'{"value":Infinity}', b'null', b'[]'])
def test_malformed_envelopes_fail_before_numerical_execution(tmp_path, payload):
    output = BytesIO()
    with pytest.raises(ValueError):
        replay_worker.run(BytesIO(payload), output, tmp_path / 'missing')
    assert output.getvalue() == b''
    assert not (tmp_path / 'missing').exists()


def test_worker_byte_limits_do_not_emit_an_oversize_input_or_result(tmp_path, monkeypatch):
    store, snapshot, _ = fixture(tmp_path)
    payload = json.dumps(work(snapshot)).encode()
    monkeypatch.setattr(replay_worker, 'MAX_INPUT_BYTES', len(payload) - 1)
    output = BytesIO()
    with pytest.raises(ValueError, match='input exceeds'):
        replay_worker.run(BytesIO(payload), output, store.directory)
    assert output.getvalue() == b''
    monkeypatch.setattr(replay_worker, 'MAX_INPUT_BYTES', len(payload))
    monkeypatch.setattr(replay_worker, 'MAX_OUTPUT_BYTES', 10)
    with pytest.raises(ValueError, match='output exceeds'):
        replay_worker.run(BytesIO(payload), output, store.directory)
    assert output.getvalue() == b''

"""Replay and shadow must compete for one kernel-owned numerical worker slot."""
import io
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from common.biometrics import execution_lock, replay_worker, shadow_process


def test_replay_and_shadow_contend_for_same_inode(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'linux')
    path = tmp_path / 'execution.lock'
    assert execution_lock.EXECUTION_LOCK_PATH == shadow_process.SHADOW_LOCK_PATH
    first = shadow_process.acquire_shadow_lock(path)
    try:
        with pytest.raises(BlockingIOError):
            replay_worker.acquire_execution_lock(path)
    finally:
        os.close(first)
    second = replay_worker.acquire_execution_lock(path)
    try:
        with pytest.raises(BlockingIOError):
            shadow_process.acquire_shadow_lock(path)
    finally:
        os.close(second)


def test_replay_contention_fails_before_limits_imports_or_input(monkeypatch):
    def busy():
        raise BlockingIOError('private path')
    monkeypatch.setattr(replay_worker, 'acquire_execution_lock', busy)
    monkeypatch.setattr(replay_worker, 'configure_process_limits', lambda *_: pytest.fail('limits before lock'))
    monkeypatch.setattr(sys, 'argv', ['worker', '--retained-directory', '/private'])
    monkeypatch.setattr(sys, 'stdin', None)
    stderr = io.StringIO()
    monkeypatch.setattr(sys, 'stderr', stderr)
    assert replay_worker.main() == 1
    assert stderr.getvalue() == 'Retained waveform worker failed\n'


@pytest.mark.parametrize('failed', [False, True])
def test_replay_keeps_lock_through_processing_and_closes_on_every_exit(monkeypatch, failed):
    calls = []
    monkeypatch.setattr(sys, 'argv', ['worker', '--retained-directory', '/retained'])
    monkeypatch.setattr(sys, 'stdin', SimpleNamespace(buffer='source'))
    monkeypatch.setattr(sys, 'stdout', SimpleNamespace(buffer='sink'))
    monkeypatch.setattr(sys, 'stderr', io.StringIO())
    monkeypatch.setattr(replay_worker, 'acquire_execution_lock', lambda: (calls.append('lock'), 123)[1])
    monkeypatch.setattr(replay_worker, 'configure_process_limits', lambda *_: calls.append('limits'))
    monkeypatch.setattr(replay_worker.os, 'close', lambda fd: calls.append(('close', fd)))
    def run(*args):
        assert calls == ['lock', 'limits']
        calls.append('run')
        if failed:
            raise ValueError('failed')
    monkeypatch.setattr(replay_worker, 'run', run)
    assert replay_worker.main() == (1 if failed else 0)
    assert calls == ['lock', 'limits', 'run', ('close', 123)]


@pytest.mark.skipif(sys.platform != 'linux', reason='Real Linux signal/lock ownership')
def test_real_shared_lock_survives_stop_and_releases_on_kill(tmp_path):
    path = tmp_path / 'execution.lock'
    code = ('from common.biometrics.execution_lock import acquire_execution_lock; '
            'import sys,time; fd=acquire_execution_lock(sys.argv[1]); '
            'print("owned",flush=True); time.sleep(60)')
    child = subprocess.Popen([sys.executable, '-c', code, str(path)], stdout=subprocess.PIPE,
        env={**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parent.parent)})
    try:
        import select
        import signal
        assert select.select([child.stdout], [], [], 5)[0]
        assert child.stdout.readline() == b'owned\n'
        child.send_signal(signal.SIGSTOP)
        with pytest.raises(BlockingIOError):
            shadow_process.acquire_shadow_lock(path)
        child.kill()
        child.wait(timeout=5)
        fd = shadow_process.acquire_shadow_lock(path)
        os.close(fd)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdout.close()


def test_build_probe_does_not_claim_numerical_execution_slot(monkeypatch):
    from common.biometrics import build_identity
    monkeypatch.setattr(sys, 'argv', ['worker', '--describe-build'])
    monkeypatch.setattr(replay_worker, 'acquire_execution_lock', lambda: pytest.fail('probe claimed slot'))
    monkeypatch.setattr(replay_worker, 'configure_process_limits', lambda *_: None)
    monkeypatch.setattr(build_identity, 'replay_build_identity', lambda: {'hash': 'fixture'})
    output = io.StringIO()
    monkeypatch.setattr(sys, 'stdout', output)
    assert replay_worker.main() == 0
    assert output.getvalue() == '{"hash":"fixture"}\n'

import builtins
import subprocess
import sys
from types import SimpleNamespace

import pytest

from common.biometrics import replay_worker


def without_resource(monkeypatch):
    original = builtins.__import__

    def load(name, *args, **kwargs):
        if name == 'resource':
            raise ModuleNotFoundError("No module named 'resource'", name='resource')
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', load)
    monkeypatch.setattr(replay_worker.sys, 'platform', 'linux')
    monkeypatch.setattr(replay_worker.os, 'nice', lambda value: None)


def test_yocto_worker_sets_same_limits_on_its_own_pid(monkeypatch):
    without_resource(monkeypatch)
    calls = []
    monkeypatch.setattr(replay_worker.subprocess, 'run', lambda *args, **kwargs: calls.append((args, kwargs)))
    replay_worker.configure_process_limits()
    assert calls == [((['/usr/bin/prlimit', '--pid', str(replay_worker.os.getpid()),
        '--core=0:0', '--cpu=120:121', '--nofile=64:64'],), {
        'check': True, 'timeout': 5, 'stdin': subprocess.DEVNULL,
        'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL})]


@pytest.mark.parametrize('failure', [FileNotFoundError(),
    subprocess.CalledProcessError(1, 'prlimit'), subprocess.TimeoutExpired('prlimit', 5)])
def test_missing_or_failed_limit_utility_fails_closed(monkeypatch, failure):
    without_resource(monkeypatch)

    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(replay_worker.subprocess, 'run', fail)
    with pytest.raises(type(failure)):
        replay_worker.configure_process_limits()


def test_missing_resource_on_other_platform_does_not_use_linux_utility(monkeypatch):
    without_resource(monkeypatch)
    monkeypatch.setattr(replay_worker.sys, 'platform', 'darwin')
    with pytest.raises(ModuleNotFoundError):
        replay_worker.configure_process_limits()


@pytest.mark.parametrize('cpu_seconds', [120, 1800, 3600])
def test_standard_resource_extension_sets_limits_without_external_command(monkeypatch, cpu_seconds):
    limits = []
    monkeypatch.setitem(sys.modules, 'resource', SimpleNamespace(RLIMIT_CORE=4,
        RLIMIT_CPU=0, RLIMIT_NOFILE=7, setrlimit=lambda key, value: limits.append((key, value))))
    monkeypatch.setattr(replay_worker.os, 'nice', lambda value: None)

    def unexpected(*args, **kwargs):
        pytest.fail('The standard resource path must not spawn a utility')

    monkeypatch.setattr(replay_worker.subprocess, 'run', unexpected)
    replay_worker.configure_process_limits(cpu_seconds)
    assert limits == [(4, (0, 0)), (0, (cpu_seconds, cpu_seconds + 1)), (7, (64, 64))]


def test_configured_cpu_limit_reaches_yocto_utility(monkeypatch):
    without_resource(monkeypatch)
    calls = []
    monkeypatch.setattr(replay_worker.subprocess, 'run', lambda args, **kwargs: calls.append(args))
    replay_worker.configure_process_limits(1800)
    assert '--cpu=1800:1801' in calls[0]


@pytest.mark.parametrize('value', [True, 0, -1, 1.5, 3601, float('inf'), None])
def test_invalid_cpu_limit_fails_before_changing_process_limits(value):
    with pytest.raises(ValueError, match='CPU budget'):
        replay_worker.configure_process_limits(value)

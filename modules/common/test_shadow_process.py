"""Kernel-limit startup must fail closed before numerical imports or input."""
import builtins
import io
import subprocess
import sys
from types import SimpleNamespace

import pytest

from common.biometrics import shadow_process


def test_installs_address_limit_after_shared_cpu_limits(monkeypatch):
    calls = []
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(shadow_process, 'configure_process_limits', lambda cpu: calls.append(('cpu', cpu)))
    monkeypatch.setitem(sys.modules, 'resource', SimpleNamespace(RLIMIT_AS=9,
        setrlimit=lambda kind, values: calls.append(('as', kind, values))))
    shadow_process.configure_shadow_limits(31, 123456789)
    assert calls == [('cpu', 31), ('as', 9, (123456789, 123456789))]


@pytest.mark.parametrize('budget', [0, -1, True, 1.5, '123', 9_007_199_254_740_992])
def test_invalid_address_budget_cannot_start(monkeypatch, budget):
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(shadow_process, 'configure_process_limits', lambda cpu: pytest.fail('limits already changed'))
    with pytest.raises(ValueError):
        shadow_process.configure_shadow_limits(1, budget)


def test_unsupported_host_does_not_claim_enforcement(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'darwin')
    with pytest.raises(RuntimeError, match='Linux'):
        shadow_process.configure_shadow_limits(1, 123)


def test_yocto_uses_fixed_prlimit_and_propagates_refusal(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(shadow_process, 'configure_process_limits', lambda cpu: None)
    original = builtins.__import__
    def without_resource(name, *args, **kwargs):
        if name == 'resource':
            raise ModuleNotFoundError(name='resource')
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', without_resource)
    calls = []
    def execute(command, **kwargs):
        calls.append((command, kwargs))
    monkeypatch.setattr(subprocess, 'run', execute)
    shadow_process.configure_shadow_limits(1, 123456789)
    assert calls == [(['/usr/bin/prlimit', '--pid', str(shadow_process.os.getpid()), '--as=123456789:123456789'],
        dict(check=True, timeout=5, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))]
    def refuse(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args[0])
    monkeypatch.setattr(subprocess, 'run', refuse)
    with pytest.raises(subprocess.CalledProcessError):
        shadow_process.configure_shadow_limits(1, 123456789)


def test_failed_limits_never_import_processor_or_read_input(monkeypatch):
    original = builtins.__import__
    def guard(name, *args, **kwargs):
        if name.endswith('shadow_worker'):
            pytest.fail('numerical processor imported before limits succeeded')
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guard)
    def fail(*args):
        raise OSError('private-path-or-frame')
    monkeypatch.setattr(shadow_process, 'configure_shadow_limits', fail)
    stderr = io.StringIO()
    monkeypatch.setattr(sys, 'stderr', stderr)
    monkeypatch.setattr(sys, 'stdin', None)
    assert shadow_process.main(['--cpu-seconds', '1', '--address-space-bytes', '123']) == 1
    assert stderr.getvalue() == 'Shadow process failed\n'


def test_successful_limits_precede_processor_import_and_run(monkeypatch):
    calls = []
    monkeypatch.setattr(shadow_process, 'configure_shadow_limits', lambda *args: calls.append('limits'))
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        if name == 'shadow_worker':
            assert calls == ['limits']
            calls.append('import')
            return SimpleNamespace(run=lambda source, destination: calls.append((source, destination)))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)
    monkeypatch.setattr(sys, 'stdin', SimpleNamespace(buffer='source'))
    monkeypatch.setattr(sys, 'stdout', SimpleNamespace(buffer='destination'))
    assert shadow_process.main(['--cpu-seconds', '1', '--address-space-bytes', '123']) == 0
    assert calls == ['limits', 'import', ('source', 'destination')]


@pytest.mark.skipif(sys.platform != 'linux', reason='Kernel enforcement is Linux-only')
def test_real_linux_kernel_refuses_allocation_and_terminates_busy_worker():
    import os
    from pathlib import Path
    import signal
    environment = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parent.parent)}
    prefix = 'from common.biometrics.shadow_process import configure_shadow_limits\nconfigure_shadow_limits(1, 96 * 1024 * 1024)\n'
    memory = subprocess.run([sys.executable, '-B', '-c', prefix + '''
import resource
assert resource.getrlimit(resource.RLIMIT_AS) == (96 * 1024 * 1024,) * 2
try:
    bytearray(128 * 1024 * 1024)
except MemoryError:
    print('allocation refused')
else:
    raise AssertionError('allocation was not bounded')
'''], env=environment, capture_output=True, timeout=10)
    assert memory.returncode == 0, memory.stderr
    assert memory.stdout == b'allocation refused\n'
    cpu = subprocess.run([sys.executable, '-B', '-c', prefix + 'while True: pass\n'],
        env=environment, capture_output=True, timeout=10)
    assert cpu.returncode == -signal.SIGXCPU

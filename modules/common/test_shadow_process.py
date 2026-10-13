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
    monkeypatch.setattr(shadow_process, 'configure_parent_death', lambda pid: None)
    monkeypatch.setattr(shadow_process, 'acquire_shadow_lock', lambda: 123)
    monkeypatch.setattr(shadow_process, 'configure_wall_deadline', lambda ms: None)
    monkeypatch.setattr(shadow_process.os, 'close', lambda fd: None)
    monkeypatch.setattr(shadow_process, 'configure_shadow_limits', fail)
    stderr = io.StringIO()
    monkeypatch.setattr(sys, 'stderr', stderr)
    monkeypatch.setattr(sys, 'stdin', None)
    assert shadow_process.main(['--parent-pid', '123', '--wall-ms', '10000', '--cpu-seconds', '1', '--address-space-bytes', '123']) == 1
    assert stderr.getvalue() == 'Shadow process failed\n'


def test_successful_limits_precede_processor_import_and_run(monkeypatch):
    calls = []
    monkeypatch.setattr(shadow_process, 'configure_parent_death', lambda pid: calls.append('parent'))
    monkeypatch.setattr(shadow_process, 'acquire_shadow_lock', lambda: (calls.append('lock'), 123)[1])
    monkeypatch.setattr(shadow_process, 'configure_wall_deadline', lambda ms: calls.append(('wall', ms)))
    monkeypatch.setattr(shadow_process.os, 'close', lambda fd: calls.append(('close', fd)))
    monkeypatch.setattr(shadow_process, 'configure_shadow_limits', lambda *args: calls.append('limits'))
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        if name == 'shadow_worker':
            assert calls == ['parent', 'lock', ('wall', 10000), 'limits']
            calls.append('import')
            return SimpleNamespace(run=lambda source, destination: calls.append((source, destination)))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)
    monkeypatch.setattr(sys, 'stdin', SimpleNamespace(buffer='source'))
    monkeypatch.setattr(sys, 'stdout', SimpleNamespace(buffer='destination'))
    assert shadow_process.main(['--parent-pid', '123', '--wall-ms', '10000', '--cpu-seconds', '1', '--address-space-bytes', '123']) == 0
    assert calls == ['parent', 'lock', ('wall', 10000), 'limits', 'import', ('source', 'destination'), ('close', 123)]


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


@pytest.mark.parametrize('parent', [0, -1, True, 1.5, '123', 2_147_483_648])
def test_invalid_parent_pid_refused(monkeypatch, parent):
    monkeypatch.setattr(sys, 'platform', 'linux')
    with pytest.raises(ValueError):
        shadow_process.configure_parent_death(parent)


@pytest.mark.parametrize('parents, result', [([122], 0), ([123, 122], 0), ([123], -1)])
def test_parent_loss_and_kernel_refusal_fail_closed(monkeypatch, parents, result):
    import ctypes
    monkeypatch.setattr(sys, 'platform', 'linux')
    values = iter(parents)
    monkeypatch.setattr(shadow_process.os, 'getppid', lambda: next(values))
    def prctl(*args):
        assert args == (1, shadow_process.signal.SIGKILL, 0, 0, 0)
        return result
    monkeypatch.setattr(ctypes, 'CDLL', lambda *args, **kwargs: SimpleNamespace(prctl=prctl))
    with pytest.raises((RuntimeError, OSError)):
        shadow_process.configure_parent_death(123)


@pytest.mark.skipif(sys.platform != 'linux', reason='Parent-death signal is Linux-only')
def test_real_parent_death_kills_detached_shadow_worker():
    import os
    import signal
    import time
    from pathlib import Path
    environment = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parent.parent)}
    child_code = "from common.biometrics.shadow_process import configure_parent_death; import os,sys,time; configure_parent_death(int(sys.argv[1])); print(os.getpid(), flush=True); time.sleep(60)"
    parent_code = "import subprocess,sys,os,time; subprocess.Popen([sys.executable,'-B','-c',sys.argv[1],str(os.getpid())],start_new_session=True); time.sleep(60)"
    parent = subprocess.Popen([sys.executable, '-B', '-c', parent_code, child_code],
        env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    worker_pid = None
    try:
        import select
        ready, _, _ = select.select([parent.stdout], [], [], 10)
        assert ready, 'Worker did not arm parent-death protection'
        worker_pid = int(parent.stdout.readline())
        parent.kill()
        parent.wait(timeout=5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                state = Path(f'/proc/{worker_pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
            except (FileNotFoundError, ProcessLookupError):
                # The task can vanish after procfs open but before read (ESRCH).
                break
            if state == 'Z':
                break  # dead; reaping belongs to the container init/subreaper
            time.sleep(0.02)
        else:
            raise AssertionError('Worker survived host death')
        worker_pid = None
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if worker_pid is not None:
            try:
                os.kill(worker_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        parent.stdout.close()
        parent.stderr.close()


def test_parent_protection_failure_prevents_limits_and_processing(monkeypatch):
    def fail(pid):
        raise OSError('private parent protection detail')
    monkeypatch.setattr(shadow_process, 'configure_parent_death', fail)
    monkeypatch.setattr(shadow_process, 'configure_shadow_limits', lambda *args: pytest.fail('limits reached after parent protection failed'))
    monkeypatch.setattr(sys, 'stdin', None)
    stderr = io.StringIO()
    monkeypatch.setattr(sys, 'stderr', stderr)
    assert shadow_process.main(['--parent-pid', '123', '--wall-ms', '10000', '--cpu-seconds', '1', '--address-space-bytes', '123']) == 1
    assert stderr.getvalue() == 'Shadow process failed\n'


@pytest.mark.parametrize('kind', ['symlink', 'hardlink', 'public', 'content'])
def test_unsafe_lock_files_refused(tmp_path, monkeypatch, kind):
    import os
    monkeypatch.setattr(sys, 'platform', 'linux')
    path = tmp_path / 'worker.lock'
    if kind == 'symlink':
        target = tmp_path / 'target'
        target.touch(mode=0o600)
        path.symlink_to(target)
    else:
        path.touch(mode=0o600)
        if kind == 'hardlink':
            os.link(path, tmp_path / 'alias')
        if kind == 'public':
            path.chmod(0o644)
        if kind == 'content':
            path.write_text('not a lock')
    with pytest.raises((OSError, RuntimeError)):
        shadow_process.acquire_shadow_lock(path)


def test_lock_contention_and_release_do_not_delete_runtime_file(tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(sys, 'platform', 'linux')
    path = tmp_path / 'worker.lock'
    first = shadow_process.acquire_shadow_lock(path)
    try:
        with pytest.raises(BlockingIOError):
            shadow_process.acquire_shadow_lock(path)
    finally:
        os.close(first)
    before = path.stat().st_ino
    second = shadow_process.acquire_shadow_lock(path)
    os.close(second)
    assert path.stat().st_ino == before
    assert path.read_bytes() == b''


@pytest.mark.skipif(sys.platform != 'linux', reason='Kernel execution lock is Linux-only')
def test_real_linux_lock_survives_pause_and_releases_after_worker_death():
    import os
    import select
    import signal
    import tempfile
    from pathlib import Path
    from common.biometrics.shadow_process import acquire_shadow_lock
    environment = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parent.parent)}
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / 'worker.lock')
        code = "from common.biometrics.shadow_process import acquire_shadow_lock; import sys,time; fd=acquire_shadow_lock(sys.argv[1]); print('locked',flush=True); time.sleep(60)"
        worker = subprocess.Popen([sys.executable, '-B', '-c', code, path], env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            ready, _, _ = select.select([worker.stdout], [], [], 10)
            assert ready and worker.stdout.readline() == 'locked\n'
            os.kill(worker.pid, signal.SIGSTOP)
            try:
                fd = acquire_shadow_lock(path)
            except BlockingIOError:
                pass
            else:
                os.close(fd)
                raise AssertionError('Paused worker lost exclusive execution lock')
            worker.kill()
            worker.wait(timeout=5)
            fd = acquire_shadow_lock(path)
            os.close(fd)
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=5)
            worker.stdout.close()
            worker.stderr.close()


def test_lock_contention_prevents_numerical_startup(monkeypatch):
    monkeypatch.setattr(shadow_process, 'configure_parent_death', lambda pid: None)
    def busy():
        raise BlockingIOError('another worker owns the slot')
    monkeypatch.setattr(shadow_process, 'acquire_shadow_lock', busy)
    monkeypatch.setattr(shadow_process, 'configure_shadow_limits', lambda *args: pytest.fail('limits reached without execution slot'))
    monkeypatch.setattr(sys, 'stdin', None)
    stderr = io.StringIO()
    monkeypatch.setattr(sys, 'stderr', stderr)
    assert shadow_process.main(['--parent-pid', '123', '--wall-ms', '10000', '--cpu-seconds', '1', '--address-space-bytes', '123']) == 1
    assert stderr.getvalue() == 'Shadow process failed\n'


@pytest.mark.parametrize('budget', [0, -1, True, 1.5, '1000', 7 * 86_400_000 + 300_001])
def test_invalid_worker_wall_budget_refused(monkeypatch, budget):
    monkeypatch.setattr(sys, 'platform', 'linux')
    with pytest.raises(ValueError):
        shadow_process.configure_wall_deadline(budget)


def test_worker_wall_timer_uses_default_termination_signal(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'linux')
    calls = []
    monkeypatch.setattr(shadow_process.signal, 'signal', lambda *args: calls.append(args))
    monkeypatch.setattr(shadow_process.signal, 'pthread_sigmask', lambda *args: calls.append(args))
    monkeypatch.setattr(shadow_process.signal, 'setitimer', lambda *args: calls.append(args))
    shadow_process.configure_wall_deadline(1234)
    assert calls == [(shadow_process.signal.SIGALRM, shadow_process.signal.SIG_DFL),
        (shadow_process.signal.SIG_UNBLOCK, {shadow_process.signal.SIGALRM}),
        (shadow_process.signal.ITIMER_REAL, 1.234)]


@pytest.mark.skipif(sys.platform != 'linux', reason='Worker wall timer is Linux-only')
def test_real_worker_wall_timer_terminates_idle_process_and_releases_slot():
    import os
    import signal
    import tempfile
    import time
    from pathlib import Path
    from common.biometrics.shadow_process import acquire_shadow_lock
    environment = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parent.parent)}
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / 'worker.lock')
        code = "from common.biometrics.shadow_process import acquire_shadow_lock,configure_wall_deadline; import sys,time,signal; fd=acquire_shadow_lock(sys.argv[1]); signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGALRM}); configure_wall_deadline(100); time.sleep(60)"
        started = time.monotonic()
        result = subprocess.run([sys.executable, '-B', '-c', code, path], env=environment,
            capture_output=True, timeout=5)
        assert result.returncode == -signal.SIGALRM
        assert time.monotonic() - started < 5
        fd = acquire_shadow_lock(path)
        os.close(fd)

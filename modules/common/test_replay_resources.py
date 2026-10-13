import builtins
import io
import sys
from types import SimpleNamespace

import pytest

from common.biometrics import replay_worker


def test_linux_peak_is_kernel_high_water_mark_in_bytes_without_resource(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'linux')
    opened = []

    def read(path, mode, encoding):
        opened.append((path, mode, encoding))
        return io.StringIO('Name:\tpython\nVmHWM:\t 12345 kB\nVmRSS:\t 100 kB\n')

    monkeypatch.setattr(builtins, 'open', read)
    assert replay_worker.peak_rss_bytes() == 12345 * 1024
    assert opened == [('/proc/self/status', 'r', 'ascii')]


@pytest.mark.parametrize('text', ['', 'VmRSS: 12 kB\n', 'VmHWM: 0 kB\n',
    'VmHWM: 12 bytes\n', 'VmHWM: 12 kB\nVmHWM: 13 kB\n',
    'VmHWM: 99999999999999999999999 kB\n', 'x' * 16385])
def test_missing_or_malformed_peak_is_unknown(monkeypatch, text):
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(builtins, 'open', lambda *args, **kwargs: io.StringIO(text))
    assert replay_worker.peak_rss_bytes() is None


def test_missing_procfs_is_unknown(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'linux')

    def fail(*args, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(builtins, 'open', fail)
    assert replay_worker.peak_rss_bytes() is None


def test_darwin_peak_is_already_bytes(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'darwin')
    monkeypatch.setitem(sys.modules, 'resource', SimpleNamespace(RUSAGE_SELF=0,
        getrusage=lambda who: SimpleNamespace(ru_maxrss=12345)))
    assert replay_worker.peak_rss_bytes() == 12345


def test_unknown_platform_does_not_guess_units(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'other')
    assert replay_worker.peak_rss_bytes() is None

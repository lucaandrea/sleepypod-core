import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from common.biometrics import build_identity, shadow_build
from common.biometrics.config import config_hash


def test_shadow_identity_covers_shared_and_prospective_sources():
    result = shadow_build.shadow_build_identity()
    assert result == shadow_build.shadow_build_identity()
    assert result['hash'] == config_hash(result['identity'])
    assert result['hash'] != build_identity.replay_build_identity()['hash']
    assert result['identity']['version'] == 'shadow-python-build-v1'
    root = Path(shadow_build.__file__).resolve().parents[2]
    assert set(result['identity']['sources']) == set(build_identity.SOURCE_FILES + shadow_build.SHADOW_SOURCE_FILES)
    for name in shadow_build.SHADOW_SOURCE_FILES:
        assert result['identity']['sources'][name] == hashlib.sha256((root / name).read_bytes()).hexdigest()


@pytest.mark.parametrize('name', shadow_build.SHADOW_SOURCE_FILES)
def test_each_shadow_source_change_invalidates_identity(name, monkeypatch):
    before = shadow_build.shadow_build_identity()['hash']
    original = build_identity._digest_file
    monkeypatch.setattr(build_identity, '_digest_file', lambda path: 'a' * 64 if str(path).endswith(name) else original(path))
    assert shadow_build.shadow_build_identity()['hash'] != before


def test_probe_emits_only_identity_json_and_never_imports_processor():
    env = {**os.environ, 'PYTHONPATH': str(Path(shadow_build.__file__).resolve().parents[2])}
    result = subprocess.run([sys.executable, '-B', '-m', 'common.biometrics.shadow_build'],
        capture_output=True, text=True, check=True, timeout=10, env=env)
    assert json.loads(result.stdout) == shadow_build.shadow_build_identity()
    assert result.stderr == ''
    code = "from common.biometrics.shadow_build import shadow_build_identity; import sys; shadow_build_identity(); assert 'common.biometrics.shadow' not in sys.modules; assert 'numpy' not in sys.modules"
    subprocess.run([sys.executable, '-B', '-c', code], check=True, timeout=10, env=env)


def test_missing_dependency_file_listing_fails_closed(monkeypatch):
    original = shadow_build.importlib.metadata.distribution

    class WithoutFiles:
        files = []

        def __init__(self, name):
            self.original = original(name)

        def __getattr__(self, name):
            return getattr(self.original, name)

    monkeypatch.setattr(shadow_build.importlib.metadata, 'distribution', WithoutFiles)
    with pytest.raises(ValueError, match='paths unavailable'):
        shadow_build.shadow_build_identity()

"""Read-only identity probe for the shipped prospective processor.

Includes shared replay dependencies and shadow-specific control/transport code.
Wheel metadata hashes are provenance, not full installed-binary attestation.
"""
import json
from pathlib import Path
import sys

from . import build_identity
from .config import config_hash

SHADOW_SOURCE_FILES = (
    'common/biometrics/shadow_build.py',
    'common/biometrics/shadow.py',
    'common/biometrics/shadow_worker.py',
    'common/biometrics/shadow_process.py',
)


def shadow_build_identity():
    identity = build_identity.replay_build_identity()['identity']
    identity['version'] = 'shadow-python-build-v1'
    root = Path(__file__).resolve().parents[2]
    identity['sources'].update({name: build_identity._digest_file(root / name)
        for name in SHADOW_SOURCE_FILES})
    return {'hash': config_hash(identity), 'identity': identity}


def main():
    try:
        sys.stdout.write(json.dumps(shadow_build_identity(), allow_nan=False,
            separators=(',', ':')) + '\n')
        return 0
    except Exception:
        sys.stderr.write('Shadow build identity unavailable\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())

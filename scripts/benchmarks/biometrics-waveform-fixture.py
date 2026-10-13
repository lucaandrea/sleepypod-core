"""Create bounded deterministic synthetic dual-channel archives, never live data."""
import argparse
from dataclasses import asdict
import gzip
import json
from pathlib import Path
import time

import cbor2
import numpy as np
from common.biometrics.raw_sources import ArchiveSource

parser = argparse.ArgumentParser()
parser.add_argument('new_directory')
parser.add_argument('--seconds', type=int, default=1800)
args = parser.parse_args()
if not 600 <= args.seconds <= 28800:
    raise SystemExit('Fixture duration must be between 600 seconds and 8 hours')
root = Path(args.new_directory)
root.mkdir(mode=0o700)  # Never overwrite an existing archive directory.
start = 1767297600000
began = time.monotonic()
rng = np.random.default_rng(814)
inspections = []
for segment, offset in enumerate(range(0, args.seconds, 7200)):
    name = '%03d.RAW.gz' % segment
    with (root / name).open('xb') as output:
        with gzip.GzipFile(filename='', fileobj=output, mode='wb', compresslevel=1, mtime=0) as stream:
            for second in range(offset, min(offset + 7200, args.seconds)):
                timestamp = start / 1000 + second
                records = []
                if second % 30 == 0:
                    records.append({'type': 'frzHealth', 'ts': timestamp,
                        'left': {'pumpRpm': 0}, 'right': {'pumpRpm': 0}})
                t = (np.arange(500) + second * 500) / 500
                left = (np.sin(t * 2 * np.pi * 1.2) * 1000000 + rng.normal(0, 100000, 500)).astype('<i4').tobytes()
                right = (np.sin(t * 2 * np.pi * 1.1) * 1000000 + rng.normal(0, 100000, 500)).astype('<i4').tobytes()
                records.append({'type': 'piezo-dual', 'ts': timestamp, 'left1': left, 'right1': right})
                for record in records:
                    stream.write(cbor2.dumps({'seq': second, 'data': cbor2.dumps(record)}))
    inspection = ArchiveSource(root, name).inspect()
    inspection['artifact'] = asdict(inspection['artifact'])
    inspections.append(inspection)
print(json.dumps({'version': 'synthetic-waveform-fixture-v1', 'startMs': start,
    'endMs': start + args.seconds * 1000, 'seconds': args.seconds,
    'generationSeconds': time.monotonic() - began, 'inspections': inspections}))

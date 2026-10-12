"""Fixed server-owned entry point for atomic waveform dataset publication."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

from .replay_worker import _unique_object, _invalid_constant, configure_process_limits

MAX_INPUT_BYTES = 10 * 1024 * 1024


def run(input_stream, output_stream, *, database, archive_directory, retained_directory):
    payload = input_stream.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        raise ValueError('Waveform publication input exceeds byte budget')
    work = json.loads(payload, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    if not isinstance(work, dict) or set(work) != {'version', 'prepared', 'selections'} or work['version'] != 'waveform-publication-work-v1':
        raise ValueError('Invalid waveform publication envelope')
    from .raw_artifacts import RawArtifactStore
    from .raw_publication import publish_waveform_dataset
    # Never create an empty database at a mistyped deployment location.
    connection = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=rw', uri=True, timeout=5)
    try:
        connection.execute('PRAGMA foreign_keys = ON')
        result = publish_waveform_dataset(RawArtifactStore(retained_directory), connection,
            archive_directory, work['selections'], work['prepared'])
        # The coordinator re-reads the descriptor by ID. Keep IPC independent of
        # the manifest size, and permit idempotent recovery after a lost reply.
        output_stream.write((json.dumps({'type': 'result', 'id': result['id'],
            'contentHash': result['contentHash'], 'available': result['available']}, separators=(',', ':')) + '\n').encode())
        output_stream.flush()
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description='Publish fixed retained waveform inputs')
    parser.add_argument('--database', required=True)
    parser.add_argument('--archive-directory', required=True)
    parser.add_argument('--retained-directory', required=True)
    args = parser.parse_args()
    try:
        configure_process_limits()
        run(sys.stdin.buffer, sys.stdout.buffer, database=args.database,
            archive_directory=args.archive_directory, retained_directory=args.retained_directory)
        return 0
    except Exception:
        sys.stderr.write('Waveform publication worker failed\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())

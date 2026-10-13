"""Bounded cleanup of server-owned retained waveforms, never the archive."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import time

from .raw_artifacts import RawArtifactStore
from .replay_worker import _unique_object, _invalid_constant, configure_process_limits


def run(input_stream, output_stream, database_path, retained_directory):
    payload = input_stream.read(1025)
    if len(payload) > 1024:
        raise ValueError('RAW cleanup input exceeds byte budget')
    work = json.loads(payload, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    if work != {'version': 'raw-collection-work-v1'}:
        raise ValueError('Invalid RAW cleanup envelope')
    directory = Path(retained_directory)
    removed_released = removed_orphans = 0
    if directory.is_symlink():
        raise ValueError('Invalid retained directory')
    if directory.exists():
        database = Path(database_path)
        if database.is_symlink() or not database.is_file():
            raise ValueError('Invalid biometrics database')
        with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=rw', uri=True, timeout=1)) as connection:
            connection.execute('PRAGMA foreign_keys = ON')
            store = RawArtifactStore(directory)
            now_ms = time.time_ns() // 1_000_000
            removed_released = len(store.collect_released(connection, now_ms=now_ms))
            removed_orphans = len(store.collect_orphans(connection, now_ms=now_ms))
    result = {'version': 'raw-collection-result-v1', 'released': removed_released, 'orphans': removed_orphans}
    output_stream.write((json.dumps(result, separators=(',', ':')) + '\n').encode())
    output_stream.flush()


def main():
    parser = argparse.ArgumentParser(description='Collect retained RAW files')
    parser.add_argument('--database-path', required=True)
    parser.add_argument('--retained-directory', required=True)
    args = parser.parse_args()
    try:
        configure_process_limits()
        run(sys.stdin.buffer, sys.stdout.buffer, args.database_path, args.retained_directory)
        return 0
    except Exception:
        sys.stderr.write('RAW collection worker failed\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())

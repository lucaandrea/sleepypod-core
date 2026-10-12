"""Inspect one cold archive per request without retaining or changing its bytes."""
import argparse
from dataclasses import asdict
import json
import sys
import zlib

from .raw_artifacts import SOURCE_NAME
from .raw_sources import ArchiveSource, archive_names
from .replay_worker import _unique_object, _invalid_constant, configure_process_limits

MAX_INPUT_BYTES = 1024
MAX_OUTPUT_BYTES = 65536


def inspect_next(archive_directory, after_name):
    # Names are a traversal cursor, not a snapshot of a mutable directory. A
    # subsequent sweep from null discovers additions before the current cursor.
    try:
        names = archive_names(archive_directory)
    except (OSError, ValueError):
        return {'status': 'archive_unavailable', 'nextCursor': None}
    name = next((name for name in names if after_name is None or name > after_name), None)
    if name is None:
        return {'status': 'complete', 'nextCursor': None}
    try:
        inspection = ArchiveSource(archive_directory, name).inspect()
        inspection['artifact'] = asdict(inspection['artifact'])
    except (OSError, ValueError, EOFError, zlib.error):
        # Advance past bad sources so they cannot prevent a full sweep. Do not
        # invalidate catalog rows by filename: another scan may have replaced it.
        return {'status': 'source_unavailable', 'nextCursor': name}
    return {'status': 'inspected', 'nextCursor': name, 'inspection': inspection}


def run(input_stream, output_stream, archive_directory):
    payload = input_stream.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        raise ValueError('RAW inspection input exceeds byte budget')
    work = json.loads(payload, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    if (not isinstance(work, dict) or set(work) != {'version', 'after_name'}
            or work['version'] != 'raw-inspection-work-v1'):
        raise ValueError('Invalid RAW inspection envelope')
    after = work['after_name']
    if after is not None and (not isinstance(after, str) or len(after) > 255 or not SOURCE_NAME.fullmatch(after)):
        raise ValueError('Invalid RAW inspection cursor')
    result = inspect_next(archive_directory, after)
    encoded = (json.dumps(result, allow_nan=False, separators=(',', ':')) + '\n').encode()
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise ValueError('RAW inspection output exceeds byte budget')
    output_stream.write(encoded)
    output_stream.flush()


def main():
    parser = argparse.ArgumentParser(description='Inspect one server-owned RAW archive')
    parser.add_argument('--archive-directory', required=True)
    args = parser.parse_args()
    try:
        configure_process_limits()
        run(sys.stdin.buffer, sys.stdout.buffer, args.archive_directory)
        return 0
    except Exception:
        sys.stderr.write('RAW inspection worker failed\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())

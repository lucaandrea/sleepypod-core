"""Fixed shipped waveform worker; JSON input and bounded JSON-lines output.

This is process/resource separation for trusted shipped algorithms, not a
sandbox for uploaded executable code. The coordinator owns staging and fenced
result publication; reading events alone never constitute a successful job.
"""
import argparse
import json
import os
import subprocess
import re
import sys
import time

from .execution_lock import acquire_execution_lock

MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate input field')
        value[key] = item
    return value


def _invalid_constant(_):
    raise ValueError('Nonfinite JSON input')


def peak_rss_bytes():
    """Kernel process-lifetime high water mark; never substitute current RSS.

    Linux procfs also works on Yocto without the optional resource extension.
    Missing or unrecognized telemetry remains unknown, never zero.
    """
    try:
        if sys.platform == 'linux':
            with open('/proc/self/status', 'r', encoding='ascii') as source:
                status = source.read(16385)
            if len(status) > 16384:
                return None
            matches = re.findall(r'^VmHWM:\s+(\d+) kB$', status, re.MULTILINE)
            value = int(matches[0]) * 1024 if len(matches) == 1 else None
        elif sys.platform == 'darwin':
            import resource
            value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        else:
            return None
        return value if type(value) is int and 0 < value <= 2 ** 53 - 1 else None
    except (OSError, UnicodeError, ImportError, ValueError):
        return None


def run(input_stream, output_stream, retained_directory):
    started_wall = time.perf_counter_ns()
    started_cpu = time.process_time_ns()
    payload = input_stream.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        raise ValueError('Waveform work input exceeds byte budget')
    work = json.loads(payload, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    if not isinstance(work, dict) or set(work) not in ({'version', 'input', 'configs'}, {'version', 'input', 'configs', 'expected_build_hash'}) or work['version'] != 'retained-waveform-work-v1':
        raise ValueError('Invalid waveform work envelope')
    from .build_identity import replay_build_identity
    build = replay_build_identity()
    if 'expected_build_hash' in work and (not isinstance(work['expected_build_hash'], str)
            or not re.fullmatch(r'[a-f0-9]{64}', work['expected_build_hash'])
            or work['expected_build_hash'] != build['hash']):
        raise ValueError('Replay build identity changed')
    # Import numerical dependencies after CLI resource/BLAS setup.
    from .raw_artifacts import RawArtifactStore
    from .retained_replay import replay_retained
    store = RawArtifactStore(retained_directory, read_only=True)
    output_bytes = 0

    def emit(event):
        nonlocal output_bytes
        encoded = (json.dumps(event, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
        output_bytes += len(encoded)
        if output_bytes > MAX_OUTPUT_BYTES:
            raise ValueError('Waveform work output exceeds byte budget')
        output_stream.write(encoded)
        output_stream.flush()

    def reading(row):
        candidate = row.candidate
        emit({'type': 'reading', 'reading': {
            'side': row.side, 'timestampMs': row.timestamp_ms,
            'heartRate': candidate.heart_rate, 'hrvIndex': candidate.hrv,
            'hrvMetric': 'window_ibi_variability_v1',
            'breathingRate': candidate.breathing_rate, 'qualityScore': candidate.quality_score,
            'flags': candidate.flags, 'hrRaw': candidate.hr_raw,
            'sourceSide': candidate.run_context.source_side,
            'configHash': candidate.run_context.config_hash, 'limitations': row.limitations,
        }})

    result = replay_retained(store, work['input'], work['configs'], reading)
    # Detect source/dependency metadata changes during this process as well.
    if replay_build_identity()['hash'] != build['hash']:
        raise ValueError('Replay build identity changed during execution')
    emit({'type': 'result', 'result': {**result, 'build_hash': build['hash'],
        'resources': {'version': 'waveform-process-resources-v1',
            'wallMs': (time.perf_counter_ns() - started_wall) / 1_000_000,
            'cpuMs': (time.process_time_ns() - started_cpu) / 1_000_000,
            'peakRssBytes': peak_rss_bytes(),
            'scope': 'python_process_until_result',
            'memoryScope': 'process_lifetime_high_water_mark'}}})


def configure_process_limits(cpu_seconds=120):
    if type(cpu_seconds) is not int or not 1 <= cpu_seconds <= 3600:
        raise ValueError('Invalid waveform CPU budget')
    # Provisional execution caps; qualified scheduling/admission belongs to
    # the parent. It must also enforce wall time and kill on cancellation.
    try:
        import resource
    except ModuleNotFoundError as error:
        if error.name != 'resource' or sys.platform != 'linux':
            raise
        # Yocto may omit Python's optional resource extension. Use the fixed
        # system utility to limit this process before importing numerical code.
        # Missing utility, refusal, or timeout remains a startup failure.
        subprocess.run(['/usr/bin/prlimit', '--pid', str(os.getpid()),
            '--core=0:0', f'--cpu={cpu_seconds}:{cpu_seconds + 1}', '--nofile=64:64'],
            check=True, timeout=5, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    os.nice(19)
    for key in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        os.environ[key] = '1'


def main():
    parser = argparse.ArgumentParser(description='Replay fixed retained waveform inputs')
    parser.add_argument('--cpu-seconds', type=int, default=120)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--retained-directory')
    target.add_argument('--describe-build', action='store_true')
    args = parser.parse_args()
    lock_fd = None
    try:
        if not args.describe_build:
            lock_fd = acquire_execution_lock()
        configure_process_limits(args.cpu_seconds)
        if args.describe_build:
            from .build_identity import replay_build_identity
            sys.stdout.write(json.dumps(replay_build_identity(), allow_nan=False, separators=(',', ':')) + '\n')
        else:
            run(sys.stdin.buffer, sys.stdout.buffer, args.retained_directory)
        return 0
    except Exception:
        # Never echo reference exports, frame values, paths or tracebacks.
        sys.stderr.write('Retained waveform worker failed\n')
        return 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)


if __name__ == '__main__':
    sys.exit(main())

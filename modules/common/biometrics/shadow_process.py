"""Linux process entrypoint for the trusted, shipped shadow algorithm.

Install kernel limits before importing the numerical processor. This is resource
containment, not an isolation boundary for uploaded code. The parent must still
bound wall/idle time, sample RSS, and reap the process on cancellation or loss of
its lease. Address space is not RSS and must be budgeted separately.
"""
import argparse
import os
import subprocess
import sys

from .replay_worker import configure_process_limits


def configure_shadow_limits(cpu_seconds, address_space_bytes):
    if sys.platform != 'linux':
        raise RuntimeError('Shadow process limits require Linux')
    if type(address_space_bytes) is not int or not 0 < address_space_bytes <= 9_007_199_254_740_991:
        raise ValueError('Invalid shadow address-space budget')
    # Reuse the replay worker's CPU/core/file limits, low priority, and BLAS
    # thread settings. A failure must prevent all numerical imports and input.
    configure_process_limits(cpu_seconds)
    try:
        import resource
    except ModuleNotFoundError as error:
        if error.name != 'resource':
            raise
        # Yocto builds can omit the optional Python extension.
        subprocess.run(['/usr/bin/prlimit', '--pid', str(os.getpid()),
            f'--as={address_space_bytes}:{address_space_bytes}'],
            check=True, timeout=5, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        resource.setrlimit(resource.RLIMIT_AS, (address_space_bytes, address_space_bytes))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Run a resource-limited shipped shadow processor')
    parser.add_argument('--cpu-seconds', type=int, required=True)
    parser.add_argument('--address-space-bytes', type=int, required=True)
    args = parser.parse_args(argv)
    try:
        configure_shadow_limits(args.cpu_seconds, args.address_space_bytes)
        from .shadow_worker import run
        run(sys.stdin.buffer, sys.stdout.buffer)
        return 0
    except Exception:
        # No frame values, paths, reference data or tracebacks in host logs.
        sys.stderr.write('Shadow process failed\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())

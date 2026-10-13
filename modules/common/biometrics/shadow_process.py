"""Linux process entrypoint for the trusted, shipped shadow algorithm.

Install kernel limits before importing the numerical processor. This is resource
containment, not an isolation boundary for uploaded code. The parent must still
bound wall/idle time, sample RSS, and reap the process on cancellation or loss of
its lease. Address space is not RSS and must be budgeted separately.
"""
import argparse
import os
import signal
import stat
import subprocess
import sys

from .replay_worker import configure_process_limits


def configure_parent_death(expected_parent_pid):
    """Kill this worker if its launching host dies, including the arm-time race.

    Linux PR_SET_PDEATHSIG applies to this process, not future forked children:
    https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html
    """
    if sys.platform != 'linux':
        raise RuntimeError('Shadow parent-death protection requires Linux')
    if type(expected_parent_pid) is not int or not 1 <= expected_parent_pid <= 2_147_483_647:
        raise ValueError('Invalid shadow parent PID')
    if os.getppid() != expected_parent_pid:
        raise RuntimeError('Shadow host is no longer the parent')
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), 'Shadow parent-death protection unavailable')
    # No signal is delivered if the parent died before prctl was armed.
    if os.getppid() != expected_parent_pid:
        raise RuntimeError('Shadow host changed while arming parent-death protection')


SHADOW_LOCK_PATH = '/run/sleepypod-shadow.lock'


def acquire_shadow_lock(path=SHADOW_LOCK_PATH):
    """One shipped shadow worker per host, independent of database leases.

    The fixed runtime file is never unlinked/truncated. flock ownership ends on
    descriptor close or process death; no stale lock-file deletion is needed.
    The optional path exists for trusted tests, not as a CLI/request argument.
    """
    if sys.platform != 'linux':
        raise RuntimeError('Shadow execution lock requires Linux')
    import fcntl
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size != 0):
            raise RuntimeError('Invalid shadow execution lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('Shadow execution lock replaced')
        return fd
    except BaseException:
        os.close(fd)
        raise


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
    parser.add_argument('--parent-pid', type=int, required=True)
    parser.add_argument('--cpu-seconds', type=int, required=True)
    parser.add_argument('--address-space-bytes', type=int, required=True)
    args = parser.parse_args(argv)
    lock_fd = None
    try:
        configure_parent_death(args.parent_pid)
        lock_fd = acquire_shadow_lock()
        configure_shadow_limits(args.cpu_seconds, args.address_space_bytes)
        from .shadow_worker import run
        run(sys.stdin.buffer, sys.stdout.buffer)
        return 0
    except Exception:
        # No frame values, paths, reference data or tracebacks in host logs.
        sys.stderr.write('Shadow process failed\n')
        return 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)


if __name__ == '__main__':
    sys.exit(main())

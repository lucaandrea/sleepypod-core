"""Host-wide ownership for trusted numerical replay and shadow workers.

Keep the legacy shadow path so workers from before an upgrade still contend.
No request or CLI option can select another lock. The optional function argument
is for trusted tests. This lock does not replace worker resource limits.
"""
import os
import stat

EXECUTION_LOCK_PATH = '/run/sleepypod-shadow.lock'


def acquire_execution_lock(path=EXECUTION_LOCK_PATH):
    """Nonblocking flock; never unlink or truncate the shared runtime inode."""
    import fcntl
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size != 0):
            raise RuntimeError('Invalid biometric execution lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('Biometric execution lock replaced')
        return fd
    except BaseException:
        os.close(fd)
        raise

#!/usr/bin/env python3
"""Real terminal bridge for Bun's first-run acceptance tests (stdlib only)."""
import errno
import fcntl
import os
import pty
import select
import signal
import subprocess
import sys
import termios

master, slave = pty.openpty()


def terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)


child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
os.close(slave)


def stop(_signal, _frame):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)


signal.signal(signal.SIGTERM, stop)
try:
    inputs = [master, sys.stdin.fileno()]
    while master in inputs:
        ready, _, _ = select.select(inputs, [], [], 0.1)
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError as exc:
                if fd == master and exc.errno == errno.EIO:
                    inputs.remove(master)
                    break
                raise
            if not data:
                inputs.remove(fd)
            elif fd == master:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            else:
                os.write(master, data)
    sys.exit(child.wait())
finally:
    stop(None, None)
    child.wait()
    os.close(master)

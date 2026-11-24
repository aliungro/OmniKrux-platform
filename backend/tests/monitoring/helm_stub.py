"""A stand-in "helm" for the subprocess runner's tests, run as `python -I helm_stub.py …`.

Its first argument picks what it does (anything else prints its arguments and environment):
- `big N`: write N bytes to stdout and N bytes to stderr, then exit 0;
- `sleep SECONDS PIDFILE`: write its process id and HOME to PIDFILE, then sleep;
- `ignore-term SECONDS PIDFILE`: the same, ignoring SIGTERM (POSIX; Windows has no SIGTERM to
  ignore, `terminate()` there ends the process at once);
- `fail CODE TEXT`: write TEXT to stderr and exit with CODE.
"""

import json
import os
import signal
import sys
import time
from pathlib import Path


def _sleep(seconds: str, pidfile: str) -> None:
    # Its process id, then its HOME (which is inside the runner's private folder for the call).
    Path(pidfile).write_text(f"{os.getpid()}\n{os.environ.get('HOME', '')}", encoding="utf-8")
    time.sleep(float(seconds))


def main() -> int:
    args = sys.argv[1:]
    command = args[0] if args else ""
    if command == "big":
        size = int(args[1])
        chunk = b"x" * 65536
        for stream in (sys.stdout.buffer, sys.stderr.buffer):
            left = size
            while left > 0:
                stream.write(chunk[: min(left, len(chunk))])
                left -= len(chunk)
            stream.flush()
        return 0
    if command == "sleep":
        _sleep(args[1], args[2])
        return 0
    if command == "ignore-term":
        if hasattr(signal, "SIGTERM") and os.name == "posix":
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        _sleep(args[1], args[2])
        return 0
    if command == "fail":
        sys.stderr.buffer.write(args[2].encode())
        sys.stderr.flush()
        return int(args[1])
    print(json.dumps({"args": args, "env": dict(os.environ)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Helpers the kind end-to-end tests share."""

import queue
import subprocess
import threading
import time

import pytest

from tests.kube.test_source_kind import CONTEXT


def kubectl(*args: str) -> str:
    """kubectl's stdout; a failure (wrong context, no access, timeout) fails the test."""
    done = subprocess.run(
        ["kubectl", "--context", CONTEXT, *args],
        check=False,
        capture_output=True,
        encoding="utf-8",  # not the console's code page: non-ASCII output must survive
        timeout=60,
    )
    assert done.returncode == 0, f"kubectl {' '.join(args)} failed: {done.stderr.strip()}"
    return done.stdout


def wait_for(check, what: str, timeout: float = 60.0, interval: float = 1.0):
    """Poll `check` until it returns something truthy; fail with `what` after `timeout`."""
    deadline = time.monotonic() + timeout
    while True:
        if value := check():
            return value
        if time.monotonic() > deadline:
            pytest.fail(f"Timed out after {timeout:.0f}s waiting for {what}")
        time.sleep(interval)


class Reader:
    """Reads a websocket's JSON messages on a thread, so every wait has a deadline."""

    def __init__(self, ws):
        self.ws = ws
        self.messages: queue.Queue = queue.Queue()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        try:
            while True:
                self.messages.put(self.ws.receive_json())
        except Exception as exc:  # noqa: BLE001 (the socket closed; say so to the waiter)
            self.messages.put({"type": "closed", "error": repr(exc)})

    def until(self, done, what: str, timeout: float = 60.0) -> list[dict]:
        """Messages up to and including the first for which `done(message)` holds."""
        seen, deadline = [], time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                pytest.fail(f"Timed out waiting for {what}; got {seen[-5:]}")
            try:
                message = self.messages.get(timeout=left)
            except queue.Empty:
                continue
            seen.append(message)
            if done(message):
                return seen

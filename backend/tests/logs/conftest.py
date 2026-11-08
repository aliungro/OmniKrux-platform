import pytest

from omnikrux.logs import stream


@pytest.fixture(autouse=True)
def quick_previous_retries(monkeypatch):
    """A refused `previous` read is retried after 0.5 s and 1.5 s; tests don't wait for that."""
    monkeypatch.setattr(stream, "PREVIOUS_RETRY_DELAYS", (0.01, 0.02))

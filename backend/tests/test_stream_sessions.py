"""StreamSessions: removing a cluster never waits unbounded for a node-shell cleanup."""

import asyncio

from omnikrux import stream_sessions
from omnikrux.stream_sessions import StreamSessions


class Registry:
    async def get(self, cluster_id):
        raise KeyError(cluster_id)


async def test_removal_waits_for_node_shell_cleanup_only_so_long(monkeypatch, caplog):
    monkeypatch.setattr(stream_sessions, "CLEANUP_SECONDS", 0.1, raising=False)
    sessions = StreamSessions(Registry())
    stuck = await sessions.register("c1", cleanup_pod=True)  # its cleanup never finishes

    async def remove():
        async with sessions.removing(cluster_id="c1"):
            return "removed"

    assert await asyncio.wait_for(remove(), 2) == "removed"
    assert "still closing" in caplog.text
    sessions.release(stuck)

"""Local WebSocket relay tests without kind or kubectl."""

import time
from contextlib import asynccontextmanager

import aiohttp
import pytest
from aiohttp import web
from yarl import URL

from tests.e2e import cloudproxy


@pytest.mark.parametrize("abrupt", [True, False], ids=["upstream-abort", "token-expiry"])
async def test_websocket_upstream_abort_differs_from_token_expiry(monkeypatch, abrupt):
    protocol = "v4.channel.k8s.io"

    async def upgrade(request):
        ws = web.WebSocketResponse(protocols=(protocol,))
        await ws.prepare(request)
        await ws.send_bytes(b"\x01ready")
        async for message in ws:
            if message.data == b"\x00abort":
                request.transport.abort()
                break
        return ws

    @asynccontextmanager
    async def upstream():
        app = web.Application()
        app.router.add_get("/exec", upgrade)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        try:
            await web.TCPSite(runner, "127.0.0.1", 0).start()
            yield URL(f"http://127.0.0.1:{runner.addresses[0][1]}")
        finally:
            await runner.cleanup()

    async with upstream() as target:
        monkeypatch.setattr(cloudproxy, "_kind_upstream", lambda _: (target, True))
        expires = float("inf")
        proxy = cloudproxy.CloudKubeProxy({}, lambda _: time.monotonic() < expires)
        try:
            async with (
                aiohttp.ClientSession() as client,
                client.ws_connect(
                    f"{proxy.url}/exec",
                    headers={"Authorization": "Bearer synthetic"},
                    protocols=(protocol,),
                    timeout=aiohttp.ClientWSTimeout(ws_receive=3, ws_close=3),
                ) as ws,
            ):
                assert ws.protocol == protocol
                assert await ws.receive_bytes() == b"\x01ready"
                if abrupt:
                    await ws.send_bytes(b"\x00abort")
                else:
                    expires = time.monotonic()
                message = await ws.receive()
                assert message.type == aiohttp.WSMsgType.CLOSE
                assert message.data == (1011 if abrupt else 1000)
        finally:
            proxy.stop()

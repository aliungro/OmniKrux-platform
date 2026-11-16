"""The suite's own guards: no developer settings, no network beyond loopback."""

import asyncio
import os
import socket

import aiohttp
import pytest

from tests import netguard
from tests.netguard import NetworkRefused


def test_developer_settings_do_not_reach_tests():
    for name in ("OMNIKRUX_SECRET_KEY", "OMNIKRUX_DATABASE_URL", "OMNIKRUX_STATIC_DIR"):
        assert name not in os.environ


@pytest.mark.parametrize(
    ("host", "allowed"),
    [
        ("127.0.0.1", True),
        ("127.3.2.1", True),
        ("::1", True),
        ("[::1]", True),
        ("localhost", True),
        (None, True),
        ("management.azure.com", False),
        ("169.254.169.254", False),
        ("10.0.0.1", False),
        ("host.docker.internal", False),
    ],
)
def test_loopback_rule(host, allowed):
    assert netguard.allowed_host(host) is allowed


def test_guard_refuses_and_records_every_route(monkeypatch):
    violations: list[str] = []
    netguard.install(monkeypatch, violations)
    with pytest.raises(NetworkRefused):
        socket.getaddrinfo("management.azure.com", 443)
    with socket.socket() as sock, pytest.raises(NetworkRefused):
        sock.connect(("192.0.2.10", 443))

    async def through_aiohttp():
        async with aiohttp.ClientSession() as session:
            await session.get("http://192.0.2.10:9/", timeout=aiohttp.ClientTimeout(total=2))

    with pytest.raises(aiohttp.ClientError):
        asyncio.run(through_aiohttp())
    assert len(violations) == 3


async def test_loopback_still_works(fake_api):
    async with aiohttp.ClientSession() as session, session.get(f"{fake_api.url}/version") as r:
        assert r.status in (200, 401)

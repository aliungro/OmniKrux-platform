"""Port-forward tests: the real app with one cluster on the fake API, forwarding on ports that
are free on this machine right now, and helpers to talk TCP to them."""

import asyncio
import contextlib
import random
import socket
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass

import httpx
import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.portforward.manager import ForwardIn, PortForwardManager
from tests.fakekube import FakeKubeApi, kubeconfig_for

SECONDS = 10  # the most any one step may take


def free_ports(n: int) -> range:
    """`n` consecutive ports nothing on 127.0.0.1 uses right now."""
    for _ in range(100):
        base = random.randint(40_000, 60_000)
        sockets: list[socket.socket] = []
        try:
            for port in range(base, base + n):
                sock = socket.socket()
                sockets.append(sock)
                sock.bind(("127.0.0.1", port))
        except OSError:
            continue
        finally:
            for sock in sockets:
                sock.close()
        return range(base, base + n)
    raise AssertionError("no free ports")


@dataclass
class Env:
    app: object
    client: httpx.AsyncClient
    cluster_id: str
    fake: FakeKubeApi
    ports: range

    @property
    def forwards(self) -> PortForwardManager:
        return self.app.state.forwards

    def request(self, **fields) -> ForwardIn:
        values = {"cluster_id": self.cluster_id, "namespace": "demo", "kind": "pod"}
        return ForwardIn(**(values | {"name": "web-1", "port": 8080} | fields))

    def body(self, **fields) -> dict:
        return self.request(**fields).model_dump()

    async def records(self) -> list:
        return (await self.app.state.audit.list()).records


@asynccontextmanager
async def make_env(fake: FakeKubeApi, tmp_path, ports: range) -> AsyncIterator[Env]:
    settings = Settings(
        data_dir=tmp_path,
        kubeconfig="",
        in_container=False,
        rewrite_loopback=False,
        port_forward_ports=f"{ports[0]}-{ports[-1]}",
    )
    app = create_app(settings)
    async with AsyncExitStack() as stack:
        await stack.enter_async_context(app.router.lifespan_context(app))
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        transport = httpx.ASGITransport(app=app)
        client = await stack.enter_async_context(
            httpx.AsyncClient(transport=transport, base_url="http://testserver")
        )
        yield Env(app, client, info.id, fake, ports)


@pytest.fixture
async def env(fake_api, tmp_path):
    """Two port-forward ports."""
    async with make_env(fake_api, tmp_path, free_ports(2)) as env:
        yield env


def pod(
    name: str,
    *,
    ready: bool = True,
    labels: dict | None = None,
    ports: tuple[tuple[str, int], ...] = (("http", 8080),),
) -> dict:
    """A running pod; `ports` are its container's (name, number) ports."""
    return {
        "metadata": {
            "name": name,
            "namespace": "demo",
            "uid": f"u-{name}",
            "labels": {"app": "web"} if labels is None else labels,
        },
        "spec": {
            "containers": [
                {"name": "app", "ports": [{"name": n, "containerPort": p} for n, p in ports]}
            ]
        },
        "status": {
            "phase": "Running",
            "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
        },
    }


def service(name: str = "web", ports: list[dict] | None = None, selector=None) -> dict:
    return {
        "metadata": {"name": name, "namespace": "demo", "uid": f"u-svc-{name}"},
        "spec": {
            "selector": {"app": "web"} if selector is None else selector,
            "ports": ports
            if ports is not None
            else [{"name": "http", "port": 80, "targetPort": "http"}],
        },
    }


async def connect(port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    return await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), SECONDS)


async def hang_up(writer: asyncio.StreamWriter) -> None:
    writer.close()
    with contextlib.suppress(ConnectionError):
        await writer.wait_closed()


async def echo(port: int, data: bytes = b"ping") -> bytes:
    """Send `data` to the local port and read as many bytes back."""
    reader, writer = await connect(port)
    try:
        writer.write(data)
        await writer.drain()
        return await asyncio.wait_for(reader.readexactly(len(data)), SECONDS)
    finally:
        await hang_up(writer)


async def closed_by_peer(reader: asyncio.StreamReader) -> bool:
    """Whether the other end closed the connection (EOF, or a reset)."""
    try:
        return await asyncio.wait_for(reader.read(100), SECONDS) == b""
    except ConnectionError:
        return True


async def refused(port: int) -> bool:
    """Whether nothing listens on the local port any more."""
    try:
        _, writer = await connect(port)
    except OSError:
        return True
    await hang_up(writer)
    return False


async def until(condition: Callable[[], bool]) -> None:
    for _ in range(SECONDS * 100):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")

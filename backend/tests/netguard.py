"""A suite-wide backstop: a test that tries to reach a non-loopback host fails loudly.

Every default test talks to local fakes, the local kind cluster or nothing. A regression that
sends a request to a real cloud (or anywhere else) must not depend on a fake transport patch to
be caught. Name lookups and connects (blocking sockets and asyncio loops) are refused for any
host that isn't loopback (127.0.0.0/8, ::1, localhost), and the test fails at teardown even when
the code under test swallowed the refusal.
"""

import asyncio.proactor_events
import asyncio.selector_events
import ipaddress
import socket


class NetworkRefused(OSError):
    """The test network guard refused a non-loopback address."""


def allowed_host(host: object) -> bool:
    if host is None:
        return True  # a passive (bind) lookup
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    name = str(host).strip("[]").lower()
    if name in ("", "localhost") or name.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(name.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _allowed_address(address: object) -> bool:
    # AF_UNIX paths and other non-IP addresses are local by nature.
    return not isinstance(address, tuple) or allowed_host(address[0])


def install(monkeypatch, violations: list[str]) -> None:
    """Patch name lookup and every connect entry point; record each refusal in `violations`."""

    def refuse(what: object) -> NetworkRefused:
        violations.append(repr(what))
        return NetworkRefused(f"Test network guard: refused to reach {what!r}")

    getaddrinfo = socket.getaddrinfo

    def guarded_getaddrinfo(host, *args, **kwargs):
        if not allowed_host(host):
            raise refuse(host)
        return getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)

    for name in ("connect", "connect_ex"):
        original = getattr(socket.socket, name)

        def guarded(self, address, _original=original):
            if not _allowed_address(address):
                raise refuse(address)
            return _original(self, address)

        monkeypatch.setattr(socket.socket, name, guarded)

    for loop_type in (
        asyncio.proactor_events.BaseProactorEventLoop,
        asyncio.selector_events.BaseSelectorEventLoop,
    ):
        original = loop_type.sock_connect

        async def guarded_sock_connect(self, sock, address, _original=original):
            if not _allowed_address(address):
                raise refuse(address)
            return await _original(self, sock, address)

        monkeypatch.setattr(loop_type, "sock_connect", guarded_sock_connect)

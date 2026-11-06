import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

from omnikrux.watch.source import WatchEvent


@dataclass
class Hold:
    """A watch script entry: stay open for ``seconds``, then play ``then`` (events or an exception)."""

    seconds: float
    then: list | BaseException


class FakeSource:
    """Scripted ResourceSource.

    ``factory()`` raises each of ``factory_errors`` in turn, then returns itself.
    ``list()`` pops the next ``(items, rv)``. ``watch()`` pops the next entry: a list
    yields its events and then ends normally; an exception instance is raised; a ``Hold``
    waits first. Once a script is used up, ``list()`` and ``watch()`` block forever.
    ``watch_times`` records the loop time at which each watch started.
    """

    def __init__(self, lists=(), watches=(), factory_errors=()):
        self.lists = list(lists)
        self.watches = list(watches)
        self.factory_errors = list(factory_errors)
        self.watched_from: list[str] = []
        self.watch_times: list[float] = []
        self._never = asyncio.Event()

    async def factory(self) -> "FakeSource":
        if self.factory_errors:
            raise self.factory_errors.pop(0)
        return self

    async def list(self) -> tuple[list[dict], str]:
        if not self.lists:
            await self._never.wait()
        return self.lists.pop(0)

    async def watch(self, resource_version: str) -> AsyncIterator[WatchEvent]:
        self.watched_from.append(resource_version)
        self.watch_times.append(asyncio.get_running_loop().time())
        if not self.watches:
            await self._never.wait()
        entry = self.watches.pop(0)
        if isinstance(entry, Hold):
            await asyncio.sleep(entry.seconds)
            entry = entry.then
        if isinstance(entry, BaseException):
            raise entry
        for event in entry:
            yield event

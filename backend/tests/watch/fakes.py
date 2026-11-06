import asyncio
from collections.abc import AsyncIterator

from omnikrux.watch.source import WatchEvent


class FakeSource:
    """Scripted ResourceSource.

    ``factory()`` raises each of ``factory_errors`` in turn, then returns itself.
    ``list()`` pops the next ``(items, rv)``. ``watch()`` pops the next entry: a list
    yields its events and then ends normally; an exception instance is raised.
    Once a script is used up, ``list()`` and ``watch()`` block forever.
    """

    def __init__(self, lists=(), watches=(), factory_errors=()):
        self.lists = list(lists)
        self.watches = list(watches)
        self.factory_errors = list(factory_errors)
        self.watched_from: list[str] = []
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
        if not self.watches:
            await self._never.wait()
        entry = self.watches.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        for event in entry:
            yield event

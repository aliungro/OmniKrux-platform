from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol

from omnikrux.resources.rows import ResourceRow


@dataclass
class WatchEvent:
    type: Literal["ADDED", "MODIFIED", "DELETED"]
    object: dict


class Expired(Exception):
    """The watch's resourceVersion is too old (HTTP 410): relist."""


class ResourceSource(Protocol):
    def to_row(self, obj: dict, cluster_id: str) -> ResourceRow:
        """The row for one of this source's objects (it may raise for a malformed object)."""
        ...

    async def list(self) -> tuple[list[dict], str]:
        """Return all items and the list's resourceVersion."""
        ...

    def watch(self, resource_version: str) -> AsyncIterator[WatchEvent]:
        """Stream changes after `resource_version`.

        May raise `Expired`, or end normally when the server times the watch out.
        """
        ...

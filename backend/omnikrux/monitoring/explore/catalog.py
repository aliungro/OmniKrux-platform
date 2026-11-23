"""The project catalog: what each source linked to a project holds under that link's filter.

A source's catalog is built by its connector (`Connector.catalog`) and kept in a `CatalogCache`
keyed by the project, the source, the link's filter text and the source's `updated_at`. So one
project's entry is never served to another, even over the same source and filter, and changing a
link's filter or the source itself builds a new entry.

The cache:
- serves an entry for `ttl` (an error for `error_ttl`), unless asked to refresh;
- rebuilds on a refresh at most once per `refresh_gap`;
- runs one build per key at a time, which every caller for that key awaits (single flight);
- bounds each build by `timeout` inside the shared task, so a timed-out build ends there and its
  error is cached like any other; a caller that goes away never cancels the shared build;
- keeps at most `max_entries`, dropping the least recently used.

A source's failure, of any kind, is that source's `error` entry in plain words; it never fails the
project's other sources."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Literal

from omnikrux.monitoring.projects.types import Link, Matcher
from omnikrux.monitoring.query.filters import FilterError, render_matchers
from omnikrux.monitoring.sources.connector import (
    QueryRejected,
    SourceCatalog,
    UnknownSourceType,
)
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import SourceConfig, SourceType

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

# The sources whose contents a catalog lists; an Alertmanager holds alerts, not metrics or logs.
QUERYABLE_TYPES: frozenset[str] = frozenset({"prometheus", "loki"})

CATALOG_TTL = 300.0
CATALOG_ERROR_TTL = 30.0
CATALOG_REFRESH_GAP = 10.0
CATALOG_MAX_ENTRIES = 64
CATALOG_BUILD_TIMEOUT = 20.0
CATALOG_CONCURRENCY = 4

# The name of every build task, so a check can find any still running.
CATALOG_TASK = "omnikrux-catalog-build"

# Fixed copy: it names the planned 20 s whatever timeout a cache is given.
TIMED_OUT = "{name} didn't describe its contents within 20 seconds. Try again, or check the tool."
COULD_NOT_DESCRIBE = "{name} couldn't describe its contents. Try again, or check the tool."

CatalogKey = tuple[str, str, str, str]  # project id, source id, filter text, source updated_at
CatalogState = Literal["ok", "partial", "error"]

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CatalogEntry:
    """One source's catalog for one project. `partial` when the catalog carries notes (something
    the source couldn't list); `error` with plain words in `message` and no catalog. `built_at`
    (seconds, on the cache's clock) is when the build finished."""

    source_id: str
    source_name: str
    source_type: SourceType
    state: CatalogState
    message: str | None
    catalog: SourceCatalog | None
    built_at: float


def catalog_key(project_id: str, link: Link, source: SourceConfig) -> CatalogKey:
    """The entry's key; `FilterError` for a stored filter that can't be written out."""
    return (project_id, source.id, render_matchers(link.matchers), source.updated_at.isoformat())


def error_entry(source: SourceConfig, message: str, built_at: float) -> CatalogEntry:
    return CatalogEntry(
        source_id=source.id,
        source_name=source.name,
        source_type=source.type,
        state="error",
        message=message,
        catalog=None,
        built_at=built_at,
    )


class CatalogCacheClosed(RuntimeError):
    """The cache was closed (the app is stopping): it starts no build."""

    def __init__(self) -> None:
        super().__init__("The catalog cache is closed.")


def _retrieve(task: asyncio.Task[CatalogEntry]) -> None:
    if not task.cancelled():
        task.exception()


class CatalogCache:
    """Built catalogs by `CatalogKey`, and the builds in flight (see the module docstring)."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.time,
        ttl: float = CATALOG_TTL,
        error_ttl: float = CATALOG_ERROR_TTL,
        refresh_gap: float = CATALOG_REFRESH_GAP,
        max_entries: int = CATALOG_MAX_ENTRIES,
        timeout: float = CATALOG_BUILD_TIMEOUT,
    ) -> None:
        self._clock = clock
        self._ttl = ttl
        self._error_ttl = error_ttl
        self._refresh_gap = refresh_gap
        self._max_entries = max_entries
        self._timeout = timeout
        self._entries: OrderedDict[CatalogKey, CatalogEntry] = OrderedDict()
        self._building: dict[CatalogKey, asyncio.Task[CatalogEntry]] = {}
        self._closed = False

    @property
    def timeout(self) -> float:
        """How long one build may run, in seconds."""
        return self._timeout

    def now(self) -> float:
        return self._clock()

    async def get(
        self,
        key: CatalogKey,
        build: Callable[[], Awaitable[CatalogEntry]],
        *,
        refresh: bool,
        timed_out: Callable[[], CatalogEntry],
    ) -> CatalogEntry:
        """The key's entry: the stored one while it is fresh (younger than `ttl`, or `error_ttl`
        for an error), or with `refresh` while it is younger than `refresh_gap`; otherwise the
        build in flight for the key (a refresh joins it too), or a new one. A build that runs
        past the timeout ends with `timed_out()`'s entry, cached like any other.
        `CatalogCacheClosed` once the cache is closed: no new build starts then."""
        if self._closed:
            raise CatalogCacheClosed()
        stored = self._entries.get(key)
        if stored is not None:
            if refresh:
                keep = self._refresh_gap
            else:
                keep = self._error_ttl if stored.state == "error" else self._ttl
            if self._clock() - stored.built_at < keep:
                self._entries.move_to_end(key)
                return stored
        task = self._building.get(key)
        if task is None:
            task = asyncio.create_task(self._build(key, build, timed_out), name=CATALOG_TASK)
            # Every caller may have gone by the time a build fails: its failure is read here, so
            # it is never reported as an exception nobody retrieved.
            task.add_done_callback(_retrieve)
            self._building[key] = task
        # A caller that goes away (a closed request) cancels only its own wait.
        return await asyncio.shield(task)

    async def _build(
        self,
        key: CatalogKey,
        build: Callable[[], Awaitable[CatalogEntry]],
        timed_out: Callable[[], CatalogEntry],
    ) -> CatalogEntry:
        try:
            try:
                entry = await asyncio.wait_for(build(), self._timeout)
            except TimeoutError:
                entry = timed_out()
            entry = replace(entry, built_at=self._clock())
            self._entries[key] = entry
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
            return entry
        finally:
            # The finished build hands its slot over to the entry it stored.
            self._building.pop(key, None)

    def forget_project(self, project_id: str) -> None:
        """Drop the project's stored entries (a build in flight still stores its own)."""
        for key in [key for key in self._entries if key[0] == project_id]:
            del self._entries[key]

    async def close(self) -> None:
        """Cancel the builds in flight and wait until they have ended; later reads are refused."""
        self._closed = True
        tasks = list(self._building.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._building.clear()
        self._entries.clear()


async def project_catalog(
    services: MonitoringServices, project_id: str, *, refresh: bool
) -> list[CatalogEntry]:
    """One entry per link, in link order, each through the cache: at most `CATALOG_CONCURRENCY`
    of this call's sources are read at once, each build bounded by the cache's timeout.
    `UnknownProject` when the project doesn't exist; a link whose source went meanwhile is left
    out.

    The whole call answers within the cache's timeout, however many sources hang: a link still
    waiting for its turn, or for its build, at the call's deadline is answered with the timeout
    error then. That answer isn't cached; the shared build keeps its own bound and stores its own
    result."""
    project = await services.projects.get(project_id)
    cache = services.catalogs
    running = asyncio.Semaphore(CATALOG_CONCURRENCY)
    deadline = asyncio.get_running_loop().time() + cache.timeout

    async def one(link: Link) -> CatalogEntry | None:
        try:
            source = await services.sources.get(link.source_id)
        except KeyError:
            return None
        if source.type not in QUERYABLE_TYPES:
            return None  # an Alertmanager holds no metrics or logs
        try:
            key = catalog_key(project_id, link, source)
        except FilterError as exc:
            return error_entry(source, str(exc), cache.now())

        def timed_out() -> CatalogEntry:
            return error_entry(source, TIMED_OUT.format(name=source.name), cache.now())

        try:
            async with asyncio.timeout_at(deadline):
                async with running:
                    return await cache.get(
                        key,
                        _builder(services, source, link.matchers),
                        refresh=refresh,
                        timed_out=timed_out,
                    )
        except TimeoutError:
            # Only this wait ends: the shared build, behind its shield, runs on.
            return timed_out()

    entries = await asyncio.gather(*(one(link) for link in project.links))
    return [entry for entry in entries if entry is not None]


def _builder(
    services: MonitoringServices, source: SourceConfig, matchers: Sequence[Matcher]
) -> Callable[[], Awaitable[CatalogEntry]]:
    """The build of one source's entry. Every failure becomes the source's `error` entry: the
    secrets are checked before any request, as for a query."""

    async def build() -> CatalogEntry:
        began = services.catalogs.now()
        if source.secrets_unreadable:
            return error_entry(source, SECRETS_UNREADABLE, began)
        try:
            connector = services.connectors.get(source.type)
        except UnknownSourceType as exc:
            return error_entry(source, exc.message, began)
        try:
            catalog = await connector.catalog(
                services.transports.for_source(source), matchers=matchers, now=time.time()
            )
        except (SourceUnreachable, QueryRejected) as exc:
            return error_entry(source, exc.message, began)
        except Exception as exc:  # noqa: BLE001 (said in words; logged by type)
            # A fault in OmniKrux, not in the tool. The log names the source and the kind of
            # failure, never its text (it could carry the tool's answer).
            log.warning(
                "The catalog of source %s failed unexpectedly (%s).",
                source.id,
                type(exc).__name__,
            )
            return error_entry(source, COULD_NOT_DESCRIBE.format(name=source.name), began)
        return CatalogEntry(
            source_id=source.id,
            source_name=source.name,
            source_type=source.type,
            state="partial" if catalog.notes else "ok",
            message=None,
            catalog=catalog,
            built_at=began,
        )

    return build

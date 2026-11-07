from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from kubernetes_asyncio.client import ApiClient

from omnikrux.kube.client import ClusterUnavailable
from omnikrux.kube.http import status_message
from omnikrux.resources.kinds import KindSpec
from omnikrux.resources.rows import ResourceRow
from omnikrux.watch.source import Expired, ResourceSource, WatchEvent

logger = logging.getLogger(__name__)

LIST_PAGE_SIZE = 500
LIST_ATTEMPTS = 3  # full restarts when a continue token expires mid-paging
WATCH_TIMEOUT_SECONDS = 300
# (connect, read) client-side timeouts: a silent connection fails instead of hanging.
LIST_REQUEST_TIMEOUT = (30, 120)
WATCH_REQUEST_TIMEOUT = (30, WATCH_TIMEOUT_SECONDS + 60)
# Upper bound for the API probe that runs before a source's first request.
PROBE_TIMEOUT_SECONDS = 30

EVENT_TYPES = ("ADDED", "MODIFIED", "DELETED")


class KubeResourceSource(ResourceSource):
    """`ResourceSource` for one kind on one cluster, across all namespaces (and only the objects
    matching the spec's label selector, if it has one).

    Owns `api`: `aclose()` closes it. Objects are plain JSON dicts as the API returns them.
    """

    def __init__(
        self,
        api: ApiClient,
        spec: KindSpec,
        *,
        probe_timeout: float = PROBE_TIMEOUT_SECONDS,
    ):
        self._api = api
        self._spec = spec
        self._probe_timeout = probe_timeout
        self._probed = False
        self._closed = False
        # The newest resourceVersion this source has handed to its caller (list or event),
        # and the newest it has seen at all (including bookmarks, which emit nothing).
        self._handed_out_rv: str | None = None
        self._latest_rv: str | None = None

    async def list(self) -> tuple[list[dict], str]:
        for attempt in range(1, LIST_ATTEMPTS + 1):
            try:
                return await self._list_once()
            except Expired as exc:  # the continue token expired: start over
                if attempt == LIST_ATTEMPTS:
                    raise RuntimeError(f"Kubernetes API returned 410: {exc}") from exc
                logger.debug("list of %s expired mid-paging, restarting", self._spec.plural)
        raise AssertionError("unreachable")

    async def _list_once(self) -> tuple[list[dict], str]:
        await self._ensure_probed()
        items: list[dict] = []
        token = None
        while True:
            params: list[tuple[str, object]] = [("limit", LIST_PAGE_SIZE)]
            if token:
                params.append(("continue", token))
            resp = await self._get(params, LIST_REQUEST_TIMEOUT)
            await self._raise_for_status(resp, f"list {self._spec.plural}")
            try:
                body = json.loads(await resp.read())
            finally:
                resp.release()
            items.extend(body.get("items") or [])
            metadata = body.get("metadata") or {}
            token = metadata.get("continue")
            if not token:
                rv = metadata.get("resourceVersion") or ""
                self._handed_out_rv = self._latest_rv = rv
                return items, rv

    async def watch(self, resource_version: str) -> AsyncIterator[WatchEvent]:
        await self._ensure_probed()
        start = resource_version
        if resource_version == self._handed_out_rv and self._latest_rv:
            start = self._latest_rv  # a bookmark moved past the caller's rv with no events between
        resp = await self._get(
            [
                ("watch", "true"),
                ("resourceVersion", start),
                ("timeoutSeconds", WATCH_TIMEOUT_SECONDS),
                ("allowWatchBookmarks", "true"),
            ],
            WATCH_REQUEST_TIMEOUT,
        )
        await self._raise_for_status(resp, f"watch {self._spec.plural}")
        try:
            buffer = b""
            async for chunk in resp.content.iter_any():
                buffer += chunk
                *lines, buffer = buffer.split(b"\n")
                for line in lines:
                    if (event := self._event(line)) is not None:
                        yield event
            if (event := self._event(buffer)) is not None:
                yield event
        finally:
            resp.close()

    def to_row(self, obj: dict, cluster_id: str) -> ResourceRow:
        return self._spec.to_row(obj, cluster_id)

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            await self._api.close()

    async def _get(self, params: list[tuple[str, object]], timeout: tuple[int, int]):
        """GET the spec's collection (raw: the caller checks the status and releases it)."""
        if self._spec.label_selector:
            params = [*params, ("labelSelector", self._spec.label_selector)]
        return await self._api.call_api(
            self._spec.list_path(),
            "GET",
            query_params=params,
            header_params={"Accept": "application/json"},
            auth_settings=["BearerToken"],
            _preload_content=False,
            _return_http_data_only=True,
            _request_timeout=timeout,
        )

    async def _ensure_probed(self) -> None:
        if self._probed:
            return
        try:
            async with asyncio.timeout(self._probe_timeout):
                await self._probe()
        except TimeoutError as exc:
            raise ClusterUnavailable(
                f"The cluster API did not respond within {self._probe_timeout:g} s"
            ) from exc
        self._probed = True

    async def _probe(self) -> None:
        """GET /api, so a silent or refusing API gets a plain message before the first list."""
        resp = await self._api.call_api(
            "/api",
            "GET",
            header_params={"Accept": "application/json"},
            auth_settings=["BearerToken"],
            _preload_content=False,
            _return_http_data_only=True,
            _request_timeout=LIST_REQUEST_TIMEOUT,
        )
        await self._raise_for_status(resp, "read the cluster's API list")
        resp.release()

    async def _raise_for_status(self, resp, action: str) -> None:
        """Raise for a non-2xx response (raw calls return them instead of raising)."""
        status = resp.status
        if 200 <= status < 300:
            return
        try:
            message = status_message(await resp.read()) or resp.reason or str(status)
        finally:
            resp.release()
        if status == 410:
            raise Expired(message)
        if status == 401:
            raise ClusterUnavailable(f"The cluster rejected the console's credentials: {message}")
        if status == 403:
            raise ClusterUnavailable(f"Not allowed to {action}: {message}")
        raise RuntimeError(f"Kubernetes API returned {status}: {message}")

    def _event(self, line: bytes) -> WatchEvent | None:
        """Translate one watch line; None for blank lines, bookmarks and unknown types."""
        if not line.strip():
            return None
        data = json.loads(line)
        kind = data.get("type")
        obj = data.get("object")
        if kind is None and "code" in data:  # a bare Status instead of an event
            kind, obj = "ERROR", data
        obj = obj if isinstance(obj, dict) else {}
        rv = (obj.get("metadata") or {}).get("resourceVersion")
        if kind == "ERROR":
            message = obj.get("message") or f"watch failed with code {obj.get('code')}"
            if obj.get("code") == 410:
                raise Expired(message)
            raise RuntimeError(message)
        if kind == "BOOKMARK":
            self._latest_rv = rv or self._latest_rv
            return None
        if kind not in EVENT_TYPES:
            logger.debug("ignoring watch event of type %r", kind)
            return None
        if rv:
            self._handed_out_rv = self._latest_rv = rv
        return WatchEvent(kind, obj)

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.dynamic import DynamicClient

from omnikrux.kube.client import ClusterUnavailable
from omnikrux.resources.kinds import KindSpec
from omnikrux.watch.source import Expired, ResourceSource, WatchEvent

logger = logging.getLogger(__name__)

LIST_PAGE_SIZE = 500
LIST_ATTEMPTS = 3  # full restarts when a continue token expires mid-paging
WATCH_TIMEOUT_SECONDS = 300
# (connect, read) client-side timeouts: a silent connection fails instead of hanging.
LIST_REQUEST_TIMEOUT = (30, 120)
WATCH_REQUEST_TIMEOUT = (30, WATCH_TIMEOUT_SECONDS + 60)

EVENT_TYPES = ("ADDED", "MODIFIED", "DELETED")


class KubeResourceSource(ResourceSource):
    """`ResourceSource` for one kind on one cluster, across all namespaces.

    Owns `api`: `aclose()` closes it. Objects are plain JSON dicts as the API returns them.
    """

    def __init__(self, api: ApiClient, spec: KindSpec):
        self._api = api
        self._spec = spec
        self._dynamic = None
        self._resource = None
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
        dynamic, resource = await self._resolve()
        items: list[dict] = []
        token = None
        while True:
            resp = await dynamic.request(
                "get",
                resource.path(),
                limit=LIST_PAGE_SIZE,
                _continue=token,
                serialize=False,
                _request_timeout=LIST_REQUEST_TIMEOUT,
            )
            await self._raise_for_status(resp, "list")
            try:
                body = await resp.json()
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
        dynamic, resource = await self._resolve()
        start = resource_version
        if resource_version == self._handed_out_rv and self._latest_rv:
            start = self._latest_rv  # a bookmark moved past the caller's rv with no events between
        resp = await dynamic.request(
            "get",
            resource.path(),
            watch=True,
            resource_version=start,
            timeout_seconds=WATCH_TIMEOUT_SECONDS,
            query_params=[("allowWatchBookmarks", "true")],
            serialize=False,
            _request_timeout=WATCH_REQUEST_TIMEOUT,
        )
        await self._raise_for_status(resp, "watch")
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

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            await self._api.close()

    async def _resolve(self):
        if self._resource is None:
            dynamic = await DynamicClient(self._api)
            spec = self._spec
            self._resource = await dynamic.resources.get(
                prefix="apis" if spec.group else "api",
                group=spec.group or None,
                api_version=spec.version,
                kind=spec.kind,
                name=spec.plural,
            )
            self._dynamic = dynamic
        return self._dynamic, self._resource

    async def _raise_for_status(self, resp, verb: str) -> None:
        """Raise for a non-2xx response (the dynamic client returns them instead of raising)."""
        status = resp.status
        if 200 <= status < 300:
            return
        try:
            message = _status_message(await resp.read()) or resp.reason or str(status)
        finally:
            resp.release()
        if status == 410:
            raise Expired(message)
        if status == 401:
            raise ClusterUnavailable(f"The cluster rejected the console's credentials: {message}")
        if status == 403:
            raise ClusterUnavailable(f"Not allowed to {verb} {self._spec.plural}: {message}")
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


def _status_message(body: bytes) -> str | None:
    """The `message` of a Kubernetes Status body; None when the body isn't one (e.g. HTML)."""
    try:
        data = json.loads(body)
    except ValueError:
        return None
    message = data.get("message") if isinstance(data, dict) else None
    return message if isinstance(message, str) and message else None

import json
import logging
from collections.abc import AsyncIterator

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.rest import ApiException
from kubernetes_asyncio.dynamic import DynamicClient

from omnikrux.resources.kinds import KindSpec
from omnikrux.watch.source import Expired, ResourceSource, WatchEvent

logger = logging.getLogger(__name__)

LIST_PAGE_SIZE = 500
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
        try:
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
        except ApiException as exc:
            if exc.status == 410:
                raise Expired(str(exc.reason)) from exc
            raise
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

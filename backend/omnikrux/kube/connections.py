"""One place that turns a registered cluster into Kubernetes clients, and errors into words."""

import hashlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Protocol

import aiohttp
from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException
from kubernetes_asyncio.stream import WsApiClient

from omnikrux.kube.client import (
    ClusterUnavailable,
    kubeconfig_user,
    make_api_client,
    make_ws_api_client,
)
from omnikrux.kube.tokens import (
    CachedToken,
    ExecPluginToken,
    ExecResolver,
    NativeToken,
    RunPlugin,
    TokenSource,
)

MAX_REASON = 200


class KubeconfigSource(Protocol):
    async def get_kubeconfig(self, cluster_id: str) -> dict: ...


TokensFor = Callable[[str], Awaitable[TokenSource | None]]


class ClusterConnections:
    """Builds clients from the registry's kubeconfig. Unknown cluster: KeyError;
    exec plugin missing: ClusterUnavailable."""

    def __init__(
        self,
        registry: KubeconfigSource,
        *,
        tokens_for: TokensFor | None = None,
        exec_resolver: ExecResolver | None = None,
    ):
        self._registry = registry
        self._tokens_for = tokens_for
        self._exec_resolver = exec_resolver if exec_resolver is not None else RunPlugin
        self._exec_tokens: dict[str, dict[str, CachedToken]] = {}

    async def _client_inputs(self, cluster_id: str) -> tuple[dict, TokenSource | None]:
        kubeconfig = await self._registry.get_kubeconfig(cluster_id)
        if (
            self._tokens_for is not None
            and (token := await self._tokens_for(cluster_id)) is not None
        ):
            return kubeconfig, token

        exec_cfg = kubeconfig_user(kubeconfig).get("exec")
        if not isinstance(exec_cfg, dict):
            return kubeconfig, None
        digest = hashlib.sha256(json.dumps(exec_cfg, sort_keys=True).encode()).hexdigest()
        sources = self._exec_tokens.setdefault(cluster_id, {})
        if digest not in sources:
            plan = self._exec_resolver(exec_cfg)
            sources[digest] = CachedToken(
                plan.fetch if isinstance(plan, NativeToken) else ExecPluginToken(plan)
            )
        return kubeconfig, sources[digest]

    def forget(self, cluster_id: str) -> None:
        self._exec_tokens.pop(cluster_id, None)

    async def open_api(self, cluster_id: str) -> ApiClient:
        """A fresh client the caller owns and must close."""
        kubeconfig, token = await self._client_inputs(cluster_id)
        return await make_api_client(kubeconfig, token=token)

    @asynccontextmanager
    async def api(self, cluster_id: str) -> AsyncIterator[ApiClient]:
        client = await self.open_api(cluster_id)
        try:
            yield client
        finally:
            await client.close()

    @asynccontextmanager
    async def ws_api(self, cluster_id: str) -> AsyncIterator[WsApiClient]:
        """A WebSocket-capable client (for exec), built from the same configuration."""
        kubeconfig, token = await self._client_inputs(cluster_id)
        client = await make_ws_api_client(kubeconfig, token=token)
        try:
            yield client
        finally:
            await client.close()


def _status_message(exc: ApiException) -> str | None:
    try:
        data = json.loads(exc.body or "")
    except (ValueError, TypeError):
        return None
    message = data.get("message") if isinstance(data, dict) else None
    return message if isinstance(message, str) and message else None


def _short_reason(exc: Exception) -> str:
    lines = str(exc).strip().splitlines()
    text = f"{type(exc).__name__}: {lines[0]}" if lines else type(exc).__name__
    return text[:MAX_REASON]


def kube_error_message(exc: Exception, action: str) -> str:
    """A plain-words message for a failed cluster call; never headers, bodies or tracebacks."""
    if isinstance(exc, ClusterUnavailable):
        return exc.message
    if isinstance(exc, ApiException):
        if exc.status == 401:
            return f"The cluster rejected the console's credentials while trying to {action}."
        if exc.status == 403:
            return f"Not allowed to {action}: {_status_message(exc) or 'forbidden'}"
        if exc.status == 404:
            return f"{action}: not found (it may have just been deleted)."
        if exc.status in (400, 422):  # the API server says in words what was wrong
            reason = (_status_message(exc) or "the cluster refused the request")[:MAX_REASON]
            return f"Couldn't {action}: {reason}"
    elif isinstance(exc, aiohttp.ClientConnectorError):
        return f"Can't reach the cluster while trying to {action}: {exc.os_error}"
    elif isinstance(exc, TimeoutError | aiohttp.ServerTimeoutError):
        return f"The cluster didn't answer while trying to {action}."
    return f"Couldn't {action}: {_short_reason(exc)}"

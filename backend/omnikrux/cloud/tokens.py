from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING

from omnikrux.cloud.adapters import ProviderAdapter
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.messages import ACCOUNT_REMOVED
from omnikrux.cloud.store import CloudAccountStore
from omnikrux.cloud.types import AccountConfig, CloudClusterRef, CloudProvider
from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.kube.tokens import (
    BearerToken,
    CachedToken,
    CloudClusterUnavailable,
    CloudTokenSource,
    ClusterUnavailable,
    TokenSource,
)

if TYPE_CHECKING:
    from omnikrux.cloud.discovery import CloudDiscovery

_CLUSTER_FORGOTTEN = "The cloud cluster connection was removed. Reopen the cluster and try again."
_SHUTTING_DOWN = "The cloud connection is shutting down. Try again when Omnikrux is running."


class _ClusterToken:
    def __init__(
        self, ref: CloudClusterRef, refresh: Callable[[_ClusterToken], Awaitable[BearerToken]]
    ) -> None:
        self.ref = ref
        self._cache: CachedToken | None = CachedToken(partial(refresh, self))
        self.reject_provider_token: Callable[[str], None] | None = None
        self.source = CloudTokenSource(self)
        self.account_checked = False
        self._forgotten: str | None = None

    def require_active(self) -> None:
        if self._forgotten is not None:
            raise CloudClusterUnavailable(self._forgotten)

    async def __call__(self) -> BearerToken:
        self.require_active()
        assert self._cache is not None
        try:
            token = await self._cache()
        except ClusterUnavailable as exc:
            # CachedToken can reject an expired provider result with its own fixed diagnostic.
            raise CloudClusterUnavailable(exc.message) from None
        self.require_active()
        return token

    def reject(self, value: str) -> None:
        if self._cache is not None:
            self._cache.reject(value)
            if self.reject_provider_token is not None:
                self.reject_provider_token(value)

    def forget(self, message: str) -> None:
        self._forgotten = message
        # Detach the cache. An in-flight waiter can settle without retrying the retired fetch.
        self._cache = None
        self.reject_provider_token = None


class TokenBroker:
    def __init__(
        self,
        registry: ClusterRegistry,
        store: CloudAccountStore,
        adapters: dict[CloudProvider, ProviderAdapter],
    ) -> None:
        self._registry = registry
        self._store = store
        self._adapters = adapters
        self._sources: dict[str, _ClusterToken] = {}
        self._refreshes: dict[str, asyncio.Task[BearerToken]] = {}
        self._closed = False

    async def tokens_for(self, cluster_id: str) -> TokenSource | None:
        while True:
            self._require_open()
            ref = await self._registry.cloud_ref(cluster_id)
            self._require_open()
            if ref is None:
                return None
            source = self._sources.get(cluster_id)
            if source is not None and source.ref == ref:
                break
            self.forget(cluster_id)
            if pending := self._refreshes.get(cluster_id):
                await asyncio.wait((pending,))
                continue  # Re-read the cluster after a previous source's refresh has settled.
            source = self._sources[cluster_id] = _ClusterToken(
                ref, partial(self._refresh, cluster_id)
            )
            break
        if not source.account_checked:
            await self._account(source)
            source.account_checked = True
        return source.source

    def _require_open(self) -> None:
        if self._closed:
            raise CloudClusterUnavailable(_SHUTTING_DOWN)

    async def _account(self, source: _ClusterToken) -> AccountConfig:
        try:
            account = await self._store.config(source.ref.account_id)
        except KeyError:
            raise CloudClusterUnavailable(ACCOUNT_REMOVED) from None
        source.require_active()
        return account

    async def _refresh(self, cluster_id: str, source: _ClusterToken) -> BearerToken:
        source.require_active()
        task = asyncio.current_task()
        assert task is not None
        self._refreshes[cluster_id] = task
        try:
            account = await self._account(source)
            try:
                fetch = self._adapters[source.ref.provider].token_fetch(account, source.ref)
                token = await fetch()
            except CloudError as exc:
                source.require_active()
                raise CloudClusterUnavailable(exc.message) from None
            source.require_active()
            # Some providers also cache the credential shared with discovery.
            source.reject_provider_token = getattr(fetch, "reject", None)
            return token
        finally:
            del self._refreshes[cluster_id]

    def forget(self, cluster_id: str) -> None:
        if (source := self._sources.pop(cluster_id, None)) is not None:
            source.forget(_CLUSTER_FORGOTTEN)

    def forget_account(self, account_id: str) -> None:
        for cluster_id, source in list(self._sources.items()):
            if source.ref.account_id == account_id:
                self._sources.pop(cluster_id)
                source.forget(ACCOUNT_REMOVED)
        # Discovery may have cached credentials for an account with no added clusters.
        for adapter in self._adapters.values():
            adapter.forget(account_id)

    async def close(self) -> None:
        self._closed = True
        for source in self._sources.values():
            source.forget(_SHUTTING_DOWN)
        self._sources.clear()
        if self._refreshes:
            await asyncio.wait(tuple(self._refreshes.values()))


@dataclass
class CloudServices:
    store: CloudAccountStore
    adapters: dict[CloudProvider, ProviderAdapter]
    broker: TokenBroker
    http: CloudHttp
    discovery: CloudDiscovery

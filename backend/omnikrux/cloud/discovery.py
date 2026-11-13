import asyncio
import logging
from datetime import UTC, datetime

from omnikrux.cloud.adapters import (
    DISCOVERY_TIMEOUT_SECONDS,
    DiscoveryResult,
    PartialDiscoveryAdapter,
    ProviderAdapter,
)
from omnikrux.cloud.http import CloudError
from omnikrux.cloud.messages import CHECK_FAILED, CHECK_TIMED_OUT
from omnikrux.cloud.store import CloudAccount, CloudAccountStore
from omnikrux.cloud.tokens import TokenBroker
from omnikrux.cloud.types import AccountConfig, CloudProvider
from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.watch.hub import WatchHub

log = logging.getLogger(__name__)
MAX_CONCURRENT_ACCOUNTS = 4
_SHUTTING_DOWN = "Cloud discovery is shutting down. Try again when Omnikrux is running."


class CloudDiscovery:
    def __init__(
        self,
        store: CloudAccountStore,
        adapters: dict[CloudProvider, ProviderAdapter],
        registry: ClusterRegistry,
        hub: WatchHub,
        broker: TokenBroker,
        *,
        interval: float,
        startup_delay: float = 5,
    ) -> None:
        self._store = store
        self._adapters = adapters
        self._hub = hub
        self._broker = broker
        self._interval = interval
        self._startup_delay = startup_delay
        self._slots = asyncio.Semaphore(MAX_CONCURRENT_ACCOUNTS)
        self._inflight: dict[str, asyncio.Task[CloudAccount]] = {}
        self._periodic: asyncio.Task[None] | None = None
        self._closed = False

    def start(self) -> None:
        if self._periodic is None and not self._closed:
            self._periodic = asyncio.create_task(self._scan(), name="cloud-discovery")

    def schedule(self, account_id: str) -> None:
        """Start a newly connected account's check under the same limit as other checks."""
        self._start_check(account_id)

    async def check(self, account_id: str) -> CloudAccount:
        task = self._start_check(account_id)
        if task is None:
            raise CloudError(_SHUTTING_DOWN)
        return await asyncio.shield(task)

    async def close(self) -> None:
        self._closed = True
        if self._periodic is not None:
            self._periodic.cancel()
            await asyncio.gather(self._periodic, return_exceptions=True)
        # Active checks can be waiting on a shielded provider refresh. Let them finish before
        # closing broker or HTTP resources. Queued checks exit when they acquire a slot.
        if self._inflight:
            await asyncio.wait(tuple(self._inflight.values()))

    def _start_check(self, account_id: str) -> asyncio.Task[CloudAccount] | None:
        if self._closed:
            return None
        task = self._inflight.get(account_id)
        if task is None:
            task = asyncio.create_task(self._check(account_id), name=f"cloud-check:{account_id}")
            self._inflight[account_id] = task
            task.add_done_callback(lambda done: self._done(account_id, done))
        return task

    def _done(self, account_id: str, task: asyncio.Task[CloudAccount]) -> None:
        del self._inflight[account_id]
        if (
            not task.cancelled()
            and (error := task.exception()) is not None
            and not isinstance(error, (KeyError, CloudError))
        ):
            log.warning("Could not finish a cloud account check (%s)", type(error).__name__)

    async def _scan(self) -> None:
        await asyncio.sleep(self._startup_delay)
        while True:
            try:
                accounts = await self._store.list()
            except Exception as exc:  # noqa: BLE001 (retry on the next scan)
                log.warning("Could not read cloud accounts for discovery (%s)", type(exc).__name__)
            else:
                await asyncio.gather(
                    *(self.check(account.id) for account in accounts), return_exceptions=True
                )
            await asyncio.sleep(self._interval)

    async def _check(self, account_id: str) -> CloudAccount:
        async with self._slots:
            if self._closed:
                raise CloudError(_SHUTTING_DOWN)
            account = await self._store.config(account_id)
            result, message = await self._discover(account)
            at = datetime.now(UTC)
            try:
                changed = False
                if result is not None:
                    saved = await self._store.save_discovery(
                        account_id, result.clusters, at, mark_missing=not result.problems
                    )
                    changed = bool(saved.changed_cluster_ids)
                await self._store.record_check(
                    account_id,
                    ok=result is not None,
                    message=message,
                    problems=result.problems if result is not None else [],
                    at=at,
                )
                if changed:
                    await self._hub.clusters_changed()
                return await self._store.get(account_id)
            except KeyError as exc:
                if exc.args == (account_id,):
                    self._broker.forget_account(account_id)
                raise

    async def _discover(self, account: AccountConfig) -> tuple[DiscoveryResult | None, str | None]:
        try:
            adapter = self._adapters[account.provider]
            if isinstance(adapter, PartialDiscoveryAdapter):
                return await adapter.discover(account), None
            async with asyncio.timeout(DISCOVERY_TIMEOUT_SECONDS):
                return await adapter.discover(account), None
        except CloudError as exc:
            return None, exc.message
        except TimeoutError:
            return None, CHECK_TIMED_OUT
        except Exception as exc:  # noqa: BLE001 (an adapter failure is isolated to its account)
            log.warning("Cloud discovery failed for %s (%s)", account.provider, type(exc).__name__)
            return None, CHECK_FAILED

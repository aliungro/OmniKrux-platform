import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock, Mock

import pytest

from omnikrux.cloud import discovery as discovery_module
from omnikrux.cloud.adapters import DiscoveryResult
from omnikrux.cloud.aws import AwsAdapter
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.http import CloudError
from omnikrux.cloud.oci import OciAdapter
from omnikrux.watch.hub import WatchHub
from tests.cloud.test_store import NOW, account, add, found
from tests.cloud.test_store import cloud_db as cloud_db  # noqa: PLC0414 (shared fixture)


def _discovery(cloud_db, discover):
    store, registry, _ = cloud_db
    adapter = Mock(discover=AsyncMock(side_effect=discover), verify=AsyncMock())
    hub = Mock(spec=WatchHub)
    discovery = discovery_module.CloudDiscovery(
        store, {"azure": adapter}, registry, hub, Mock(), interval=3600, startup_delay=0
    )
    return discovery, adapter, hub


@pytest.mark.parametrize("provider", ["aws", "oci"])
async def test_provider_deadline_keeps_completed_regions(cloud_db, monkeypatch, tmp_path, provider):
    store, registry, _ = cloud_db
    owner = await account(store, provider)
    await store.save_discovery(owner.id, [found("unseen")], NOW)
    finished_region = asyncio.Event()
    never = asyncio.Event()
    regions = ["us-west-1", "us-east-1"]

    async def read(region, result):
        if region == regions[0]:
            result.append(found("seen"))
            finished_region.set()
        else:
            await never.wait()

    if provider == "aws":
        from omnikrux.cloud import aws as provider_module

        adapter = AwsAdapter(CloudEndpoints(), tmp_path)
        keys = Mock(keys=AsyncMock())
        monkeypatch.setattr(adapter, "_credentials", AsyncMock(return_value=(keys, regions)))

        async def discover_region(region, _keys, result):
            await read(region, result)
    else:
        from omnikrux.cloud import oci as provider_module

        adapter = OciAdapter(Mock(), CloudEndpoints(), tmp_path)
        monkeypatch.setattr(adapter, "_entered", Mock(return_value=Mock()))
        monkeypatch.setattr(adapter, "_regions", Mock(return_value=regions))

        async def discover_region(region, _tenancy, _signer, result):
            await read(region, result.clusters)

    monkeypatch.setattr(adapter, "_discover_region", discover_region)
    monkeypatch.setattr(discovery_module, "DISCOVERY_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(provider_module, "DISCOVERY_TIMEOUT_SECONDS", 0.2, raising=False)
    discovery = discovery_module.CloudDiscovery(
        store, {provider: adapter}, registry, Mock(spec=WatchHub), Mock(), interval=3600
    )
    try:
        checked = await asyncio.wait_for(discovery.check(owner.id), timeout=1)
    finally:
        await discovery.close()

    assert finished_region.is_set()
    assert checked.check_ok is True and checked.problems
    rows = {row.cluster.resource_id: row for row in await store.discovered(owner.id)}
    assert set(rows) == {"seen", "unseen"}
    assert rows["unseen"].last_seen == NOW and rows["unseen"].missing_since is None


async def test_periodic_check_finds_new_cluster_and_isolates_a_failed_account(cloud_db):
    store, _, _ = cloud_db
    healthy = await account(store)
    broken = await store.create("azure", "cli", "broken", "Broken account", "user", {}, None)
    started = asyncio.Event()
    calls = set()

    async def discover(config):
        calls.add(config.id)
        if calls == {healthy.id, broken.id}:
            started.set()
        if config.id == broken.id:
            raise CloudError("The Azure login expired. Sign in and try again.")
        return DiscoveryResult([found()], [])

    discovery, _, _ = _discovery(cloud_db, discover)
    discovery.start()
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        ok, failed = await asyncio.gather(discovery.check(healthy.id), discovery.check(broken.id))
        [row] = await store.discovered(healthy.id)
        assert row.state == "new" and row.cluster == found()
        assert ok.check_ok is True and failed.check_ok is False
        assert await store.discovered(broken.id) == []

        await discovery.check(healthy.id)
        [seen_again] = await store.discovered(healthy.id)
        assert seen_again.id == row.id and seen_again.first_seen == row.first_seen
    finally:
        await discovery.close()


async def test_periodic_and_manual_check_share_account_through_persistence(cloud_db, monkeypatch):
    store, _, _ = cloud_db
    owner = await account(store)
    old = found("existing")
    fresh = replace(old, kubernetes_version="1.31")
    newly_seen = found("newly-seen")
    old_save_started = asyncio.Event()
    old_save_finished = asyncio.Event()
    release_old_save = asyncio.Event()
    save_discovery = store.save_discovery
    observed_results = iter(([old], [fresh, newly_seen], [fresh, newly_seen]))

    async def discover(_config):
        return DiscoveryResult(next(observed_results), [])

    async def pause_older_save(account_id, clusters, at, **kwargs):
        if clusters != [old]:
            return await save_discovery(account_id, clusters, at, **kwargs)
        old_save_started.set()
        await release_old_save.wait()
        try:
            return await save_discovery(account_id, clusters, at, **kwargs)
        finally:
            old_save_finished.set()

    monkeypatch.setattr(store, "save_discovery", pause_older_save)
    discovery, adapter, _ = _discovery(cloud_db, discover)
    discovery.start()
    manual = None
    try:
        await asyncio.wait_for(old_save_started.wait(), timeout=5)
        manual = asyncio.create_task(discovery.check(owner.id))
        finished_while_old_save_blocked, _ = await asyncio.wait({manual}, timeout=0.5)
        release_old_save.set()
        await asyncio.wait_for(old_save_finished.wait(), timeout=5)
        await asyncio.wait_for(manual, timeout=5)

        # A joined check may share the periodic result. A queued check sees the newer result.
        calls = adapter.discover.await_count
        assert calls in (1, 2)
        expected = [old] if calls == 1 else [fresh, newly_seen]
        rows = await store.discovered(owner.id)
        assert {row.cluster.resource_id: row.cluster for row in rows} == {
            cluster.resource_id: cluster for cluster in expected
        }
        assert all(row.missing_since is None for row in rows)
        assert not finished_while_old_save_blocked

        await discovery.check(owner.id)
        rows = await store.discovered(owner.id)
        assert {row.cluster.resource_id: row.cluster for row in rows} == {
            fresh.resource_id: fresh,
            newly_seen.resource_id: newly_seen,
        }
        assert all(row.missing_since is None for row in rows)
        adapter.verify.assert_not_awaited()
    finally:
        release_old_save.set()
        if manual is not None:
            await asyncio.gather(manual, return_exceptions=True)
        await discovery.close()


async def test_periodic_and_manual_checks_share_four_account_limit(cloud_db):
    store, _, _ = cloud_db
    periodic = await account(store)
    periodic_started = asyncio.Event()
    release_discoveries = asyncio.Event()
    active = set()
    started = set()
    peak = 0

    async def discover(config):
        nonlocal peak
        assert config.id not in active
        active.add(config.id)
        started.add(config.id)
        peak = max(peak, len(active))
        if config.id == periodic.id:
            periodic_started.set()
        try:
            await release_discoveries.wait()
            return DiscoveryResult([found(config.id)], [])
        finally:
            active.remove(config.id)

    discovery, _, _ = _discovery(cloud_db, discover)
    discovery.start()
    manual = []
    try:
        await asyncio.wait_for(periodic_started.wait(), timeout=5)
        # These accounts did not exist when the periodic scan took its account list.
        for number in range(4):
            owner = await store.create(
                "azure", "cli", f"scope-{number}", f"Account {number}", "principal", {}, None
            )
            manual.append(asyncio.create_task(discovery.check(owner.id)))
        await asyncio.wait(manual, timeout=0.5)
        release_discoveries.set()
        checked = await asyncio.wait_for(asyncio.gather(*manual), timeout=5)
        assert started == {periodic.id, *(owner.id for owner in checked)}
        assert peak <= 4
    finally:
        release_discoveries.set()
        await asyncio.gather(*manual, return_exceptions=True)
        await discovery.close()


async def test_partial_discovery_updates_seen_and_preserves_unseen_added_cluster(cloud_db):
    store, registry, _ = cloud_db
    owner = await account(store)
    seen, unseen = found("seen"), found("unseen")
    await store.save_discovery(owner.id, [seen, unseen], NOW)
    ids = {row.cluster.resource_id: row.id for row in await store.discovered(owner.id)}
    seen_id, unseen_id = ids[seen.resource_id], ids[unseen.resource_id]
    seen_info = await add(registry, owner, seen)
    unseen_info = await add(registry, owner, unseen)
    await store.set_state([seen_id], "added", seen_info.id)
    await store.set_state([unseen_id], "added", unseen_info.id)
    unseen_row = await store.discovered_one(unseen_id)

    updated = replace(seen, kubernetes_version="1.31", node_count=2)
    problem = "Couldn't list clusters in west: the login lacks permissions."

    async def discover(_config):
        return DiscoveryResult([updated], [problem])

    discovery, adapter, hub = _discovery(cloud_db, discover)
    try:
        checked = await discovery.check(owner.id)
    finally:
        await discovery.close()

    assert checked.checked_at is not None and checked.checked_at > NOW
    assert checked.problems == [problem]
    assert (await store.get(owner.id)).problems == [problem]
    seen_row = await store.discovered_one(seen_id)
    assert seen_row.cluster == updated
    assert seen_row.last_seen > NOW and seen_row.missing_since is None
    assert (await registry.get(seen_info.id)).kubernetes_version == "1.31"
    assert await store.discovered_one(unseen_id) == unseen_row
    assert await registry.get(unseen_info.id) == unseen_info
    adapter.verify.assert_not_awaited()
    hub.clusters_changed.assert_awaited_once()


async def test_failed_check_keeps_last_list_marked_with_time(cloud_db):
    store, _, _ = cloud_db
    owner = await account(store)
    [row_id] = (await store.save_discovery(owner.id, [found()], NOW)).new_ids
    previous = await store.discovered_one(row_id)
    message = "Azure had a problem while trying to list clusters (503). Try again in a minute."

    async def discover(_config):
        raise CloudError(message, status=503)

    discovery, _, hub = _discovery(cloud_db, discover)
    try:
        checked = await discovery.check(owner.id)
    finally:
        await discovery.close()

    assert checked.check_ok is False and checked.check_message == message
    assert checked.checked_at is not None and checked.checked_at > NOW
    assert await store.discovered_one(row_id) == previous
    hub.clusters_changed.assert_not_awaited()

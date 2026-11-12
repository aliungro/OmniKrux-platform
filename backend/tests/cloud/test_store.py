import base64
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import text

from omnikrux.cloud.store import AccountExists, CloudAccountStore
from omnikrux.cloud.types import (
    CloudClusterRef,
    DiscoveredCluster,
    NodePool,
    environment_from_tags,
)
from omnikrux.clusters.models import Environment, Provider
from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.security.secrets import SecretBox
from tests.clusters.test_kubeconfig import kc

NOW = datetime(2026, 1, 1, tzinfo=UTC)
LATER = NOW + timedelta(minutes=10)


@pytest_asyncio.fixture
async def cloud_db(tmp_settings):
    engine = make_engine(tmp_settings.db_url)
    await init_db(engine)
    sessions = make_sessionmaker(engine)
    box = SecretBox.from_settings(tmp_settings)
    try:
        yield CloudAccountStore(sessions, box), ClusterRegistry(sessions, box), engine
    finally:
        await engine.dispose()


async def account(store, provider="azure", *, secret=None):
    return await store.create(
        provider,
        "entered",
        "sample-scope",
        "Sample account",
        "sample-principal",
        {"region": "sample-region"},
        secret,
    )


def found(resource_id="sample-resource"):
    return DiscoveredCluster(
        resource_id,
        "prod",
        "sample-region",
        "1.30",
        (),
        0,
        {},
        False,
        None,
        {"resource_group": "synthetic"},
    )


async def add(registry, owner, cluster, ca_data=None):
    ref = CloudClusterRef(
        owner.id, owner.provider, cluster.resource_id, cluster.name, cluster.region, cluster.details
    )
    return await registry.upsert_cloud_cluster(
        ref,
        cluster,
        server="https://cluster.example.test",
        ca_data=ca_data,
        environment=Environment.PRODUCTION,
    )


async def test_secret_encrypted_at_rest_and_never_listed(cloud_db):
    store, _, engine = cloud_db
    secret = {"client_secret": "s3cr3t-azure"}
    created = await account(store, secret=secret)
    loaded = await store.get(created.id)
    config = await store.config(created.id)
    async with engine.connect() as conn:
        raw = (await conn.execute(text("SELECT * FROM cloud_accounts"))).one()
    assert created == loaded
    assert loaded.has_secret and loaded.settings == {"region": "sample-region"}
    assert config.secret == secret and config.settings == loaded.settings
    assert isinstance(raw.secret_encrypted, bytes)
    assert raw.secret_encrypted
    for surface in (raw, raw.settings, await store.list(), loaded, config):
        displayed = repr(surface)
        assert secret["client_secret"] not in displayed
        assert base64.b64encode(secret["client_secret"].encode()).decode() not in displayed


async def test_duplicate_account_raises_with_existing_name(cloud_db):
    store, _, _ = cloud_db
    first = await account(store)
    with pytest.raises(AccountExists) as caught:
        await store.create("azure", "cli", first.scope, "Duplicate", "principal", {}, None)
    assert caught.value.existing_name == first.name
    assert await store.list() == [first]


async def test_save_discovery_marks_new_updates_and_vanished(cloud_db):
    store, _, _ = cloud_db
    owner = await account(store)
    a, b = found("a"), found("b")
    result = await store.save_discovery(owner.id, [a, b], NOW)
    rows = {row.cluster.resource_id: row for row in await store.discovered(owner.id)}
    assert set(result.new_ids) == {rows["a"].id, rows["b"].id}
    assert all(row.state == "new" and row.first_seen == NOW for row in rows.values())
    await store.set_state([rows["a"].id], "dismissed")
    await store.record_check(
        owner.id, ok=False, message="Synthetic failure", problems=["issue"], at=NOW
    )
    checked = await store.get(owner.id)
    assert (checked.checked_at, checked.check_ok, checked.check_message, checked.problems) == (
        NOW,
        False,
        "Synthetic failure",
        ["issue"],
    )
    updated = replace(a, name="dev", tags={"env": "prod"})
    result = await store.save_discovery(owner.id, [updated], LATER)
    assert result.new_ids == result.vanished_cluster_ids == result.changed_cluster_ids == []
    row = await store.discovered_one(rows["a"].id)
    assert row.cluster == updated and row.state == "dismissed"
    assert row.environment == Environment.PRODUCTION
    assert (row.first_seen, row.last_seen, row.missing_since) == (NOW, LATER, None)
    await store.save_discovery(owner.id, [updated], LATER + timedelta(minutes=1))
    missing = await store.discovered_one(rows["b"].id)
    assert (missing.last_seen, missing.missing_since) == (NOW, LATER)
    result = await store.save_discovery(owner.id, [updated, b], LATER + timedelta(minutes=2))
    assert result.new_ids == []
    assert (await store.discovered_one(rows["b"].id)).missing_since is None


async def test_added_cluster_metadata_follows_discovery(cloud_db):
    store, registry, _ = cloud_db
    owner = await account(store)
    cluster = found()
    [discovery_id] = (await store.save_discovery(owner.id, [cluster], NOW)).new_ids
    info = await add(registry, owner, cluster)
    await store.set_state([discovery_id], "added", info.id)
    assert (await store.discovered_for_cluster(info.id)).id == discovery_id
    pool = NodePool("sample-pool", 3, "sample-machine", "1.31")
    updated = replace(
        cluster,
        kubernetes_version="1.31",
        region="updated-region",
        node_pools=(pool,),
        node_count=3,
        tags={"environment": "dev"},
    )
    result = await store.save_discovery(owner.id, [updated], LATER)
    assert result.changed_cluster_ids == [info.id]
    current = await registry.get(info.id)
    assert (current.kubernetes_version, current.region, current.node_pools, current.node_count) == (
        "1.31",
        "updated-region",
        (pool,),
        3,
    )
    assert current.environment == Environment.DEVELOPMENT
    partial = replace(updated, kubernetes_version="1.32", resource_id="another-resource")
    result = await store.save_discovery(owner.id, [partial], LATER, mark_missing=False)
    assert len(result.new_ids) == 1
    assert result.vanished_cluster_ids == result.changed_cluster_ids == []
    assert (await store.discovered_one(discovery_id)).missing_since is None
    assert await registry.get(info.id) == current
    assert (await store.save_discovery(owner.id, [updated], LATER)).changed_cluster_ids == []
    result = await store.save_discovery(owner.id, [], LATER)
    assert result.vanished_cluster_ids == result.changed_cluster_ids == [info.id]
    assert (await registry.get(info.id)).cloud_missing_since == LATER
    result = await store.save_discovery(owner.id, [], LATER + timedelta(minutes=1))
    assert result.vanished_cluster_ids == result.changed_cluster_ids == []
    result = await store.save_discovery(owner.id, [updated], LATER + timedelta(minutes=2))
    assert result.changed_cluster_ids == [info.id]
    assert (await registry.get(info.id)).cloud_missing_since is None


async def test_delete_account_removes_its_clusters_only(cloud_db):
    store, registry, _ = cloud_db
    azure = await account(store, secret={"sample": "synthetic"})
    aws = await account(store, "aws")
    [local] = await registry.upsert_from_kubeconfig(
        kc([("local", "https://cluster.example.test", None)]), rewrite_loopback=False, source="file"
    )
    a, b = found("azure-resource"), found("aws-resource")
    await store.save_discovery(azure.id, [a], NOW)
    await store.save_discovery(aws.id, [b], NOW)
    first = await add(registry, azure, a)
    second = await add(registry, aws, b)
    assert await store.delete(azure.id) == [first.id]
    with pytest.raises(KeyError):
        await store.config(azure.id)
    assert [row.account_id for row in await store.discovered()] == [aws.id]
    assert {row.id for row in await registry.list()} == {local.id, second.id}


@pytest.mark.parametrize(
    ("tags", "name", "provider", "expected"),
    [
        ({"EnViRoNmEnT": "LIVE"}, "dev", Provider.AKS, Environment.PRODUCTION),
        ({"ENV": "STAGING"}, "prod", Provider.EKS, Environment.DEVELOPMENT),
        ({"env": "invalid", "Environment": "qa"}, "prod", Provider.GKE, Environment.DEVELOPMENT),
        ({"other": "prod"}, "local", Provider.OKE, Environment.DEVELOPMENT),
        ({"environment": "invalid"}, "prd", Provider.EKS, Environment.PRODUCTION),
        ({}, "cluster", Provider.AKS, Environment.UNKNOWN),
    ],
)
def test_environment_from_tags(tags, name, provider, expected):
    assert environment_from_tags(tags, name, provider) == expected

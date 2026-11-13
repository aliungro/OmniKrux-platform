import asyncio
import json
import logging
from dataclasses import fields, replace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import BaseModel, field_validator
from sqlalchemy import select

from omnikrux import main
from omnikrux.audit.models import AuditRecord
from omnikrux.audit.store import AuditUnavailable
from omnikrux.cloud import adapters
from omnikrux.cloud.adapters import AccountIdentity, CliLoginInfo, ClusterAccess, DiscoveryResult
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.http import CloudError
from omnikrux.cloud.messages import (
    AKS_LOCAL_ACCOUNTS,
    CLOUD_CLUSTER_ENDPOINT_INVALID,
    DISCOVERY_CHANGED,
    PRIVATE,
    WORKLOAD,
    missing_from_cloud,
)
from omnikrux.cloud.types import KUBE_PROVIDER, NodePool
from tests.cloud.test_store import NOW, found

SUBSCRIPTION = "11111111-1111-1111-1111-111111111111"
TENANT = "22222222-2222-2222-2222-222222222222"
CLIENT = "33333333-3333-3333-3333-333333333333"
ACCOUNT_SECRET = "sentinel-entered-azure-client-secret"
PRIVATE_HOST = "sentinel-private-endpoint.example.test"
PRIVATE_SERVER = f"https://{PRIVATE_HOST}"
ENTERED_AZURE = {
    "provider": "azure",
    "source": "entered",
    "subscription_id": SUBSCRIPTION,
    "tenant_id": TENANT,
    "client_id": CLIENT,
    "client_secret": ACCOUNT_SECRET,
}


class _ValidationProbe(BaseModel):
    credential: str

    @field_validator("credential")
    @classmethod
    def reject_credential(cls, value: str) -> str:
        raise ValueError(f"Synthetic validator rejected {value}")


async def _validation_probe(body: _ValidationProbe) -> None:
    raise AssertionError("The probe body should always fail validation.")


@pytest.fixture
async def cloud_http(tmp_settings, monkeypatch, request):
    fakes = {
        provider: Mock(
            provider=provider,
            verify=AsyncMock(return_value=AccountIdentity(SUBSCRIPTION, "Test account", "user")),
            discover=AsyncMock(return_value=DiscoveryResult([], [])),
            access=AsyncMock(return_value=ClusterAccess(PRIVATE_SERVER, None)),
            cli_login=AsyncMock(
                return_value=CliLoginInfo(provider, "/test/login", "missing", None, [])
            ),
            forget=Mock(),
        )
        for provider in KUBE_PROVIDER
    }
    make_adapters = Mock(return_value=fakes)
    monkeypatch.setattr(adapters, "make_adapters", make_adapters)
    monkeypatch.setattr(main, "make_adapters", make_adapters, raising=False)
    # Even if the adapter factory wiring changes, test requests can't reach a real provider.
    endpoints = {field.name: "http://127.0.0.1:1" for field in fields(CloudEndpoints)}
    settings = tmp_settings.model_copy(
        update={"cloud_endpoints": json.dumps(endpoints), **getattr(request, "param", {})}
    )
    app = main.create_app(settings)
    app.add_api_route("/api/validation-probe", _validation_probe, methods=["POST"])
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield client, app.state, fakes


async def _audit_rows(state):
    async with state.sessionmaker() as session:
        return list((await session.execute(select(AuditRecord.__table__))).mappings())


async def _seed_clusters(state, *clusters):
    store = state.cloud.store
    owner = await store.create("azure", "cli", SUBSCRIPTION, "Test account", "user", {}, None)
    ids = (await store.save_discovery(owner.id, list(clusters), NOW)).new_ids
    return owner, ids


def _assert_safe_validation(response, *canaries):
    assert response.status_code == 422, response.text
    for canary in canaries:
        assert canary not in response.text
    errors = response.json()["detail"]
    assert errors and isinstance(errors, list)
    assert all(set(error) == {"loc", "msg", "type"} for error in errors)


@pytest.mark.parametrize(
    ("changes", "removed", "canary"),
    [
        ({}, "tenant_id", ACCOUNT_SECRET),
        ({"provider": "sentinel-unknown-provider-tag"}, None, "sentinel-unknown-provider-tag"),
        ({"source": "sentinel-unknown-source-tag"}, None, "sentinel-unknown-source-tag"),
        (
            {"sentinel-extra-field-name": "sentinel-extra-field-value"},
            None,
            "sentinel-extra-field-name",
        ),
    ],
    ids=["missing-required", "unknown-provider", "unknown-source", "unknown-field"],
)
async def test_invalid_account_body_never_echoes_secrets(
    cloud_http, caplog, changes, removed, canary
):
    client, state, fakes = cloud_http
    caplog.set_level(logging.DEBUG)
    body = ENTERED_AZURE | changes
    if removed is not None:
        del body[removed]
    response = await client.post("/api/cloud/accounts", json=body)

    markers = (ACCOUNT_SECRET, canary, "sentinel-extra-field-value")
    _assert_safe_validation(response, *markers)
    for marker in markers:
        assert marker not in caplog.text
    assert await _audit_rows(state) == []
    assert await state.cloud.store.list() == []
    for fake in fakes.values():
        fake.verify.assert_not_awaited()
        fake.discover.assert_not_awaited()


async def test_validation_error_does_not_copy_arbitrary_validator_text(cloud_http, caplog):
    client, state, _ = cloud_http
    caplog.set_level(logging.DEBUG)
    canary = "sentinel-credential-in-arbitrary-validator-text"
    response = await client.post("/api/validation-probe", json={"credential": canary})

    _assert_safe_validation(response, canary)
    assert canary not in caplog.text
    assert await _audit_rows(state) == []


async def test_workload_source_422(cloud_http):
    client, state, fakes = cloud_http
    response = await client.post(
        "/api/cloud/accounts", json={"provider": "azure", "source": "workload"}
    )

    assert response.status_code == 422, response.text
    assert response.json() == {"detail": WORKLOAD}
    assert await _audit_rows(state) == []
    fakes["azure"].verify.assert_not_awaited()


@pytest.mark.parametrize(
    "body",
    [
        {"provider": "gcp", "source": "cli", "project_id": "../x"},
        {"provider": "aws", "source": "cli", "profile": "default", "regions": ["eu-west-1/../"]},
        {"provider": "oci", "source": "cli", "profile": "../bad"},
        {"provider": "azure", "source": "cli", "subscription_id": SUBSCRIPTION + "\n"},
    ],
)
async def test_invalid_ids_rejected_before_any_request(cloud_http, body):
    client, state, fakes = cloud_http
    response = await client.post("/api/cloud/accounts", json=body)
    _assert_safe_validation(response)
    fakes[body["provider"]].verify.assert_not_awaited()
    assert await _audit_rows(state) == []


async def test_connect_refused_login_422_plain(cloud_http):
    client, state, fakes = cloud_http
    message = "Azure refused access. Check the login's permissions, then try again."
    fakes["azure"].verify.side_effect = CloudError(message, status=403)
    response = await client.post("/api/cloud/accounts", json=ENTERED_AZURE)
    assert response.status_code == 422 and response.json() == {"detail": message}
    assert await _audit_rows(state) == []
    assert await state.cloud.store.list() == []


async def test_duplicate_account_409_plain(cloud_http):
    client, state, _ = cloud_http
    assert (await client.post("/api/cloud/accounts", json=ENTERED_AZURE)).status_code == 201
    response = await client.post("/api/cloud/accounts", json=ENTERED_AZURE)
    assert response.status_code == 409
    assert response.json() == {
        "detail": "This Azure subscription is already connected as Test account."
    }
    assert len(await state.cloud.store.list()) == 1
    assert {row["outcome"] for row in await _audit_rows(state)} == {"succeeded", "failed"}


async def test_connect_refuses_to_write_without_audit(cloud_http, monkeypatch):
    client, state, fakes = cloud_http
    monkeypatch.setattr(state.audit, "begin", AsyncMock(side_effect=AuditUnavailable("offline")))
    response = await client.post("/api/cloud/accounts", json=ENTERED_AZURE)
    assert response.status_code == 503
    assert response.json() == {
        "detail": "Nothing was changed: the audit log can't be written (offline)."
    }
    assert await state.cloud.store.list() == []
    fakes["azure"].discover.assert_not_awaited()


@pytest.mark.parametrize(
    "cloud_http", [{}, {"secret_key": Fernet.generate_key().decode()}], indirect=True
)
async def test_settings_and_logins_carry_no_secrets(cloud_http):
    client, state, fakes = cloud_http
    settings = await client.get("/api/settings")
    assert settings.status_code == 200
    assert settings.json()["discovery_interval_s"] == state.settings.cloud_discovery_seconds
    if state.settings.secret_key:
        assert settings.json()["encryption"] == {"source": "environment", "path": None}
        assert state.settings.secret_key not in settings.text
    else:
        key_file = state.settings.data_dir / "secret.key"
        assert settings.json()["encryption"] == {"source": "file", "path": str(key_file)}
        assert key_file.read_text() not in settings.text
    logins = await client.get("/api/cloud/logins")
    assert logins.status_code == 200
    assert {login["provider"] for login in logins.json()} == set(fakes)
    assert all(login["state"] == "missing" and login["note"] is None for login in logins.json())
    for adapter in fakes.values():
        adapter.cli_login.assert_awaited_once()


async def test_account_secret_never_echoed_or_logged(cloud_http, caplog):
    client, state, fakes = cloud_http
    caplog.set_level(logging.DEBUG)
    first_check = asyncio.Event()
    azure = fakes["azure"]

    async def discover(_config):
        first_check.set()
        return DiscoveryResult([], [])

    azure.discover.side_effect = discover
    connected = await client.post("/api/cloud/accounts", json=ENTERED_AZURE)
    assert connected.status_code == 201, connected.text
    owner_id = connected.json()["id"]
    assert connected.json()["has_secret"] is True
    await asyncio.wait_for(first_check.wait(), timeout=5)
    manual = await client.post(f"/api/cloud/accounts/{owner_id}/check")
    assert manual.status_code == 200, manual.text
    assert manual.json()["check"]["state"] == "ok"
    azure.verify.assert_awaited_once()
    assert azure.verify.call_args.args[0].secret == {"client_secret": ACCOUNT_SECRET}

    responses = [connected, manual]
    for path in (
        "/api/cloud/accounts",
        "/api/cloud/logins",
        "/api/cloud/discovered",
        "/api/settings",
    ):
        response = await client.get(path)
        assert response.status_code == 200, response.text
        responses.append(response)
    removed = await client.delete(f"/api/cloud/accounts/{owner_id}")
    assert removed.status_code == 204, removed.text
    responses.append(removed)

    assert all(ACCOUNT_SECRET not in response.text for response in responses)
    assert all("client_secret" not in response.text for response in responses)
    audit = await _audit_rows(state)
    assert {row["action"] for row in audit} == {"cloud_account_add", "cloud_account_remove"}
    for row in audit:
        assert row["kind"] == "cloud-account" and row["provider"] == "aks"
        assert row["cluster_id"] == "" and row["outcome"] == "succeeded"
        assert all(ACCOUNT_SECRET not in str(value) for value in row.values())
    assert ACCOUNT_SECRET not in caplog.text


async def test_add_uses_only_the_ticked_ids_and_dismiss_keeps_existing_link(
    cloud_http, monkeypatch
):
    client, state, fakes = cloud_http
    ticked, unticked = found("one"), found("two")
    owner, [selected, other] = await _seed_clusters(state, ticked, unticked)
    changed = AsyncMock()
    monkeypatch.setattr(state.hub, "clusters_changed", changed)
    response = await client.post("/api/cloud/discovered/add", json={"ids": [selected, selected]})
    assert response.status_code == 200 and response.json()["failed"] == []
    [added] = response.json()["added"]
    assert added["cloud"]["resource_id"] == ticked.resource_id
    fakes["azure"].access.assert_awaited_once()
    assert fakes["azure"].access.call_args.args[1] == ticked
    changed.assert_awaited_once()
    assert (await state.cloud.store.discovered_one(other)).state == "new"

    dismissed = await client.post("/api/cloud/discovered/dismiss", json={"ids": [selected, other]})
    assert dismissed.status_code == 204
    rows = {row.id: row for row in await state.cloud.store.discovered(owner.id)}
    assert (rows[selected].state, rows[selected].cluster_id) == ("added", added["id"])
    assert rows[other].state == "dismissed"
    accounts = await client.get("/api/cloud/accounts")
    assert accounts.json()[0]["counts"] == {"found": 2, "added": 1, "new": 0}


@pytest.mark.parametrize("action", ["add", "dismiss"])
async def test_bulk_discovery_rejects_malformed_ids_without_echo(cloud_http, action, caplog):
    client, state, _ = cloud_http
    marker = "sentinel-secret-in-discovered-id"
    response = await client.post(f"/api/cloud/discovered/{action}", json={"ids": [marker]})
    _assert_safe_validation(response, marker)
    assert marker not in caplog.text
    assert await _audit_rows(state) == []


async def test_add_reports_unknown_well_formed_discovery_id(cloud_http):
    client, _, _ = cloud_http
    unknown = "0" * 32
    response = await client.post("/api/cloud/discovered/add", json={"ids": [unknown]})
    assert response.status_code == 200
    assert response.json()["failed"][0]["id"] == unknown


@pytest.mark.parametrize("existing_link", [False, True], ids=["dismiss-wins", "delete-wins"])
async def test_stale_add_cannot_override_a_concurrent_dismiss_or_delete(cloud_http, existing_link):
    client, state, fakes = cloud_http
    _, [row_id] = await _seed_clusters(state, found())
    path = "/api/cloud/discovered/add"
    payload = {"ids": [row_id]}
    if existing_link:
        initial = await client.post(path, json=payload)
        [registered] = initial.json()["added"]
    access_started = asyncio.Event()
    release = asyncio.Event()

    async def pause_access(*_args):
        access_started.set()
        await release.wait()
        return ClusterAccess(PRIVATE_SERVER, None)

    fakes["azure"].access.side_effect = pause_access
    pending = asyncio.create_task(client.post(path, json=payload))
    try:
        await asyncio.wait_for(access_started.wait(), timeout=5)
        if existing_link:
            removal = await client.delete(f"/api/clusters/{registered['id']}")
        else:
            removal = await client.post("/api/cloud/discovered/dismiss", json=payload)
        assert removal.status_code == 204
    finally:
        release.set()
        result = await asyncio.wait_for(pending, timeout=5)

    assert result.json() == {"added": [], "failed": [{"id": row_id, "message": DISCOVERY_CHANGED}]}
    assert await state.registry.list() == []
    row = await state.cloud.store.discovered_one(row_id)
    assert row.state == "dismissed" and row.cluster_id is None
    assert any(audit["outcome"] == "failed" for audit in await _audit_rows(state))

    # A new, explicit add request can register the already dismissed row.
    [added] = (await client.post(path, json=payload)).json()["added"]
    assert (await state.cloud.store.discovered_one(row_id)).cluster_id == added["id"]


async def test_cluster_delete_during_add_clears_discovery_link(cloud_http, monkeypatch):
    client, state, _ = cloud_http
    _, [row_id] = await _seed_clusters(state, found())
    persisted = asyncio.Event()
    resume_add = asyncio.Event()
    upsert = state.registry.upsert_cloud_cluster

    async def pause_after_commit(*args, **kwargs):
        cluster = await upsert(*args, **kwargs)
        persisted.set()
        await resume_add.wait()
        return cluster

    monkeypatch.setattr(state.registry, "upsert_cloud_cluster", pause_after_commit)
    adding = asyncio.create_task(client.post("/api/cloud/discovered/add", json={"ids": [row_id]}))
    try:
        await asyncio.wait_for(persisted.wait(), timeout=5)
        [cluster] = await state.registry.list()
        assert (await state.cloud.store.discovered_one(row_id)).cluster_id == cluster.id
        deleted = await asyncio.wait_for(client.delete(f"/api/clusters/{cluster.id}"), timeout=5)
        assert deleted.status_code == 204
    finally:
        resume_add.set()
        await asyncio.wait_for(adding, timeout=5)
    row = await state.cloud.store.discovered_one(row_id)
    assert row.state == "dismissed" and row.cluster_id is None
    assert await state.registry.list() == []


async def test_add_refuses_private_and_local_accounts(cloud_http):
    client, state, fakes = cloud_http
    private = replace(found("private"), private=True)
    local = replace(found("local"), why_not=AKS_LOCAL_ACCOUNTS)
    _, ids = await _seed_clusters(state, private, local)
    response = await client.post("/api/cloud/discovered/add", json={"ids": ids})
    assert response.json() == {
        "added": [],
        "failed": [
            {"id": ids[0], "message": PRIVATE},
            {"id": ids[1], "message": AKS_LOCAL_ACCOUNTS},
        ],
    }
    fakes["azure"].access.assert_not_awaited()
    assert await _audit_rows(state) == []
    [account] = (await client.get("/api/cloud/accounts")).json()
    assert account["counts"] == {"found": 2, "added": 0, "new": 0}
    discovered = await client.get("/api/cloud/discovered")
    assert {item["why_not"] for item in discovered.json()} == {PRIVATE, AKS_LOCAL_ACCOUNTS}


@pytest.mark.parametrize(
    "url",
    [
        "http://unconfigured.example.test",
        "https://secret-user:secret-password@cluster.example.test",
        "https://cluster.example.test?token=secret-token",
        "https://cluster.example.test/#secret-fragment",
    ],
)
async def test_add_rejects_unsafe_endpoint_before_persisting(cloud_http, url):
    client, state, fakes = cloud_http
    _, [row_id] = await _seed_clusters(state, found())
    fakes["azure"].access.return_value = ClusterAccess(url, None)
    response = await client.post("/api/cloud/discovered/add", json={"ids": [row_id]})
    assert response.json() == {
        "added": [],
        "failed": [{"id": row_id, "message": CLOUD_CLUSTER_ENDPOINT_INVALID}],
    }
    assert await state.registry.list() == []
    assert (await state.cloud.store.discovered_one(row_id)).state == "new"
    [audit] = await _audit_rows(state)
    assert audit["outcome"] == "failed" and audit["message"] == CLOUD_CLUSTER_ENDPOINT_INVALID
    assert url not in str(audit)


async def test_remove_account_removes_its_clusters_and_forgets_watches(cloud_http, monkeypatch):
    client, state, _ = cloud_http
    owner, [row_id] = await _seed_clusters(state, found())
    response = await client.post("/api/cloud/discovered/add", json={"ids": [row_id]})
    [cluster] = response.json()["added"]
    broker = state.cloud.broker
    forget = Mock(wraps=broker.forget)
    forget_account = Mock(wraps=broker.forget_account)
    watch_forget = AsyncMock(wraps=state.hub.forget)
    monkeypatch.setattr(broker, "forget", forget)
    monkeypatch.setattr(broker, "forget_account", forget_account)
    monkeypatch.setattr(state.hub, "forget", watch_forget)

    response = await client.delete(f"/api/cloud/accounts/{owner.id}")
    assert response.status_code == 204
    assert await state.registry.list() == []
    assert await state.cloud.store.discovered() == []
    watch_forget.assert_awaited_once_with(cluster["id"])
    forget.assert_called_once_with(cluster["id"])
    forget_account.assert_called_once_with(owner.id)


async def test_cluster_out_has_source_version_pools_and_note(cloud_http):
    client, state, fakes = cloud_http
    pool = NodePool("workers", 2, "machine", "v1.31.1")
    cluster = replace(found(), kubernetes_version="v1.31.1", node_pools=(pool,), node_count=2)
    owner, [row_id] = await _seed_clusters(state, cluster)
    response = await client.post("/api/cloud/discovered/add", json={"ids": [row_id]})
    [added] = response.json()["added"]
    assert added["cloud_note"] is None
    assert added["cloud"] == {
        "account_id": owner.id,
        "account_name": owner.name,
        "resource_id": cluster.resource_id,
    }
    assert added["source"] == "cloud" and added["kubernetes_version"] == "v1.31.1"
    assert added["node_count"] == 2
    assert added["node_pools"] == [
        {"name": "workers", "count": 2, "machine_type": "machine", "version": "v1.31.1"}
    ]

    fakes["azure"].discover.return_value = DiscoveryResult([], [])
    checked = await client.post(f"/api/cloud/accounts/{owner.id}/check")
    assert checked.json()["counts"] == {"found": 0, "added": 1, "new": 0}
    [missing] = (await client.get("/api/clusters")).json()
    assert missing["id"] == added["id"]
    assert missing["cloud_note"] == missing_from_cloud(owner.name)
    assert (await state.cloud.store.discovered_one(row_id)).missing_since is not None


async def test_account_removed_during_add_finishes_failed_audit_and_keeps_other_item(
    cloud_http, caplog, monkeypatch
):
    client, state, fakes = cloud_http
    store = state.cloud.store
    registry = state.registry
    caplog.set_level(logging.DEBUG, logger="omnikrux")
    details_secret = "sentinel-internal-provider-details"
    stale = replace(found("stale"), name="stale cluster", details={"internal": details_secret})
    live = replace(found("live"), name="live cluster")
    doomed = await store.create("azure", "cli", "doomed", "Doomed account", "user", {}, None)
    remaining = await store.create("azure", "cli", "live", "Live account", "user", {}, None)
    [stale_id] = (await store.save_discovery(doomed.id, [stale], NOW)).new_ids
    [live_id] = (await store.save_discovery(remaining.id, [live], NOW)).new_ids
    discovered = await client.get("/api/cloud/discovered")
    assert discovered.status_code == 200, discovered.text
    assert {row["id"] for row in discovered.json()} == {stale_id, live_id}
    assert all("details" not in row for row in discovered.json())
    assert details_secret not in discovered.text

    before_stale_upsert = asyncio.Event()
    release_stale_upsert = asyncio.Event()
    stale_owner_rejected = asyncio.Event()
    upsert = registry.upsert_cloud_cluster

    async def gated_upsert(ref, *args, **kwargs):
        if ref.account_id == doomed.id:
            before_stale_upsert.set()
            await release_stale_upsert.wait()
        try:
            return await upsert(ref, *args, **kwargs)
        except KeyError as exc:
            assert ref.account_id == doomed.id and exc.args == (doomed.id,)
            stale_owner_rejected.set()
            raise

    monkeypatch.setattr(registry, "upsert_cloud_cluster", gated_upsert)
    adding = asyncio.create_task(
        client.post("/api/cloud/discovered/add", json={"ids": [stale_id, live_id]})
    )
    try:
        await asyncio.wait_for(before_stale_upsert.wait(), timeout=5)
        audits = await _audit_rows(state)
        [started] = [
            row for row in audits if row["action"] == "cluster_add" and row["name"] == stale.name
        ]
        assert started["outcome"] == "started"
        deleted = await asyncio.wait_for(
            client.delete(f"/api/cloud/accounts/{doomed.id}"), timeout=5
        )
        assert deleted.status_code == 204, deleted.text
    finally:
        release_stale_upsert.set()
        await asyncio.wait({adding}, timeout=5)
        if not adding.done():
            adding.cancel()
        await asyncio.gather(adding, return_exceptions=True)

    response = adding.result()
    assert response.status_code == 200, response.text
    assert stale_owner_rejected.is_set()
    body = response.json()
    [failed] = body["failed"]
    assert failed["id"] == stale_id and failed["message"]
    [added] = body["added"]
    assert added["name"] == live.name
    assert added["source"] == "cloud"
    assert added["server"] is None and added["original_server"] is None
    assert [info.id for info in await registry.list()] == [added["id"]]
    assert (await registry.get(added["id"])).server == PRIVATE_SERVER
    assert await store.discovered(doomed.id) == []
    assert (await store.discovered_one(live_id)).cluster_id == added["id"]
    assert [owner.id for owner in await store.list()] == [remaining.id]
    assert fakes["azure"].access.await_count == 2

    [failed_audit] = [row for row in await _audit_rows(state) if row["id"] == started["id"]]
    assert failed_audit["outcome"] == "failed" and failed_audit["finished_at"] is not None
    assert failed_audit["kind"] == "clusters" and failed_audit["provider"] == "aks"
    assert failed_audit["cluster_name"] == stale.name
    for marker in (doomed.id, "KeyError", PRIVATE_HOST, details_secret):
        assert marker not in response.text
        assert all(marker not in str(value) for value in failed_audit.values())
    for marker in ("KeyError", PRIVATE_HOST, details_secret):
        assert marker not in caplog.text


async def test_failed_access_releases_credentials_recreated_after_account_removal(cloud_http):
    client, state, fakes = cloud_http
    owner, [row_id] = await _seed_clusters(state, found())
    azure = fakes["azure"]
    cached = set()
    azure.forget.side_effect = cached.discard
    access_started = asyncio.Event()
    release = asyncio.Event()

    async def late_access(config, _found):
        access_started.set()
        await release.wait()
        cached.add(config.id)
        raise CloudError("The login was refused. Check the permissions.")

    azure.access.side_effect = late_access
    adding = asyncio.create_task(client.post("/api/cloud/discovered/add", json={"ids": [row_id]}))
    try:
        await asyncio.wait_for(access_started.wait(), timeout=5)
        assert (await client.delete(f"/api/cloud/accounts/{owner.id}")).status_code == 204
    finally:
        release.set()
        result = await asyncio.wait_for(adding, timeout=5)
    assert result.status_code == 200 and result.json()["added"] == []
    assert not cached
    assert [row["action"] for row in await _audit_rows(state)] == ["cloud_account_remove"]

"""GET /api/audit: the newest records first, filtered and paged."""

import httpx
import pytest

from omnikrux.audit.store import AuditEntry
from omnikrux.config import Settings
from omnikrux.main import create_app


@pytest.fixture
async def http(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield client, app.state.audit


def entry(**overrides) -> AuditEntry:
    values = {
        "actor": "local",
        "action": "scale",
        "cluster_id": "c1",
        "namespace": "demo",
        "kind": "deployments.apps",
        "name": "web",
    }
    return AuditEntry(**(values | overrides))


async def test_audit_route_lists_filters_and_pages(http):
    client, audit = http
    first = await audit.begin(entry(details={"summary": ["Scale from 1 to 2 replicas."]}))
    await audit.finish(first, "succeeded", "Scaled.")
    second = await audit.begin(entry(action="shell", kind="pods", name="web-1", cluster_id="c2"))
    third = await audit.begin(entry(action="shell", kind="pods", name="api-1"))

    r = await client.get("/api/audit")
    assert r.status_code == 200
    body = r.json()
    assert [rec["id"] for rec in body["records"]] == [third, second, first]
    assert body["next_before"] is None
    oldest = body["records"][-1]
    assert set(oldest) == {
        "id",
        "started_at",
        "finished_at",
        "actor",
        "action",
        "cluster_id",
        "cluster_name",
        "provider",
        "namespace",
        "kind",
        "name",
        "outcome",
        "message",
        "diff",
        "details",
    }
    assert oldest["outcome"] == "succeeded" and oldest["cluster_name"] == "c1"
    assert oldest["details"] == {"summary": ["Scale from 1 to 2 replicas."]}
    assert oldest["started_at"].endswith(("Z", "+00:00"))  # ISO, in UTC

    r = await client.get("/api/audit", params={"cluster": "c1", "action": "shell"})
    assert [rec["id"] for rec in r.json()["records"]] == [third]
    r = await client.get("/api/audit", params={"q": "web"})
    assert [rec["id"] for rec in r.json()["records"]] == [second, first]
    r = await client.get("/api/audit", params={"limit": 2})
    assert [rec["id"] for rec in r.json()["records"]] == [third, second]
    assert r.json()["next_before"] == second
    r = await client.get("/api/audit", params={"limit": 2, "before": second})
    assert [rec["id"] for rec in r.json()["records"]] == [first]


@pytest.mark.parametrize("limit", [0, 501])
async def test_audit_route_limit_bounds(http, limit):
    client, _ = http
    r = await client.get("/api/audit", params={"limit": limit})
    assert r.status_code == 422


async def test_failed_audit_outcome_filters_before_pagination(http):
    client, audit = http

    async def add(outcome, **fields):
        record_id = await audit.begin(entry(**fields))
        await audit.finish(record_id, outcome)
        return record_id

    oldest = await add("failed", name="needle-oldest")
    await audit.begin(entry(name="needle-started"))
    middle = await add("failed", cluster_id="c2", name="needle-other-cluster")
    await add("unknown", name="needle-unknown")
    newest = await add("failed", name="needle-newest")
    await add("failed", action="restart", name="needle-other-action")
    await add("failed", name="other-name")
    succeeded = await add("succeeded", name="needle")
    ended = await add("ended", name="needle")

    async def page(params, expected, cursor):
        response = await client.get("/api/audit", params=params)
        assert response.status_code == 200
        body = response.json()
        assert [record["id"] for record in body["records"]] == expected
        assert body["next_before"] == cursor

    await page({"limit": 2}, [ended, succeeded], succeeded)
    failed = {"outcome": "failed", "q": "needle", "action": "scale", "limit": 2}
    await page(failed, [newest, middle], middle)
    await page(failed | {"before": middle}, [oldest], None)
    await page(failed | {"cluster": "c1"}, [newest, oldest], None)
    for unsupported in ("succeeded", "Failed", ""):
        response = await client.get("/api/audit", params={"outcome": unsupported})
        assert response.status_code == 422

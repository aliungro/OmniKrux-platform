import pytest
from aiohttp import web
from sqlalchemy import text

from tests.actions.clusters import apply, plan, records
from tests.actions.test_delete import pod
from tests.fakekube import status_body

KEY = ("demo", "evict-me")
CONFIRM = {"confirm_text": KEY[1]}


async def prepare(env):
    fake = env.fakes["dev-a"]
    fake.pods[KEY] = pod(KEY[1], owner=("ReplicaSet", "evict-demo"))
    response = await plan(env, "evict", kind_key="pods", name=KEY[1])
    assert response.status_code == 200, response.text
    return fake, response.json()


async def test_evict_reads_then_audits_and_posts_the_reviewed_uid(env):
    fake, review = await prepare(env)
    assert review["confirm_text"] == KEY[1]
    assert "PodDisruptionBudget" in " ".join(review["summary"])
    assert "replacement" in " ".join(review["summary"])
    assert not fake.eviction_requests and not await records(env)
    assert (await apply(env, review["plan_id"])).status_code == 422
    assert not fake.eviction_requests

    result = await apply(env, review["plan_id"], CONFIRM)
    assert result.status_code == 200, result.text
    assert fake.eviction_requests == [
        {
            "pod": KEY,
            "body": {
                "apiVersion": "policy/v1",
                "kind": "Eviction",
                "metadata": {"name": KEY[1], "namespace": KEY[0]},
                "deleteOptions": {"preconditions": {"uid": "u-evict-me"}},
            },
        }
    ]
    [audit] = await records(env)
    assert (audit.action, audit.name, audit.outcome) == ("evict", KEY[1], "succeeded")


async def test_evict_rejects_non_pod_target(env):
    response = await plan(env, "evict")
    assert response.status_code == 422 and "deployments.apps" in response.json()["detail"]


async def test_evict_never_posts_if_audit_cannot_start(env):
    fake, review = await prepare(env)
    async with env.app.state.engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))
    response = await apply(env, review["plan_id"], CONFIRM)
    assert response.status_code == 503 and not fake.eviction_requests
    assert KEY in fake.pods


@pytest.mark.parametrize(
    ("status", "detail"), [(403, "not allowed"), (404, "evict"), (429, "disruption budget")]
)
async def test_refused_eviction_leaves_the_pod_in_place(env, status, detail):
    fake, review = await prepare(env)
    fake.evictions[KEY] = [status]
    response = await apply(env, review["plan_id"], CONFIRM)
    assert response.status_code == status, response.text
    assert detail in response.json()["detail"].lower()
    assert KEY in fake.pods
    assert len(fake.eviction_requests) == 1
    assert not any(method == "DELETE" for method, _, _ in fake.requests)
    [audit] = await records(env)
    assert audit.outcome == "failed"


async def test_generic_throttle_is_not_reported_as_a_budget(env, monkeypatch):
    fake, review = await prepare(env)

    async def throttle(request, key):
        return web.json_response(
            status_body(429, "TooManyRequests", "Too many requests"), status=429
        )

    monkeypatch.setattr(fake, "_evict", throttle)
    response = await apply(env, review["plan_id"], CONFIRM)
    assert response.status_code == 429, response.text
    assert "Too many requests" in response.json()["detail"]
    assert "budget" not in response.json()["detail"].lower()
    assert KEY in fake.pods


async def test_evict_does_not_touch_a_same_name_replacement(env):
    fake, review = await prepare(env)
    fake.pods[KEY] = pod(KEY[1], uid="new-uid")
    response = await apply(env, review["plan_id"], CONFIRM)
    assert response.status_code == 409, response.text
    assert fake.pods[KEY]["metadata"]["uid"] == "new-uid"
    assert not any(method == "DELETE" for method, _, _ in fake.requests)


async def test_evict_plan_refuses_a_replacement_of_the_chosen_row(env):
    """The row's uid is pinned when the review is made, like bulk delete's (Plan 3 R28)."""
    fake = env.fakes["dev-a"]
    fake.pods[KEY] = pod(KEY[1], uid="new-uid")
    rejected = await plan(
        env, "evict", kind_key="pods", name=KEY[1], params={"expected_uid": "old-uid"}
    )
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"] == (
        "Pod demo/evict-me was replaced. Select it again to evict it."
    )
    reviewed = await plan(
        env, "evict", kind_key="pods", name=KEY[1], params={"expected_uid": "new-uid"}
    )
    assert reviewed.status_code == 200, reviewed.text

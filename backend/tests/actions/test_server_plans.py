"""Plans the server builds itself (`make_plan`): the same answers as the browser's
`POST /api/actions/plan`, applied through the same apply route (audit first), with handlers the
browser can never ask for."""

import copy

import pytest

from omnikrux.actions.pipeline import (
    ACTIONS,
    MAX_OPEN_DELETE_PLANS,
    OPEN_DELETES_LIMIT,
    Applied,
    Planned,
    Target,
    make_plan,
)
from omnikrux.audit.store import LOCAL_ACTOR
from omnikrux.kube.http import call_json
from tests.actions.clusters import apply, plan, records, target


async def get_object(api, spec, target) -> dict:
    return await call_json(api, "GET", spec.object_path(target.namespace, target.name), timeout=5)


# What differs between two plans of the same change.
FRESH = ("plan_id", "expires_at")


class Handler:
    """Reads the live object to plan (with the params it was given); applies by reading it again
    through the context's client."""

    def __init__(self, kinds=frozenset({"deployments.apps"})):
        self.kinds = kinds
        self.plans: list[dict] = []
        self.applies: list[tuple] = []

    async def plan(self, api, spec, target, params, *, cluster):
        live = await get_object(api, spec, target)
        after = copy.deepcopy(live)
        after.setdefault("spec", {})["replicas"] = params.get("replicas", 3)
        self.plans.append(params)
        return Planned(
            title=f"Change {spec.kind} {target.name}",
            summary=[f"Scale {target.name} on {cluster.name}."],
            before=live,
            after=after,
            apply_label="Apply",
            state={"uid": live["metadata"]["uid"]},
        )

    async def apply(self, ctx, target, spec, planned):
        self.applies.append((target, planned.state, ctx.audit_id))
        await get_object(ctx.api, spec, target)
        return Applied("Done.")


@pytest.fixture
def handler(monkeypatch):
    found = Handler()
    monkeypatch.setitem(ACTIONS, "scale", found)
    monkeypatch.setitem(ACTIONS, "delete", found)
    return found


def _same(a: dict, b: dict) -> None:
    assert {k: v for k, v in a.items() if k not in FRESH} == {
        k: v for k, v in b.items() if k not in FRESH
    }


async def test_plan_action_answers_are_unchanged(env, handler):
    state = env.app.state

    async def direct(action: str, cluster: str = "dev-a", **over):
        out = await make_plan(
            state,
            actor=LOCAL_ACTOR,
            action=action,
            handler=handler,
            target=Target(**target(env, cluster, **over)),
            params={"replicas": 5},
            limit=MAX_OPEN_DELETE_PLANS if action == "delete" else None,
        )
        return out.model_dump(mode="json")

    # A plain change: no typing, no warning.
    r = await plan(env, params={"replicas": 5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["confirm_text"], body["warnings"], body["blocked"]) == (None, [], [])
    assert body["summary"] == ["Scale web on dev-a."]
    _same(body, await direct("scale"))

    # A delete on a production cluster: the name typed, the production warning first.
    r = await plan(env, action="delete", cluster="prod-east", params={"replicas": 5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["confirm_text"] == "web" and body["warnings"] == ["This is a production cluster."]
    _same(body, await direct("delete", "prod-east"))

    # Refusals in the same words, by both ways in.
    for over, status, detail in (
        ({"cluster_id": "nope"}, 404, "Unknown cluster"),
        ({"kind_key": "gadgets.example.dev"}, 404, None),
        ({"name": "ghost"}, 404, None),
    ):
        handler.kinds = None
        if "cluster_id" in over:
            r = await env.client.post(
                "/api/actions/plan",
                json={"action": "scale", "target": target(env) | over},
            )
        else:
            r = await plan(env, **over)
        assert r.status_code == status, (over, r.text)
        if detail is not None:
            assert r.json()["detail"] == detail
        with pytest.raises(Exception) as caught:
            await make_plan(
                state,
                actor=LOCAL_ACTOR,
                action="scale",
                handler=handler,
                target=Target(**(target(env) | over)),
                params={},
            )
        assert (caught.value.status_code, caught.value.detail) == (status, r.json()["detail"])

    # The open-delete limit holds for server-built deletes too.
    plans = state.plans
    real = plans.open_count
    plans.open_count = lambda actor, action: MAX_OPEN_DELETE_PLANS
    try:
        r = await plan(env, action="delete")
        assert (r.status_code, r.json()["detail"]) == (429, OPEN_DELETES_LIMIT)
        with pytest.raises(Exception) as caught:
            await direct("delete")
        assert (caught.value.status_code, caught.value.detail) == (429, OPEN_DELETES_LIMIT)
    finally:
        plans.open_count = real


async def test_server_built_plan_applies_through_the_apply_route(env):
    own = Handler()
    assert own not in ACTIONS.values()  # the browser can't name it
    out = await make_plan(
        env.app.state,
        actor=LOCAL_ACTOR,
        action="create",
        handler=own,
        target=Target(**target(env, "dev-b")),
        params={"replicas": 4},
    )
    assert out.action == "create" and out.cluster.name == "dev-b" and out.confirm_text is None
    assert own.plans == [{"replicas": 4}]

    r = await apply(env, out.plan_id)
    assert r.status_code == 200, r.text
    assert r.json()["outcome"] == "succeeded" and r.json()["message"] == "Done."
    [(applied_target, state, audit_id)] = own.applies
    assert applied_target.cluster_id == env.ids["dev-b"] and state == {"uid": "u-web"}

    newest = (await records(env))[0]
    assert newest.id == audit_id
    assert (newest.app, newest.action, newest.outcome) == ("kubernetes", "create", "succeeded")
    assert (newest.cluster_id, newest.cluster_name) == (env.ids["dev-b"], "dev-b")
    assert (newest.kind, newest.namespace, newest.name) == ("deployments.apps", "demo", "web")
    assert "-  replicas: 2" in newest.diff and "+  replicas: 4" in newest.diff
    # Used once, like any plan.
    assert (await apply(env, out.plan_id)).status_code == 404


async def test_the_browser_cannot_ask_for_create(env, handler):
    r = await plan(env, action="create")
    assert r.status_code == 422
    assert handler.plans == []

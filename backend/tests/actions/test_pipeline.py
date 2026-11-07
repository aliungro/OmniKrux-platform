"""The plan → confirm → audit → apply pipeline, driven over HTTP with a fake handler registered
for the test, against fake Kubernetes APIs (one per cluster)."""

import asyncio
import copy
import json
from contextlib import AsyncExitStack
from dataclasses import dataclass

import httpx
import pytest
import yaml
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from kubernetes_asyncio.client.exceptions import ApiException
from sqlalchemy import text

from omnikrux.actions import authz, pipeline
from omnikrux.actions.authz import NotAllowed
from omnikrux.actions.pipeline import (
    ACTIONS,
    Applied,
    Diff,
    Planned,
    PlanStore,
    diff_text,
    to_yaml,
)
from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.kube.http import read_json
from omnikrux.main import create_app
from omnikrux.web_security import WRITE_METHODS
from tests.fakekube import FakeKubeApi, kubeconfig_for, serve_fake_api, status_body

EXPIRED = "This change expired or was already applied. Review it again."
CONFLICT = "Deployment web changed since you reviewed this change. Review it again."


def deployment(name: str = "web", replicas: int = 2, uid: str = "u-web") -> dict:
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": "demo",
            "uid": uid,
            "resourceVersion": "7",
            "generation": 3,
            "creationTimestamp": "2026-11-01T10:00:00Z",
            "managedFields": [{"manager": "kubectl"}],
            "labels": {"app": name},
        },
        "spec": {"replicas": replicas},
        "status": {"replicas": replicas, "readyReplicas": replicas},
    }


async def get_object(api, spec, target) -> dict:
    return await read_json(
        api.call_api(
            spec.object_path(target.namespace, target.name),
            "GET",
            auth_settings=["BearerToken"],
            _preload_content=False,
            _return_http_data_only=True,
        )
    )


class FakeHandler:
    """Reads the live object to plan; "applies" by reading it again through the context's
    client, so the test sees which cluster the apply reached."""

    def __init__(self, kinds=frozenset({"deployments.apps"}), *, typed=False, blocked=()):
        self.kinds = kinds
        self.typed = typed
        self.blocked = list(blocked)
        self.error: Exception | None = None
        self.during_apply = None
        self.delay = 0.0
        self.plans: list[tuple] = []
        self.applies: list[tuple] = []

    async def plan(self, api, spec, target, params):
        live = await get_object(api, spec, target)
        after = copy.deepcopy(live)
        after.setdefault("spec", {})["replicas"] = params.get("replicas", 3)
        self.plans.append((target, params))
        return Planned(
            title=f"Change {spec.kind} {target.name}",
            summary=[f"Scale {target.name} to {params.get('replicas', 3)}."],
            warnings=[],
            blocked=list(self.blocked),
            diff=Diff(before=to_yaml(live), after=to_yaml(after)),
            typed=self.typed,
            apply_label="Apply",
            state={"uid": live["metadata"]["uid"]},
        )

    async def apply(self, ctx, target, spec, planned):
        self.applies.append((ctx, target, planned.state))
        if self.during_apply is not None:
            await self.during_apply(ctx)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        await get_object(ctx.api, spec, target)
        return Applied("Done.")


def kubeconfig_named(fake: FakeKubeApi, context: str) -> str:
    config = kubeconfig_for(fake)
    config["contexts"][0]["name"] = context
    config["current-context"] = context
    return yaml.safe_dump(config)


@dataclass
class Env:
    app: object
    client: httpx.AsyncClient
    ids: dict[str, str]  # context name -> cluster id
    fakes: dict[str, FakeKubeApi]  # context name -> its API


@pytest.fixture
async def env(tmp_path):
    """Three clusters, each with its own fake API serving deployment demo/web and namespace
    demo: dev-a and dev-b (development) and prod-east (production)."""
    names = ("dev-a", "dev-b", "prod-east")
    async with AsyncExitStack() as stack:
        fakes = {name: await stack.enter_async_context(serve_fake_api()) for name in names}
        for fake in fakes.values():
            fake.objects["deployments.apps"][("demo", "web")] = deployment()
            fake.objects["namespaces"][("", "demo")] = {"metadata": {"name": "demo", "uid": "u-ns"}}
        app = create_app(
            Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
        )
        await stack.enter_async_context(app.router.lifespan_context(app))
        ids = {}
        for name, fake in fakes.items():
            [info] = await app.state.registry.upsert_from_kubeconfig(
                kubeconfig_named(fake, name), rewrite_loopback=False, source=SOURCE_UPLOAD
            )
            ids[name] = info.id
        transport = httpx.ASGITransport(app=app)
        client = await stack.enter_async_context(
            httpx.AsyncClient(transport=transport, base_url="http://testserver")
        )
        yield Env(app, client, ids, fakes)


@pytest.fixture
def scale(monkeypatch):
    handler = FakeHandler()
    monkeypatch.setitem(ACTIONS, "scale", handler)
    return handler


def target(env: Env, cluster: str = "dev-a", **overrides) -> dict:
    values = {
        "cluster_id": env.ids[cluster],
        "kind_key": "deployments.apps",
        "namespace": "demo",
        "name": "web",
    }
    return values | overrides


async def plan(env: Env, action: str = "scale", cluster: str = "dev-a", params=None, **target_):
    body = {"action": action, "target": target(env, cluster, **target_)}
    if params is not None:
        body["params"] = params
    return await env.client.post("/api/actions/plan", json=body)


async def apply(env: Env, plan_id: str, body: dict | None = None):
    return await env.client.post(f"/api/actions/{plan_id}/apply", json=body or {})


async def records(env: Env) -> list:
    return (await env.app.state.audit.list()).records


# --- the plan --------------------------------------------------------------------------


async def test_plan_out_names_the_cluster_and_hides_handler_state(env, scale):
    r = await plan(env, params={"replicas": 5})

    assert r.status_code == 200
    body = r.json()
    assert body["action"] == "scale"
    assert body["target"] == target(env)
    assert body["cluster"] == {
        "id": env.ids["dev-a"],
        "name": "dev-a",
        "provider": "onprem",
        "environment": "development",
    }
    assert body["title"] == "Change Deployment web"
    assert body["summary"] == ["Scale web to 5."]
    assert (body["warnings"], body["blocked"], body["confirm_text"]) == ([], [], None)
    assert body["apply_label"] == "Apply"
    assert "replicas: 2" in body["diff"]["before"] and "replicas: 5" in body["diff"]["after"]
    assert "state" not in body and "u-web" not in json.dumps(body)  # the handler's own data
    assert len(body["plan_id"]) >= 20 and body["expires_at"]
    [(planned_target, params)] = scale.plans
    assert params == {"replicas": 5} and planned_target.cluster_id == env.ids["dev-a"]


async def test_plan_refuses_unknown_action_kind_and_unserved(env, scale, monkeypatch):
    monkeypatch.delitem(ACTIONS, "drain", raising=False)
    r = await plan(env, action="drain")
    assert r.status_code == 422

    r = await plan(env, action="explode")
    assert r.status_code == 422

    r = await plan(env, kind_key="pods", name="web-1")  # the handler doesn't scale pods
    assert r.status_code == 422

    r = await plan(env, kind_key="Not A Key")
    assert r.status_code == 422

    r = await env.client.post(
        "/api/actions/plan",
        json={"action": "scale", "target": target(env) | {"uid": "x"}},
    )
    assert r.status_code == 422

    monkeypatch.setattr(scale, "kinds", None)
    r = await plan(env, kind_key="gadgets.example.dev")
    assert r.status_code == 404
    assert r.json() == {"detail": "This cluster doesn't serve gadgets.example.dev."}

    r = await env.client.post(
        "/api/actions/plan",
        json={"action": "scale", "target": target(env) | {"cluster_id": "nope"}},
    )
    assert r.status_code == 404 and r.json() == {"detail": "Unknown cluster"}

    r = await plan(env, name="ghost")
    assert r.status_code == 404
    assert "ghost" in r.json()["detail"] and "{" not in r.json()["detail"]
    assert scale.applies == []


# --- apply -----------------------------------------------------------------------------


async def test_apply_writes_audit_before_executing(env, scale):
    seen = []

    async def during_apply(ctx):
        [record] = await records(env)
        seen.append(record)
        assert record.id == ctx.audit_id and ctx.actor == "local"

    scale.during_apply = during_apply
    plan_id = (await plan(env, params={"replicas": 3})).json()["plan_id"]

    r = await apply(env, plan_id)

    assert r.status_code == 200
    [record] = await records(env)
    assert r.json() == {
        "outcome": "succeeded",
        "message": "Done.",
        "job_id": None,
        "audit_id": record.id,
    }
    [during] = seen
    assert (during.outcome, during.finished_at) == ("started", None)
    assert (during.action, during.cluster_id, during.cluster_name, during.provider) == (
        "scale",
        env.ids["dev-a"],
        "dev-a",
        "onprem",
    )
    assert (during.namespace, during.kind, during.name, during.actor) == (
        "demo",
        "deployments.apps",
        "web",
        "local",
    )
    assert "-  replicas: 2\n+  replicas: 3\n" in during.diff
    assert during.details == {"title": "Change Deployment web", "summary": ["Scale web to 3."]}
    assert (record.outcome, record.message) == ("succeeded", "Done.")
    assert record.finished_at is not None


async def test_audit_failure_refuses_the_change(env, scale):
    plan_id = (await plan(env)).json()["plan_id"]
    async with env.app.state.engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))
    for fake in env.fakes.values():
        fake.requests.clear()

    r = await apply(env, plan_id)

    assert r.status_code == 503
    assert r.json() == {
        "detail": "Nothing was changed: the audit log can't be written (no such table: audit)."
    }
    assert scale.applies == []
    assert all(fake.requests == [] for fake in env.fakes.values())


async def test_plan_is_single_use_and_expires(env, scale):
    now = [1000.0]
    env.app.state.plans = PlanStore(clock=lambda: now[0])

    plan_id = (await plan(env)).json()["plan_id"]
    assert (await apply(env, plan_id)).status_code == 200
    r = await apply(env, plan_id)
    assert r.status_code == 404 and r.json() == {"detail": EXPIRED}

    plan_id = (await plan(env)).json()["plan_id"]
    now[0] += 299
    other_id = (await plan(env)).json()["plan_id"]
    now[0] += 2  # the first is 301 s old, the second 2 s
    r = await apply(env, plan_id)
    assert r.status_code == 404 and r.json() == {"detail": EXPIRED}
    assert (await apply(env, other_id)).status_code == 200

    r = await apply(env, "no-such-plan")
    assert r.status_code == 404 and r.json() == {"detail": EXPIRED}
    assert len(scale.applies) == 2


async def test_concurrent_applies_of_one_plan_exactly_one_wins(env, scale):
    scale.delay = 0.05
    plan_id = (await plan(env)).json()["plan_id"]

    results = await asyncio.gather(*(apply(env, plan_id) for _ in range(5)))

    assert sorted(r.status_code for r in results) == [200, 404, 404, 404, 404]
    assert len(scale.applies) == 1
    assert len(await records(env)) == 1


async def test_apply_body_rejects_extra_fields(env, scale):
    plan_id = (await plan(env, cluster="dev-a")).json()["plan_id"]

    for body in (
        {"cluster_id": env.ids["dev-b"]},
        {"confirm_text": None, "target": target(env, "dev-b")},
        {"namespace": "other"},
        {"params": {"replicas": 99}},
    ):
        r = await apply(env, plan_id, body)
        assert r.status_code == 422, body
    r = await env.client.post(
        f"/api/actions/{plan_id}/apply", params={"cluster_id": env.ids["dev-b"]}, json={}
    )
    assert r.status_code == 422
    assert scale.applies == []

    r = await apply(env, plan_id)  # a refused body doesn't use the plan up
    assert r.status_code == 200
    [(_, applied_target, _)] = scale.applies
    assert applied_target.cluster_id == env.ids["dev-a"]


async def test_apply_uses_only_the_planned_target(env, scale):
    env.fakes["dev-a"].objects["deployments.apps"][("demo", "web")] = deployment(uid="u-a")
    env.fakes["dev-b"].objects["deployments.apps"][("demo", "web")] = deployment(uid="u-b")
    r = await plan(env, cluster="dev-b")
    assert r.json()["cluster"]["name"] == "dev-b"
    assert env.fakes["dev-a"].requests == []  # the plan read only dev-b
    for fake in env.fakes.values():
        fake.requests.clear()

    r = await apply(env, r.json()["plan_id"])

    assert r.status_code == 200
    [(_, applied_target, state)] = scale.applies
    assert applied_target.model_dump() == target(env, "dev-b")
    assert state == {"uid": "u-b"}
    assert env.fakes["dev-a"].requests == [] and env.fakes["prod-east"].requests == []
    paths = [path for _, path, _ in env.fakes["dev-b"].requests]
    assert "/apis/apps/v1/namespaces/demo/deployments/web" in paths
    [record] = await records(env)
    assert (record.cluster_id, record.cluster_name) == (env.ids["dev-b"], "dev-b")


async def test_typed_confirmation_required_for_production_delete(env, monkeypatch):
    delete = FakeHandler(kinds=None)
    monkeypatch.setitem(ACTIONS, "delete", delete)

    r = await plan(env, action="delete", cluster="prod-east")
    body = r.json()
    assert body["cluster"]["environment"] == "production"
    assert body["confirm_text"] == "web"
    assert "This is a production cluster." in body["warnings"]
    plan_id = body["plan_id"]

    for typed in ({}, {"confirm_text": None}, {"confirm_text": "wbe"}, {"confirm_text": "WEB"}):
        r = await apply(env, plan_id, typed)
        assert r.status_code == 422 and r.json() == {"detail": "Type web to confirm"}
    assert delete.applies == [] and await records(env) == []

    r = await apply(env, plan_id, {"confirm_text": "web"})  # typos didn't use the plan up
    assert r.status_code == 200

    # Development: a deployment needs no typing, a namespace does.
    r = await plan(env, action="delete", cluster="dev-a")
    assert r.json()["confirm_text"] is None and r.json()["warnings"] == []
    r = await plan(env, action="delete", kind_key="namespaces", namespace=None, name="demo")
    assert r.json()["confirm_text"] == "demo"

    # Production, but not a delete or drain: a warning, no typing.
    monkeypatch.setitem(ACTIONS, "scale", FakeHandler())
    r = await plan(env, action="scale", cluster="prod-east")
    assert r.json()["confirm_text"] is None
    assert r.json()["warnings"] == ["This is a production cluster."]

    # A handler may ask for typing itself.
    monkeypatch.setitem(ACTIONS, "scale", FakeHandler(typed=True))
    r = await plan(env, action="scale", cluster="dev-a")
    assert r.json()["confirm_text"] == "web"


async def test_blocked_plan_cannot_be_applied(env, monkeypatch):
    blocked = FakeHandler(blocked=["2 pods aren't managed by a controller."])
    monkeypatch.setitem(ACTIONS, "scale", blocked)
    r = await plan(env)
    assert r.json()["blocked"] == ["2 pods aren't managed by a controller."]

    r = await apply(env, r.json()["plan_id"])

    assert r.status_code == 422
    assert r.json() == {"detail": "2 pods aren't managed by a controller."}
    assert blocked.applies == [] and await records(env) == []


def kube_error(status: int, message: str, causes: list[dict] | None = None) -> ApiException:
    body = status_body(status, "Conflict" if status == 409 else "Invalid", message)
    if causes is not None:
        body["details"] = {"causes": causes}
    exc = ApiException(status=status, reason="refused")
    exc.body = json.dumps(body)
    return exc


@pytest.mark.parametrize(
    "error",
    [
        kube_error(409, 'Operation cannot be fulfilled on deployments.apps "web": modified'),
        kube_error(
            422,
            "the server rejected our request due to an error in our request",
            [
                {
                    "reason": "FieldValueInvalid",
                    "message": 'Invalid value: "[{...}]": testing value /spec/replicas failed: '
                    "test failed",
                    "field": "patch",
                }
            ],
        ),
    ],
)
async def test_conflict_maps_to_review_again(env, scale, error):
    scale.error = error
    plan_id = (await plan(env)).json()["plan_id"]

    r = await apply(env, plan_id)

    assert r.status_code == 409
    assert r.json() == {"detail": CONFLICT}
    [record] = await records(env)
    assert (record.outcome, record.message) == ("failed", CONFLICT)


async def test_other_apply_failures_are_plain_and_audited(env, scale):
    scale.error = kube_error(422, 'Deployment.apps "web" is invalid: spec.replicas: Invalid')
    r = await apply(env, (await plan(env)).json()["plan_id"])
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail == (
        "Couldn't scale Deployment demo/web: "
        'Deployment.apps "web" is invalid: spec.replicas: Invalid'
    )

    scale.error = RuntimeError("boom\nTraceback (most recent call last)")
    r = await apply(env, (await plan(env)).json()["plan_id"])
    assert r.status_code == 502
    assert r.json() == {"detail": "Couldn't scale Deployment demo/web: RuntimeError: boom"}

    newest, older = await records(env)
    assert (older.outcome, older.message) == ("failed", detail)
    assert (newest.outcome, newest.message) == ("failed", r.json()["detail"])


async def test_structured_failure_detail_still_finishes_the_record(env, scale):
    from fastapi import HTTPException

    scale.error = HTTPException(status_code=422, detail={"field": "replicas"})
    r = await apply(env, (await plan(env)).json()["plan_id"])

    assert r.status_code == 422
    [record] = await records(env)
    assert (record.outcome, record.message) == ("failed", "{'field': 'replicas'}")


async def test_authorize_hook_called_for_plan_and_apply(env, scale, monkeypatch):
    calls = []

    async def recording(*args):
        calls.append(args)

    monkeypatch.setattr(authz, "authorize", recording)
    plan_id = (await plan(env)).json()["plan_id"]
    assert (await apply(env, plan_id)).status_code == 200
    expected = ("local", "scale", env.ids["dev-a"], "demo", "deployments.apps", "web")
    assert calls == [expected, expected]

    async def refusing(*args):
        raise NotAllowed("Not allowed to scale on dev-a.")

    plan_id = (await plan(env)).json()["plan_id"]
    monkeypatch.setattr(authz, "authorize", refusing)
    r = await apply(env, plan_id)
    assert r.status_code == 403 and r.json() == {"detail": "Not allowed to scale on dev-a."}
    r = await plan(env)
    assert r.status_code == 403 and r.json() == {"detail": "Not allowed to scale on dev-a."}
    assert len(scale.applies) == 1 and len(await records(env)) == 1


def write_routes(routes) -> list[tuple[str, str]]:
    """(method, path) of every write route under /api, including routers' own routes (newer
    FastAPI keeps an included router as one entry of `app.routes`)."""
    found = []
    for route in routes:
        if (inner := getattr(route, "original_router", None)) is not None:
            found += write_routes(inner.routes)
        elif isinstance(route, APIRoute) and route.path.startswith("/api"):
            found += [(method, route.path) for method in sorted(route.methods & WRITE_METHODS)]
    return found


def test_every_write_route_refuses_cross_origin(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    routes = write_routes(app.routes)
    paths = {path for _, path in routes}
    assert {"/api/actions/plan", "/api/actions/{plan_id}/apply"} <= paths
    documented = {
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method in operations
        if method.upper() in WRITE_METHODS
    }
    assert documented <= set(routes)  # the walk found every route

    with TestClient(app) as client:
        for method, path in routes:
            url = path.replace("{", "").replace("}", "")  # every parameter named after itself
            r = client.request(method, url, headers={"origin": "http://evil.example"}, json={})
            assert r.status_code == 403, (method, path)
            assert r.json() == {"detail": "Cross-origin request refused"}


# --- helpers ---------------------------------------------------------------------------


def test_to_yaml_drops_server_fields():
    out = to_yaml(deployment() | {"metadata": deployment()["metadata"] | {"name": "wéb"}})

    assert yaml.safe_load(out) == {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": "wéb", "namespace": "demo", "labels": {"app": "web"}},
        "spec": {"replicas": 2},
    }
    assert out.startswith("apiVersion: apps/v1\nkind: Deployment\n")  # keeps the order
    assert "wéb" in out  # not escaped


def test_diff_text_is_unified_and_capped():
    out = diff_text("a: 1\nb: 2\n", "a: 1\nb: 3\n")
    assert "-b: 2\n+b: 3\n" in out and out.startswith("---")

    huge = diff_text("", "".join(f"line {n}\n" for n in range(20_000)))
    assert len(huge.encode()) <= 64 * 1024 + 100
    assert huge.endswith("… (diff cut at 64 KB)")
    assert pipeline.DIFF_LIMIT == 64 * 1024

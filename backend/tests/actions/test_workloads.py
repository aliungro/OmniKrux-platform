"""Scale, restart and rollback through the action pipeline, against fake Kubernetes APIs: every
apply is a JSON patch whose `test` ops hold what the plan read (the uid, and the replicas or the
generation), so a change since review answers with the conflict copy."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
import yaml

from omnikrux.actions import workloads
from tests.actions.clusters import apply, plan, records

CONFLICT = "Deployment web changed since you reviewed this change. Review it again."
JSON_PATCH = "application/json-patch+json"
RESTARTED_AT = "kubectl.kubernetes.io/restartedAt"
DEPLOYMENTS = "deployments.apps"


def template(image: str, **labels: str) -> dict:
    return {
        "metadata": {"creationTimestamp": None, "labels": {"app": "web", **labels}},
        "spec": {"containers": [{"name": "web", "image": image}]},
    }


def web(
    *,
    kind: str = "Deployment",
    replicas: int = 3,
    uid: str = "u-web",
    revision: int = 3,
    image: str = "nginx:1.27",
    paused: bool = False,
) -> dict:
    spec = {
        "replicas": replicas,
        "selector": {"matchLabels": {"app": "web"}},
        "template": template(image),
    }
    if kind == "Deployment":
        spec["strategy"] = {"type": "RollingUpdate", "rollingUpdate": {"maxSurge": "25%"}}
    if paused:
        spec["paused"] = True
    return {
        "apiVersion": "apps/v1",
        "kind": kind,
        "metadata": {
            "name": "web",
            "namespace": "demo",
            "uid": uid,
            "resourceVersion": "7",
            "generation": 4,
            "creationTimestamp": "2026-11-01T10:00:00Z",
            "annotations": {"deployment.kubernetes.io/revision": str(revision)},
            "labels": {"app": "web"},
        },
        "spec": spec,
        "status": {"replicas": replicas, "readyReplicas": replicas},
    }


def replicaset(revision: int, image: str, *, owner: str = "u-web", day: int = 1) -> dict:
    pod_hash = f"h{revision}{owner[-3:]}"
    return {
        "apiVersion": "apps/v1",
        "kind": "ReplicaSet",
        "metadata": {
            "name": f"web-{pod_hash}",
            "namespace": "demo",
            "uid": f"u-rs-{pod_hash}",
            "creationTimestamp": f"2026-11-0{day}T10:00:00Z",
            "labels": {"app": "web", "pod-template-hash": pod_hash},
            "annotations": {"deployment.kubernetes.io/revision": str(revision)},
            "ownerReferences": [
                {
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "name": "web",
                    "uid": owner,
                    "controller": True,
                }
            ],
        },
        "spec": {"replicas": 0, "template": template(image, **{"pod-template-hash": pod_hash})},
    }


def seed(env, cluster: str = "dev-a", key: str = DEPLOYMENTS, **kwargs) -> dict:
    obj = web(**kwargs)
    env.fakes[cluster].objects[key][("demo", "web")] = obj
    return obj


def live(env, cluster: str = "dev-a", key: str = DEPLOYMENTS) -> dict:
    return env.fakes[cluster].objects[key][("demo", "web")]


def seed_revisions(env, cluster: str = "dev-a") -> None:
    """Revisions 1 to 3 of demo/web (3 is current), one of another deployment, one unnumbered."""
    store = env.fakes[cluster].objects["replicasets.apps"]
    for rs in (
        replicaset(1, "nginx:1.25", day=1),
        replicaset(3, "nginx:1.27", day=3),
        replicaset(2, "nginx:1.26", day=2),
        replicaset(7, "busybox:1", owner="u-other", day=4),
    ):
        store[("demo", rs["metadata"]["name"])] = rs
    stray = replicaset(5, "nginx:0.1")
    del stray["metadata"]["annotations"]
    store[("demo", "web-stray")] = stray


def hpa(name: str, kind: str = "Deployment", target: str = "web") -> dict:
    return {
        "apiVersion": "autoscaling/v2",
        "kind": "HorizontalPodAutoscaler",
        "metadata": {"name": name, "namespace": "demo", "uid": f"u-{name}"},
        "spec": {
            "scaleTargetRef": {"apiVersion": "apps/v1", "kind": kind, "name": target},
            "minReplicas": 2,
            "maxReplicas": 10,
        },
    }


def patches(env, cluster: str = "dev-a") -> list[dict]:
    return [w for w in env.fakes[cluster].writes if w["method"] == "PATCH"]


async def changed_elsewhere(env, patch: dict, key: str = DEPLOYMENTS) -> None:
    """Someone else changes demo/web through the API (a merge patch), as kubectl would: the API
    server bumps its resourceVersion, and its generation when the spec changed."""
    plural, _, group = key.partition(".")
    path = f"/apis/{group}/v1/namespaces/demo/{plural}/web"
    async with httpx.AsyncClient(base_url=env.fakes["dev-a"].url) as client:
        r = await client.patch(
            path, json=patch, headers={"Content-Type": "application/merge-patch+json"}
        )
    assert r.status_code == 200, r.text


# --- scale ------------------------------------------------------------------------------


async def test_scale_plan_summary_and_zero_warning(env):
    seed(env)

    r = await plan(env, "scale", params={"replicas": 0})

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Scale Deployment web"
    assert body["summary"] == ["Scale Deployment demo/web from 3 to 0 replicas."]
    assert body["warnings"] == ["Scaling to 0 stops every pod of web."]
    assert body["blocked"] == [] and body["apply_label"] == "Scale"
    assert "replicas: 3" in body["diff"]["before"] and "replicas: 0" in body["diff"]["after"]
    assert patches(env) == []  # planning changes nothing

    r = await plan(env, "scale", params={"replicas": 5})
    assert r.json()["summary"] == ["Scale Deployment demo/web from 3 to 5 replicas."]
    assert r.json()["warnings"] == []

    seed(env, key="statefulsets.apps", kind="StatefulSet", replicas=1)
    r = await plan(env, "scale", kind_key="statefulsets.apps", params={"replicas": 2})
    assert r.json()["summary"] == ["Scale StatefulSet demo/web from 1 to 2 replicas."]


async def test_scale_to_the_current_count_is_blocked(env):
    seed(env)

    r = await plan(env, "scale", params={"replicas": 3})

    assert r.status_code == 200
    assert r.json()["blocked"] == ["Nothing changes: web already runs 3 replicas."]
    r = await apply(env, r.json()["plan_id"])
    assert r.status_code == 422
    assert r.json() == {"detail": "Nothing changes: web already runs 3 replicas."}
    assert patches(env) == [] and await records(env) == []


async def test_scale_warns_about_hpa(env):
    seed(env)
    seed(env, key="statefulsets.apps", kind="StatefulSet")
    hpas = env.fakes["dev-a"].objects["horizontalpodautoscalers.autoscaling"]
    hpas[("demo", "web-hpa")] = hpa("web-hpa")
    hpas[("demo", "api-hpa")] = hpa("api-hpa", target="api")
    hpas[("other", "web-elsewhere")] = hpa("web-elsewhere") | {
        "metadata": {"name": "web-elsewhere", "namespace": "other"}
    }

    r = await plan(env, "scale", params={"replicas": 4})

    assert r.json()["warnings"] == [
        "HorizontalPodAutoscaler web-hpa manages these replicas and may change them back."
    ]
    # The HPA targets the Deployment named web, not the StatefulSet named web.
    r = await plan(env, "scale", kind_key="statefulsets.apps", params={"replicas": 4})
    assert r.json()["warnings"] == []


async def test_scale_apply_patch_has_test_ops(env):
    seed(env)
    plan_id = (await plan(env, "scale", params={"replicas": 5})).json()["plan_id"]

    r = await apply(env, plan_id)

    assert r.status_code == 200, r.text
    assert r.json()["message"] == "Scaled Deployment demo/web to 5 replicas."
    [write] = patches(env)
    assert write["path"] == "/apis/apps/v1/namespaces/demo/deployments/web"
    assert write["content_type"] == JSON_PATCH
    assert write["body"] == [
        {"op": "test", "path": "/metadata/uid", "value": "u-web"},
        {"op": "test", "path": "/spec/replicas", "value": 3},
        {"op": "replace", "path": "/spec/replicas", "value": 5},
    ]
    assert live(env)["spec"]["replicas"] == 5
    [record] = await records(env)
    assert (record.action, record.outcome) == ("scale", "succeeded")
    assert "-  replicas: 3\n+  replicas: 5\n" in record.diff


async def test_scale_conflict_when_replicas_changed(env):
    seed(env)
    plan_id = (await plan(env, "scale", params={"replicas": 5})).json()["plan_id"]
    live(env)["spec"]["replicas"] = 4  # someone else scaled it meanwhile

    r = await apply(env, plan_id)

    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert live(env)["spec"]["replicas"] == 4
    [record] = await records(env)
    assert (record.outcome, record.message) == ("failed", CONFLICT)

    # Deleted and re-created under the same name, with the same replicas: the uid tells.
    seed(env)
    plan_id = (await plan(env, "scale", params={"replicas": 5})).json()["plan_id"]
    seed(env, uid="u-web-2")
    r = await apply(env, plan_id)
    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert live(env)["spec"]["replicas"] == 3


async def test_scale_rejects_other_kinds_and_negative(env):
    seed(env)
    seed(env, key="daemonsets.apps", kind="DaemonSet")
    for kind_key, name in (("daemonsets.apps", "web"), ("pods", "web-1")):
        r = await plan(env, "scale", kind_key=kind_key, name=name, params={"replicas": 2})
        assert r.status_code == 422, kind_key

    for params in (
        {"replicas": -1},
        {"replicas": 10_001},
        {"replicas": "3"},
        {"replicas": True},
        {"replicas": 2.5},
        {"replicas": None},
        {},
    ):
        r = await plan(env, "scale", params=params)
        assert r.status_code == 422, params
        assert r.json() == {"detail": "Replicas must be a whole number from 0 to 10,000."}

    for replicas in (0, 10_000):
        assert (await plan(env, "scale", params={"replicas": replicas})).status_code == 200
    assert patches(env) == []


# --- restart ----------------------------------------------------------------------------


async def test_restart_sets_restarted_at_annotation(env, monkeypatch):
    seed(env)

    r = await plan(env, "restart")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Restart Deployment web"
    assert body["summary"] == [
        "Restart every pod of Deployment demo/web, following its update strategy (RollingUpdate)."
    ]
    assert body["warnings"] == [] and body["apply_label"] == "Restart"
    assert RESTARTED_AT not in body["diff"]["before"] and RESTARTED_AT in body["diff"]["after"]

    reviewed = yaml.safe_load(body["diff"]["after"])["spec"]["template"]["metadata"]
    reviewed_stamp = reviewed["annotations"][RESTARTED_AT]
    moment = datetime.fromisoformat(reviewed_stamp)
    assert abs(moment - datetime.now(UTC)) < timedelta(seconds=5)
    # The clock moves on between review and apply: the reviewed stamp is still the one written.
    monkeypatch.setattr(workloads, "_now", lambda: "2099-01-01T00:00:00Z")

    r = await apply(env, body["plan_id"])

    assert r.status_code == 200, r.text
    assert r.json()["message"] == "Restarting every pod of Deployment demo/web."
    [write] = patches(env)
    assert write["content_type"] == JSON_PATCH
    # No annotations yet: the map is added whole. The generation (bumped by any spec change)
    # guards it, so a map added meanwhile is never replaced.
    assert write["body"] == [
        {"op": "test", "path": "/metadata/uid", "value": "u-web"},
        {"op": "test", "path": "/metadata/generation", "value": 4},
        {
            "op": "add",
            "path": "/spec/template/metadata/annotations",
            "value": {RESTARTED_AT: reviewed_stamp},
        },
    ]
    # Exactly the stamp the user reviewed and the audit recorded.
    stamp = live(env)["spec"]["template"]["metadata"]["annotations"][RESTARTED_AT]
    assert stamp == reviewed_stamp
    [record] = await records(env)
    assert f"{RESTARTED_AT}: '{reviewed_stamp}'" in record.diff

    # With annotations already there, only the one key is added (or replaced).
    obj = seed(env, key="statefulsets.apps", kind="StatefulSet")
    obj["spec"]["updateStrategy"] = {"type": "OnDelete"}
    obj["spec"]["template"]["metadata"]["annotations"] = {"team": "web", RESTARTED_AT: "old"}
    env.fakes["dev-a"].objects["statefulsets.apps"][("demo", "web")] = obj
    r = await plan(env, "restart", kind_key="statefulsets.apps")
    assert r.json()["summary"] == [
        "Restart every pod of StatefulSet demo/web, following its update strategy (OnDelete)."
    ]
    assert (await apply(env, r.json()["plan_id"])).status_code == 200
    test_uid, test_generation, add = patches(env)[-1]["body"]
    assert test_uid["path"] == "/metadata/uid"
    assert test_generation == {"op": "test", "path": "/metadata/generation", "value": 4}
    assert add["op"] == "add"
    assert add["path"] == "/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt"
    annotations = live(env, key="statefulsets.apps")["spec"]["template"]["metadata"]["annotations"]
    assert annotations["team"] == "web" and annotations[RESTARTED_AT] != "old"


async def test_restart_paused_deployment_warning(env):
    seed(env, paused=True)

    r = await plan(env, "restart")

    assert r.json()["warnings"] == [
        "This deployment is paused: the restart happens once it's resumed."
    ]
    seed(env, key="daemonsets.apps", kind="DaemonSet")
    r = await plan(env, "restart", kind_key="daemonsets.apps")
    assert r.status_code == 200 and r.json()["warnings"] == []
    r = await plan(env, "restart", kind_key="replicasets.apps")
    assert r.status_code == 422


async def test_restart_conflict_when_annotations_appeared(env):
    seed(env)
    plan_id = (await plan(env, "restart")).json()["plan_id"]
    await changed_elsewhere(
        env, {"spec": {"template": {"metadata": {"annotations": {"team": "web"}}}}}
    )

    r = await apply(env, plan_id)

    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert live(env)["spec"]["template"]["metadata"]["annotations"] == {"team": "web"}


# --- rollback ---------------------------------------------------------------------------


async def test_revisions_listed_newest_first(env):
    seed(env)
    seed_revisions(env)
    url = f"/api/clusters/{env.ids['dev-a']}/deployments/demo/web/revisions"

    r = await env.client.get(url)

    assert r.status_code == 200, r.text
    assert r.json() == [
        {
            "revision": 3,
            "created_at": "2026-11-03T10:00:00Z",
            "images": ["nginx:1.27"],
            "current": True,
        },
        {
            "revision": 2,
            "created_at": "2026-11-02T10:00:00Z",
            "images": ["nginx:1.26"],
            "current": False,
        },
        {
            "revision": 1,
            "created_at": "2026-11-01T10:00:00Z",
            "images": ["nginx:1.25"],
            "current": False,
        },
    ]
    requests = env.fakes["dev-a"].requests
    assert ("GET", "/apis/apps/v1/namespaces/demo/replicasets", {"labelSelector": "app=web"}) in (
        requests
    )

    r = await env.client.get(f"/api/clusters/{env.ids['dev-a']}/deployments/demo/ghost/revisions")
    assert r.status_code == 404 and "ghost" in r.json()["detail"]
    r = await env.client.get(f"/api/clusters/{env.ids['dev-a']}/deployments/demo/we%3Fb/revisions")
    assert r.status_code == 422


async def test_rollback_plan_diffs_templates(env):
    seed(env)
    seed_revisions(env)

    r = await plan(env, "rollback", params={"revision": None})

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Roll back Deployment web"
    assert body["summary"] == ["Roll back Deployment demo/web from revision 3 to revision 2."]
    assert body["apply_label"] == "Roll back" and body["blocked"] == []
    diff = body["diff"]
    assert "image: nginx:1.27" in diff["before"] and "image: nginx:1.26" in diff["after"]
    assert "pod-template-hash" not in diff["before"] + diff["after"]
    assert "replicas" not in diff["before"]  # only the pod template is compared

    r = await plan(env, "rollback", params={"revision": 1})
    assert r.json()["summary"] == ["Roll back Deployment demo/web from revision 3 to revision 1."]
    assert "image: nginx:1.25" in r.json()["diff"]["after"]
    r = await plan(env, "rollback")  # no params: the previous revision
    assert "image: nginx:1.26" in r.json()["diff"]["after"]
    assert patches(env) == []


async def test_rollback_without_earlier_revision_plain(env):
    seed(env, revision=1)
    env.fakes["dev-a"].objects["replicasets.apps"][("demo", "web-1")] = replicaset(1, "nginx:1.27")

    r = await plan(env, "rollback", params={"revision": None})

    assert r.status_code == 200
    assert r.json()["blocked"] == ["Deployment web has no earlier revision to roll back to."]
    assert r.json()["diff"] is None
    r = await apply(env, r.json()["plan_id"])
    assert r.status_code == 422
    assert r.json() == {"detail": "Deployment web has no earlier revision to roll back to."}

    seed(env)
    seed_revisions(env)
    r = await plan(env, "rollback", params={"revision": 9})
    assert r.status_code == 422
    assert r.json() == {"detail": "Deployment web has no revision 9. Pick one from its revisions."}
    r = await plan(env, "rollback", params={"revision": 3})
    assert r.json()["blocked"] == ["Deployment web already runs revision 3."]
    for params in ({"revision": "2"}, {"revision": 0}, {"revision": True}):
        r = await plan(env, "rollback", params=params)
        assert r.status_code == 422, params
    r = await plan(env, "rollback", kind_key="statefulsets.apps", params={"revision": None})
    assert r.status_code == 422
    assert patches(env) == []


async def test_rollback_of_a_paused_deployment_is_blocked(env):
    seed(env, paused=True)
    seed_revisions(env)

    r = await plan(env, "rollback", params={"revision": None})

    assert r.status_code == 200
    assert r.json()["blocked"] == ["Deployment web is paused: resume it before rolling back."]
    r = await apply(env, r.json()["plan_id"])
    assert r.status_code == 422
    assert r.json() == {"detail": "Deployment web is paused: resume it before rolling back."}
    assert patches(env) == []


async def test_rollback_apply_replaces_template_without_hash_label(env):
    obj = seed(env)
    # Text the API server's JSON writes differently from Python's (`&&` escaped as \u0026, and
    # non-ASCII): the precondition must not compare it byte for byte, so it tests the generation.
    obj["spec"]["template"]["spec"]["containers"][0]["command"] = ["sh", "-c", "a && b < c ≥ d"]
    env.fakes["dev-a"].objects[DEPLOYMENTS][("demo", "web")] = obj
    seed_revisions(env)
    plan_id = (await plan(env, "rollback", params={"revision": 2})).json()["plan_id"]

    r = await apply(env, plan_id)

    assert r.status_code == 200, r.text
    assert r.json()["message"] == "Rolled back Deployment demo/web to revision 2."
    target_template = template("nginx:1.26")
    [write] = patches(env)
    assert write["content_type"] == JSON_PATCH
    assert write["body"] == [
        {"op": "test", "path": "/metadata/uid", "value": "u-web"},
        {"op": "test", "path": "/metadata/generation", "value": 4},
        {"op": "replace", "path": "/spec/template", "value": target_template},
    ]
    assert live(env)["spec"]["template"] == target_template
    [record] = await records(env)
    assert "-    image: nginx:1.27\n" in record.diff and "+    image: nginx:1.26\n" in record.diff
    assert "-    - a && b < c ≥ d\n" in record.diff

    # The spec changed after the review: nothing is rolled back.
    seed(env)
    plan_id = (await plan(env, "rollback", params={"revision": 2})).json()["plan_id"]
    containers = [{"name": "web", "image": "nginx:1.28"}]
    await changed_elsewhere(env, {"spec": {"template": {"spec": {"containers": containers}}}})
    r = await apply(env, plan_id)
    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert live(env)["spec"]["template"]["spec"]["containers"][0]["image"] == "nginx:1.28"


# --- isolation --------------------------------------------------------------------------


@pytest.mark.parametrize("action,params", [("scale", {"replicas": 5}), ("restart", None)])
async def test_plan_reads_the_named_cluster_only(env, action, params):
    seed(env, "dev-a")
    seed(env, "dev-b", uid="u-web-b")
    for fake in env.fakes.values():
        fake.requests.clear()

    r = await plan(env, action, cluster="dev-b", params=params)

    assert r.status_code == 200, r.text
    assert r.json()["cluster"]["name"] == "dev-b"
    assert env.fakes["dev-a"].requests == [] and env.fakes["prod-east"].requests == []

    r = await apply(env, r.json()["plan_id"])

    assert r.status_code == 200, r.text
    assert env.fakes["dev-a"].requests == [] and env.fakes["prod-east"].requests == []
    assert env.fakes["dev-a"].writes == []
    assert live(env, "dev-a") == web()
    [write] = patches(env, "dev-b")
    assert write["body"][0] == {"op": "test", "path": "/metadata/uid", "value": "u-web-b"}

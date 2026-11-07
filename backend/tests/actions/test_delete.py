"""Deleting objects through the action pipeline, against fake Kubernetes APIs: the plan lists
every effect (a replacement pod, the pods a workload takes with it, everything in a namespace),
and the apply is a DELETE whose `preconditions.uid` is the object the user reviewed, so a
re-created object of the same name answers with the conflict copy."""

import base64
from dataclasses import replace

from tests.actions.clusters import apply, deployment, plan, records

BACKGROUND_UID = {"propagationPolicy": "Background", "preconditions": {"uid": "u-web"}}


def pod(name: str, *, owner: tuple[str, str] | None = None, labels=None, uid=None) -> dict:
    md = {"name": name, "namespace": "demo", "uid": uid or f"u-{name}", "labels": labels or {}}
    if owner is not None:
        md["ownerReferences"] = [
            {"apiVersion": "apps/v1", "kind": owner[0], "name": owner[1], "uid": "u-owner"},
            {"apiVersion": "v1", "kind": "ConfigMap", "name": "not-a-controller", "uid": "u-x"},
        ]
        md["ownerReferences"][0]["controller"] = True
    return {"apiVersion": "v1", "kind": "Pod", "metadata": md, "spec": {"containers": []}}


def seed_web_with_pods(env, cluster: str = "dev-a") -> None:
    fake = env.fakes[cluster]
    web = deployment()
    web["spec"]["selector"] = {"matchLabels": {"app": "web"}}
    fake.objects["deployments.apps"][("demo", "web")] = web
    for i in range(3):
        fake.pods[("demo", f"web-{i}")] = pod(f"web-{i}", labels={"app": "web"})
    fake.pods[("demo", "api-0")] = pod("api-0", labels={"app": "api"})


async def test_delete_plan_effects_per_kind(env):
    fake = env.fakes["dev-a"]
    fake.pods[("demo", "web-abc-1")] = pod("web-abc-1", owner=("ReplicaSet", "web-abc"))
    fake.pods[("demo", "bare")] = pod("bare")
    seed_web_with_pods(env)

    # A pod its controller replaces.
    r = await plan(env, "delete", kind_key="pods", name="web-abc-1")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Delete Pod web-abc-1"
    assert body["summary"] == [
        "Delete Pod demo/web-abc-1 on dev-a.",
        "ReplicaSet web-abc starts a replacement pod.",
    ]
    assert body["apply_label"] == "Delete" and body["blocked"] == []
    assert "name: web-abc-1" in body["diff"]["before"] and body["diff"]["after"] == ""

    # A pod nothing replaces.
    r = await plan(env, "delete", kind_key="pods", name="bare")
    assert r.json()["summary"] == ["Delete Pod demo/bare on dev-a."]

    # A workload: its pods, counted by its selector, go too.
    r = await plan(env, "delete")
    assert r.json()["summary"] == [
        "Delete Deployment demo/web on dev-a.",
        "Its 3 pods are deleted too.",
    ]
    lists = [q for m, p, q in fake.requests if (m, p) == ("GET", "/api/v1/namespaces/demo/pods")]
    assert lists == [{"labelSelector": "app=web"}]

    # A namespace: everything in it.
    r = await plan(env, "delete", kind_key="namespaces", namespace=None, name="demo")
    assert r.json()["summary"] == [
        "Delete Namespace demo on dev-a.",
        "Everything in namespace demo is deleted too.",
    ]

    # The plan names the cluster it reads, whichever it is. (This deployment has no selector,
    # so its pods can't be counted; they are still said to go.)
    r = await plan(env, "delete", cluster="dev-b")
    assert r.json()["summary"] == [
        "Delete Deployment demo/web on dev-b.",
        "Its pods are deleted too.",
    ]

    # A Secret's values never reach the plan.
    value = base64.b64encode(b"s3cr3t-omnikrux").decode()
    fake.objects["secrets"][("demo", "db")] = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "db", "namespace": "demo", "uid": "u-db"},
        "data": {"password": value},
    }
    r = await plan(env, "delete", kind_key="secrets", name="db")
    assert r.status_code == 200 and r.json()["summary"] == ["Delete Secret demo/db on dev-a."]
    assert value not in r.text and "s3cr3t" not in r.text


async def test_delete_refuses_a_kind_without_the_delete_verb(env):
    fake = env.fakes["dev-b"]
    fake.resources = [
        replace(r, verbs=("get", "list", "watch")) if r.plural == "configmaps" else r
        for r in fake.resources
    ]
    fake.objects["configmaps"][("demo", "app")] = {"metadata": {"name": "app", "uid": "u-app"}}

    r = await plan(env, "delete", cluster="dev-b", kind_key="configmaps", name="app")

    assert r.status_code == 422
    assert r.json() == {
        "detail": "ConfigMap objects can't be deleted on this cluster: it doesn't allow deletes. "
        "Use kubectl if your access allows it."
    }


async def test_delete_needs_typed_name_for_namespace_and_production(env):
    # A namespace, even on a development cluster.
    r = await plan(env, "delete", kind_key="namespaces", namespace=None, name="demo")
    assert r.json()["confirm_text"] == "demo"
    plan_id = r.json()["plan_id"]
    r = await apply(env, plan_id)
    assert r.status_code == 422 and r.json() == {"detail": "Type demo to confirm"}
    assert env.fakes["dev-a"].deletes == []
    r = await apply(env, plan_id, {"confirm_text": "demo"})
    assert r.status_code == 200, r.text
    assert r.json()["message"] == "Deleted Namespace demo."
    assert ("", "demo") not in env.fakes["dev-a"].objects["namespaces"]

    # Anything on a production cluster.
    r = await plan(env, "delete", cluster="prod-east")
    assert r.json()["confirm_text"] == "web"
    assert r.json()["warnings"] == ["This is a production cluster."]
    r = await apply(env, r.json()["plan_id"], {"confirm_text": "wbe"})
    assert r.status_code == 422 and env.fakes["prod-east"].deletes == []

    # A deployment on a development cluster: no typing.
    r = await plan(env, "delete")
    assert r.json()["confirm_text"] is None


async def test_delete_uses_uid_precondition(env):
    fake = env.fakes["dev-a"]

    r = await plan(env, "delete")
    r = await apply(env, r.json()["plan_id"])

    assert r.status_code == 200, r.text
    assert r.json()["outcome"] == "succeeded"
    assert r.json()["message"] == "Deleted Deployment demo/web."
    assert fake.deletes == [
        {"path": "/apis/apps/v1/namespaces/demo/deployments/web", "body": BACKGROUND_UID}
    ]
    assert ("demo", "web") not in fake.objects["deployments.apps"]
    [record] = await records(env)
    assert (record.action, record.outcome) == ("delete", "succeeded")
    assert record.diff and "-  name: web" in record.diff

    # Re-created under the same name between the review and the apply: a different object.
    fake.objects["deployments.apps"][("demo", "web")] = deployment()
    r = await plan(env, "delete")
    fake.objects["deployments.apps"][("demo", "web")] = deployment(uid="u-web-2")
    r = await apply(env, r.json()["plan_id"])

    assert r.status_code == 409
    copy = "Deployment web changed since you reviewed this change. Review it again."
    assert r.json() == {"detail": copy}
    assert fake.deletes[-1]["body"] == BACKGROUND_UID
    assert fake.objects["deployments.apps"][("demo", "web")]["metadata"]["uid"] == "u-web-2"
    record = (await records(env))[0]
    assert (record.outcome, record.message) == ("failed", copy)

    # A crash-looping pod's resourceVersion moves all the time; its uid doesn't.
    r = await plan(env, "delete", kind_key="pods", name="web-1")
    fake.pods[("demo", "web-1")]["metadata"]["resourceVersion"] = "99"
    r = await apply(env, r.json()["plan_id"])
    assert r.status_code == 200, r.text
    assert fake.deletes[-1] == {
        "path": "/api/v1/namespaces/demo/pods/web-1",
        "body": {"propagationPolicy": "Background", "preconditions": {"uid": "u1"}},
    }
    assert ("demo", "web-1") not in fake.pods

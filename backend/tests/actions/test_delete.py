"""Deleting objects through the action pipeline, against fake Kubernetes APIs: the plan lists
every effect (a replacement pod, the pods a workload takes with it, everything in a namespace),
and the apply is a DELETE whose `preconditions.uid` is the object the user reviewed, so a
re-created object of the same name answers with the conflict copy."""

import base64
from dataclasses import replace

from omnikrux.actions.pipeline import MAX_OPEN_DELETE_PLANS, OPEN_DELETES_LIMIT
from tests.actions.clusters import apply, deployment, plan, records
from tests.fakekube import CRDS_KEY

NEW_JOB_LABEL = "batch.kubernetes.io/controller-uid"
OLD_JOB_LABEL = "controller-uid"
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


def job(name: str, cronjob_uid: str, *, label: str = NEW_JOB_LABEL) -> dict:
    uid = f"u-{name}"
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "namespace": "demo",
            "uid": uid,
            "ownerReferences": [
                {
                    "apiVersion": "batch/v1",
                    "kind": "CronJob",
                    "name": "x",
                    "uid": cronjob_uid,
                    "controller": True,
                }
            ],
        },
        "spec": {"selector": {"matchLabels": {label: uid}}},
    }


async def test_delete_plan_lists_every_cascade(env):
    """R31: what a delete takes with it, beyond the object itself."""
    fake = env.fakes["dev-a"]
    fake.pods.clear()

    # A CronJob: its Jobs (by controller uid) and their pods, on new and older clusters.
    fake.objects["cronjobs.batch"][("demo", "nightly")] = {
        "metadata": {"name": "nightly", "namespace": "demo", "uid": "u-cj"},
        "spec": {"schedule": "@daily"},
    }
    jobs = fake.objects["jobs.batch"]
    jobs[("demo", "nightly-2")] = job("nightly-2", "u-cj")
    jobs[("demo", "nightly-1")] = job("nightly-1", "u-cj", label=OLD_JOB_LABEL)
    jobs[("demo", "other-1")] = job("other-1", "u-other")
    labelled = {
        "nightly-2-a": {NEW_JOB_LABEL: "u-nightly-2", OLD_JOB_LABEL: "u-nightly-2"},
        "nightly-2-b": {NEW_JOB_LABEL: "u-nightly-2", OLD_JOB_LABEL: "u-nightly-2"},
        "nightly-1-a": {OLD_JOB_LABEL: "u-nightly-1"},
        "other-1-a": {NEW_JOB_LABEL: "u-other-1", OLD_JOB_LABEL: "u-other-1"},
    }
    for name, labels in labelled.items():
        fake.pods[("demo", name)] = pod(name, labels=labels)

    r = await plan(env, "delete", kind_key="cronjobs.batch", name="nightly")
    assert r.status_code == 200, r.text
    assert r.json()["summary"] == [
        "Delete CronJob demo/nightly on dev-a.",
        "Its 2 Jobs and their 3 pods are deleted too.",
    ]
    selectors = sorted(
        q["labelSelector"]
        for m, p, q in fake.requests
        if (m, p) == ("GET", "/api/v1/namespaces/demo/pods")
    )
    assert selectors == [
        "batch.kubernetes.io/controller-uid in (u-nightly-2)",
        "controller-uid in (u-nightly-1)",
    ]

    # Jobs that can't be read: the cascade is still said, and why it isn't counted.
    env.fakes["dev-b"].objects["cronjobs.batch"][("demo", "nightly")] = {
        "metadata": {"name": "nightly", "namespace": "demo", "uid": "u-cj"}
    }
    env.fakes["dev-b"].forbidden_kinds.add("jobs.batch")
    r = await plan(env, "delete", cluster="dev-b", kind_key="cronjobs.batch", name="nightly")
    assert r.json()["summary"] == [
        "Delete CronJob demo/nightly on dev-b.",
        "Its Jobs and their pods are deleted too.",
    ]
    [warning] = r.json()["warnings"]
    assert warning.startswith("Not allowed to count the Jobs of CronJob nightly:")

    # A CRD: every object of its kind, cluster-wide.
    widgets = fake.objects["widgets.example.omnikrux.dev"]
    for ns, name in (("demo", "sprocket"), ("demo", "gear"), ("other", "cog")):
        widgets[(ns, name)] = {"metadata": {"name": name, "namespace": ns, "uid": f"u-{name}"}}
    r = await plan(
        env, "delete", kind_key=CRDS_KEY, namespace=None, name="widgets.example.omnikrux.dev"
    )
    assert r.status_code == 200, r.text
    assert r.json()["summary"] == [
        "Delete CustomResourceDefinition widgets.example.omnikrux.dev on dev-a.",
        "Every Widget object on dev-a is deleted too (3 now).",
    ]
    assert r.json()["confirm_text"] == "widgets.example.omnikrux.dev"

    # A PVC whose volume is deleted with it, and one whose volume is kept.
    pvs = fake.objects["persistentvolumes"]
    pvcs = fake.objects["persistentvolumeclaims"]
    for pv, policy in (("pv-gone", "Delete"), ("pv-kept", "Retain")):
        pvs[("", pv)] = {
            "metadata": {"name": pv, "uid": f"u-{pv}"},
            "spec": {"persistentVolumeReclaimPolicy": policy},
        }
        claim = pv.removeprefix("pv-")
        pvcs[("demo", claim)] = {
            "metadata": {"name": claim, "namespace": "demo", "uid": f"u-{claim}"},
            "spec": {"volumeName": pv},
        }
    r = await plan(env, "delete", kind_key="persistentvolumeclaims", name="gone")
    assert r.json()["summary"] == [
        "Delete PersistentVolumeClaim demo/gone on dev-a.",
        "Its volume pv-gone is deleted too, and its data with it.",
    ]
    r = await plan(env, "delete", kind_key="persistentvolumeclaims", name="kept")
    assert r.json()["summary"] == ["Delete PersistentVolumeClaim demo/kept on dev-a."]

    # A ReplicaSet its Deployment replaces.
    fake.objects["replicasets.apps"][("demo", "web-abc")] = {
        "metadata": {
            "name": "web-abc",
            "namespace": "demo",
            "uid": "u-rs",
            "ownerReferences": [
                {
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "name": "web",
                    "uid": "u-web",
                    "controller": True,
                }
            ],
        },
        "spec": {"selector": {"matchLabels": {"app": "web"}}},
    }
    r = await plan(env, "delete", kind_key="replicasets.apps", name="web-abc")
    assert r.json()["summary"] == [
        "Delete ReplicaSet demo/web-abc on dev-a.",
        "Deployment web creates a new ReplicaSet and pods.",
    ]

    # A node: the pods on it.
    fake.objects["nodes"][("", "worker")] = {"metadata": {"name": "worker", "uid": "u-n"}}
    for name, node in (("on-1", "worker"), ("on-2", "worker"), ("off-1", "other")):
        fake.pods[("demo", name)] = pod(name) | {"spec": {"nodeName": node}}
    r = await plan(env, "delete", kind_key="nodes", namespace=None, name="worker")
    assert r.json()["summary"] == [
        "Delete Node worker on dev-a.",
        "Its 2 pods are removed once the node is gone.",
    ]


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


async def test_delete_plan_cannot_retarget_a_replaced_selected_pod(env):
    fake = env.fakes["dev-a"]
    fake.pods[("demo", "selected")] = pod("selected", uid="new-uid")
    rejected = await plan(
        env, "delete", kind_key="pods", name="selected", params={"expected_uid": "old-uid"}
    )
    assert rejected.status_code == 409
    assert "Select it again" in rejected.json()["detail"]
    assert fake.pods[("demo", "selected")]["metadata"]["uid"] == "new-uid"

    reviewed = await plan(
        env, "delete", kind_key="pods", name="selected", params={"expected_uid": "new-uid"}
    )
    assert reviewed.status_code == 200


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


async def test_open_delete_reviews_are_limited_like_the_bulk_selection(env):
    """The browser selects at most 50 resources to delete; the server holds the same line."""
    fake = env.fakes["dev-a"]
    fake.pods[("demo", "selected")] = pod("selected", uid="u-selected")
    reviews = []
    for _ in range(MAX_OPEN_DELETE_PLANS):
        r = await plan(env, "delete", kind_key="pods", name="selected")
        assert r.status_code == 200, r.text
        reviews.append(r.json()["plan_id"])
    gets = len(fake.requests)
    refused = await plan(env, "delete", kind_key="pods", name="selected")
    assert refused.status_code == 429
    assert refused.json()["detail"] == OPEN_DELETES_LIMIT
    assert len(fake.requests) == gets  # refused before the cluster is asked
    # Another action isn't counted, and a closed review frees its place.
    assert (await plan(env, "scale", params={"replicas": 2})).status_code == 200
    assert (await env.client.delete(f"/api/actions/{reviews[0]}")).status_code == 204
    assert (await plan(env, "delete", kind_key="pods", name="selected")).status_code == 200
    assert (await apply(env, reviews[0], {"confirm_text": "selected"})).status_code == 404

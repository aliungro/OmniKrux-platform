"""Cordon, uncordon and drain through the action pipeline, against fake Kubernetes APIs.

Cordon and uncordon are JSON patches guarded by the node's uid. A drain's plan lists the node's
pods and says what happens to each (DaemonSet, mirror and finished pods stay; pods without a
controller, and pods with emptyDir data, need the user's say-so); its apply cordons the node and
starts a job that evicts the reviewed pods, retrying those a PodDisruptionBudget protects, until
they are gone or its time is up. The job finishes the audit record."""

import asyncio
import math
from json import JSONDecodeError

import pytest
from aiohttp import web

from omnikrux.actions import nodes
from omnikrux.actions.jobs import Job
from omnikrux.actions.nodes import classify_pods
from tests.actions.clusters import apply, plan, records
from tests.fakekube import FakeResource

JSON_PATCH = "application/json-patch+json"
NODE_PATH = "/api/v1/nodes/worker"
UNMANAGED = "1 pods aren't managed by a controller and won't be recreated: demo/bare."
EMPTYDIR = "1 pods keep data in emptyDir volumes, which is lost: demo/cache-1."
CANCELLED = "Drain cancelled. worker stays cordoned; uncordon it to schedule pods there again."


def node(name: str = "worker", *, uid: str = "u-worker", unschedulable: bool = False) -> dict:
    spec: dict = {"podCIDR": "10.244.1.0/24"}
    if unschedulable:
        spec["unschedulable"] = True
    return {
        "apiVersion": "v1",
        "kind": "Node",
        "metadata": {"name": name, "uid": uid, "resourceVersion": "5", "labels": {"a": "b"}},
        "spec": spec,
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }


def pod(
    name: str,
    *,
    ns: str = "demo",
    on: str = "worker",
    owner: str | None = "ReplicaSet",
    phase: str = "Running",
    emptydir: bool = False,
    mirror: bool = False,
    labels: dict | None = None,
) -> dict:
    md: dict = {"name": name, "namespace": ns, "uid": f"u-{name}", "labels": labels or {}}
    if owner is not None:
        md["ownerReferences"] = [
            {"apiVersion": "apps/v1", "kind": owner, "name": f"{name}-owner", "controller": True}
        ]
    if mirror:
        md["annotations"] = {"kubernetes.io/config.mirror": "abc"}
    volumes = [{"name": "cache", "emptyDir": {}}] if emptydir else []
    volumes.append({"name": "token", "projected": {"sources": []}})
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": md,
        "spec": {"nodeName": on, "containers": [{"name": "c"}], "volumes": volumes},
        "status": {"phase": phase},
    }


def seed(env, *pods: dict, cluster: str = "dev-a", **node_kwargs) -> None:
    fake = env.fakes[cluster]
    fake.objects["nodes"][("", "worker")] = node(**node_kwargs)
    fake.pods.clear()
    for p in pods:
        fake.pods[(p["metadata"]["namespace"], p["metadata"]["name"])] = p


def seed_mixed(env) -> None:
    """Pods of every class on worker, and one on another node."""
    seed(
        env,
        pod("web-1"),
        pod("kindnet-x", ns="kube-system", owner="DaemonSet"),
        pod("kube-proxy-x", ns="kube-system", owner="DaemonSet"),
        pod("etcd-worker", ns="kube-system", owner="Node", mirror=True),
        pod("job-done", owner="Job", phase="Succeeded"),
        pod("bare", owner=None),
        pod("cache-1", emptydir=True),
        pod("elsewhere", on="control-plane"),
    )


def live_node(env, cluster: str = "dev-a") -> dict:
    return env.fakes[cluster].objects["nodes"][("", "worker")]


def node_patches(env, cluster: str = "dev-a") -> list[dict]:
    return [w for w in env.fakes[cluster].writes if w["path"] == NODE_PATH]


async def plan_node(env, action: str, params: dict | None = None, cluster: str = "dev-a"):
    return await plan(
        env, action, cluster=cluster, params=params, kind_key="nodes", namespace=None, name="worker"
    )


async def job(env, job_id: str) -> dict:
    r = await env.client.get(f"/api/actions/jobs/{job_id}")
    assert r.status_code == 200, r.text
    return r.json()


async def wait_job(env, job_id: str, until, timeout: float = 5.0) -> dict:
    """Poll the job, as the browser does, until `until(job)` holds."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        current = await job(env, job_id)
        if until(current):
            return current
        assert asyncio.get_running_loop().time() < deadline, current
        await asyncio.sleep(0.01)


def finished(current: dict) -> bool:
    return current["state"] != "running"


async def start_drain(env, params: dict | None = None) -> dict:
    r = await plan_node(env, "drain", params)
    assert r.status_code == 200, r.text
    assert r.json()["blocked"] == [], r.json()
    r = await apply(env, r.json()["plan_id"], {"confirm_text": "worker"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    """Retries and polls in milliseconds instead of seconds."""
    monkeypatch.setattr(nodes, "RETRY_SECONDS", 0.01)
    monkeypatch.setattr(nodes, "POLL_SECONDS", 0.01)


# --- cordon and uncordon ------------------------------------------------------------------


async def test_cordon_uncordon_patch(env):
    seed(env)

    r = await plan_node(env, "cordon")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Cordon worker"
    assert body["summary"] == ["Stop scheduling new pods on worker."]
    assert (body["apply_label"], body["confirm_text"], body["blocked"]) == ("Cordon", None, [])
    assert "unschedulable" not in body["diff"]["before"]
    assert "unschedulable: true" in body["diff"]["after"]

    r = await apply(env, body["plan_id"])
    assert r.status_code == 200, r.text
    assert r.json()["message"] == "Cordoned worker."
    [patch] = node_patches(env)
    assert patch["method"] == "PATCH" and patch["content_type"] == JSON_PATCH
    assert patch["body"] == [
        {"op": "test", "path": "/metadata/uid", "value": "u-worker"},
        {"op": "add", "path": "/spec/unschedulable", "value": True},
    ]
    assert live_node(env)["spec"]["unschedulable"] is True

    # Cordoning a cordoned node changes nothing.
    r = await plan_node(env, "cordon")
    assert r.json()["blocked"] == ["Nothing changes: worker is already cordoned."]

    r = await plan_node(env, "uncordon")
    body = r.json()
    assert body["title"] == "Uncordon worker"
    assert body["summary"] == ["Allow new pods on worker again."]
    assert body["apply_label"] == "Uncordon"
    assert "unschedulable: true" in body["diff"]["before"]
    assert "unschedulable" not in body["diff"]["after"]
    r = await apply(env, body["plan_id"])
    assert r.status_code == 200 and r.json()["message"] == "Uncordoned worker."
    assert node_patches(env)[-1]["body"] == [
        {"op": "test", "path": "/metadata/uid", "value": "u-worker"},
        {"op": "add", "path": "/spec/unschedulable", "value": False},
    ]
    assert live_node(env)["spec"]["unschedulable"] is False

    r = await plan_node(env, "uncordon")
    assert r.json()["blocked"] == ["Nothing changes: worker already allows new pods."]

    actions = [(rec.action, rec.outcome, rec.kind, rec.name) for rec in await records(env)]
    assert actions == [
        ("uncordon", "succeeded", "nodes", "worker"),
        ("cordon", "succeeded", "nodes", "worker"),
    ]


async def test_cordon_conflict_when_node_recreated(env):
    seed(env)
    r = await plan_node(env, "cordon")
    env.fakes["dev-a"].objects["nodes"][("", "worker")] = node(uid="u-worker-2")

    r = await apply(env, r.json()["plan_id"])

    assert r.status_code == 409
    assert r.json() == {
        "detail": "Node worker changed since you reviewed this change. Review it again."
    }
    assert "unschedulable" not in live_node(env)["spec"]


async def test_cordon_and_drain_only_for_nodes(env):
    for action in ("cordon", "uncordon", "drain"):
        r = await plan(env, action)  # deployment demo/web
        assert r.status_code == 422


# --- drain: the plan ----------------------------------------------------------------------


def names(pods: list[dict]) -> list[str]:
    return sorted(f"{p['metadata']['namespace']}/{p['metadata']['name']}" for p in pods)


def test_classify_pods():
    drain = classify_pods(
        [
            pod("web-1"),
            pod("kindnet-x", ns="kube-system", owner="DaemonSet"),
            pod("etcd-worker", ns="kube-system", owner="Node", mirror=True),
            pod("mirror-ds", ns="kube-system", owner="DaemonSet", mirror=True),
            pod("job-done", owner="Job", phase="Succeeded"),
            pod("job-failed", owner="Job", phase="Failed"),
            pod("bare-done", owner=None, phase="Succeeded"),
            pod("bare", owner=None),
            pod("cache-1", emptydir=True),
            pod("bare-cache", owner=None, emptydir=True),
            pod("ds-cache", ns="kube-system", owner="DaemonSet", emptydir=True),
        ]
    )
    assert names(drain.evict) == ["demo/bare", "demo/bare-cache", "demo/cache-1", "demo/web-1"]
    assert names(drain.daemonset) == ["kube-system/ds-cache", "kube-system/kindnet-x"]
    assert names(drain.mirror) == ["kube-system/etcd-worker", "kube-system/mirror-ds"]
    assert names(drain.finished) == ["demo/bare-done", "demo/job-done", "demo/job-failed"]
    assert names(drain.unmanaged) == ["demo/bare", "demo/bare-cache"]
    assert names(drain.emptydir) == ["demo/bare-cache", "demo/cache-1"]


async def test_drain_plan_classifies_pods(env):
    seed_mixed(env)

    r = await plan_node(env, "drain")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Drain worker"
    assert body["apply_label"] == "Drain"
    assert body["confirm_text"] == "worker"  # nodes are typed
    assert body["summary"] == [
        "Cordon worker, then evict 3 pods. 2 DaemonSet pods stay.",
        "demo/bare",
        "demo/cache-1",
        "demo/web-1",
    ]
    assert body["blocked"] == [UNMANAGED, EMPTYDIR]
    assert body["warnings"] == []
    listed = [q for m, p, q in env.fakes["dev-a"].requests if (m, p) == ("GET", "/api/v1/pods")]
    assert listed == [{"fieldSelector": "spec.nodeName=worker"}]

    # With the user's say-so the same effects are listed, as warnings.
    r = await plan_node(env, "drain", {"force": True, "delete_emptydir_data": True})
    body = r.json()
    assert body["blocked"] == [] and body["warnings"] == [UNMANAGED, EMPTYDIR]
    assert body["summary"][0] == "Cordon worker, then evict 3 pods. 2 DaemonSet pods stay."

    r = await plan_node(env, "drain", {"force": True})
    assert r.json()["blocked"] == [EMPTYDIR] and r.json()["warnings"] == [UNMANAGED]


async def test_drain_plan_refuses_bad_params(env):
    seed(env)
    for params in (
        {"force": "yes"},
        {"delete_emptydir_data": 1},
        {"timeout_s": 0},
        {"timeout_s": 3601},
        {"timeout_s": 1.5},
        {"timeout_s": True},
    ):
        r = await plan_node(env, "drain", params)
        assert r.status_code == 422, params
        assert r.json() == {
            "detail": "Drain options: force and delete_emptydir_data are true or false, "
            "timeout_s is a whole number of seconds from 1 to 3600."
        }


async def test_drain_plan_warns_about_pod_disruption_budgets(env):
    fake = env.fakes["dev-a"]
    seed(
        env,
        pod("guarded-1", labels={"app": "guarded"}),
        pod("web-1", labels={"app": "web"}),
        pod("web-2", labels={"app": "web"}),
    )

    # A cluster that doesn't serve policy/v1 has nothing to warn about.
    r = await plan_node(env, "drain")
    assert r.json()["warnings"] == []

    fake.resources.append(
        FakeResource("policy", "v1", "poddisruptionbudgets", "PodDisruptionBudget", True)
    )

    def pdb(name: str, selector: dict | None, allowed: int, ns: str = "demo") -> dict:
        return {
            "metadata": {"name": name, "namespace": ns, "uid": f"u-{name}"},
            "spec": {"selector": selector, "minAvailable": 1},
            "status": {"disruptionsAllowed": allowed},
        }

    store = fake.objects["poddisruptionbudgets.policy"]
    store[("demo", "guarded")] = pdb("guarded", {"matchLabels": {"app": "guarded"}}, 0)
    expressions = {"matchExpressions": [{"key": "app", "operator": "In", "values": ["web"]}]}
    store[("demo", "web")] = pdb("web", expressions, 1)
    store[("demo", "roomy")] = pdb("roomy", {"matchLabels": {"app": "web"}}, 5)
    store[("other", "elsewhere")] = pdb("elsewhere", {"matchLabels": {"app": "web"}}, 0, "other")
    store[("demo", "none")] = pdb("none", None, 0)  # a null selector selects nothing

    r = await plan_node(env, "drain", {"timeout_s": 90})

    none_allowed = (
        "PodDisruptionBudget demo/guarded allows no evictions right now: demo/guarded-1 waits "
        "until it does, for up to 1 min 30 s."
    )
    one_allowed = (
        "PodDisruptionBudget demo/web allows 1 of demo/web-1, demo/web-2 to be evicted at once: "
        "the others wait for replacements, for up to 1 min 30 s."
    )
    assert r.json()["warnings"] == [none_allowed, one_allowed]


# --- drain: the apply and its job ---------------------------------------------------------


async def test_drain_refuses_blocked_without_flags(env):
    seed_mixed(env)
    r = await plan_node(env, "drain")

    r = await apply(env, r.json()["plan_id"], {"confirm_text": "worker"})

    assert r.status_code == 422
    assert r.json() == {"detail": f"{UNMANAGED} {EMPTYDIR}"}
    fake = env.fakes["dev-a"]
    assert fake.eviction_requests == [] and node_patches(env) == []
    assert await records(env) == []


async def test_drain_evicts_and_waits(env):
    fake = env.fakes["dev-a"]
    many = [pod(f"web-{i}") for i in range(7)]
    seed(env, *many, pod("kindnet-x", ns="kube-system", owner="DaemonSet"))
    fake.linger.add(("demo", "web-6"))  # still terminating after its eviction
    fake.eviction_delay = 0.05

    started = await start_drain(env)

    assert started["outcome"] == "started" and started["job_id"]
    assert started["message"] == "Cordoned worker; evicting 7 pods."
    assert node_patches(env)[0]["body"] == [
        {"op": "test", "path": "/metadata/uid", "value": "u-worker"},
        {"op": "add", "path": "/spec/unschedulable", "value": True},
    ]
    current = await wait_job(env, started["job_id"], lambda j: j["done"] == 6)
    assert current["state"] == "running" and current["total"] == 7
    assert current["action"] == "drain" and current["blocked"] == []
    await asyncio.sleep(0.05)
    assert (await job(env, started["job_id"]))["state"] == "running"  # web-6 isn't gone yet
    [record] = await records(env)
    assert record.outcome == "started"

    del fake.pods[("demo", "web-6")]
    current = await wait_job(env, started["job_id"], finished)

    assert current["state"] == "succeeded" and current["done"] == 7
    assert current["message"] == "Drained worker: 7 pods evicted. worker stays cordoned."
    assert current["finished_at"] is not None
    assert fake.evictions_in_flight_max == 5  # at most 5 at a time
    first = fake.eviction_requests[0]
    assert first["body"] == {
        "apiVersion": "policy/v1",
        "kind": "Eviction",
        "metadata": {"name": first["pod"][1], "namespace": "demo"},
        "deleteOptions": {"preconditions": {"uid": f"u-{first['pod'][1]}"}},
    }
    evicted = sorted(r["pod"][1] for r in fake.eviction_requests)
    assert evicted == [f"web-{i}" for i in range(7)]  # never the DaemonSet pod
    assert ("kube-system", "kindnet-x") in fake.pods
    assert live_node(env)["spec"]["unschedulable"] is True
    [record] = await records(env)
    assert (record.action, record.outcome) == ("drain", "succeeded")
    assert record.message == current["message"]


async def test_drain_evicts_only_the_reviewed_pods(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("web-1"), pod("web-2"))
    r = await plan_node(env, "drain")
    # After the review: web-2 is re-created (a new uid) and web-3 arrives.
    fake.pods[("demo", "web-2")] = pod("web-2") | {
        "metadata": {"name": "web-2", "namespace": "demo", "uid": "u-new"}
    }
    fake.pods[("demo", "web-3")] = pod("web-3")

    r = await apply(env, r.json()["plan_id"], {"confirm_text": "worker"})
    current = await wait_job(env, r.json()["job_id"], finished)

    assert current["state"] == "succeeded" and current["done"] == 2
    assert ("demo", "web-2") in fake.pods and ("demo", "web-3") in fake.pods
    assert sorted(r["pod"][1] for r in fake.eviction_requests) == ["web-1", "web-2"]
    # The outcome tells evicted from already gone, and names what it left alone.
    assert current["message"] == (
        "Drained worker: 1 pods evicted. 1 pods were already gone. "
        "2 pods on worker weren't in the review and stay: demo/web-2, demo/web-3. "
        "worker stays cordoned."
    )


async def test_drain_waits_with_one_list_per_poll(env, monkeypatch):
    """Polling must cost one request per node, rather than one per terminating pod."""
    monkeypatch.setattr(nodes, "POLL_SECONDS", 0.2)
    fake = env.fakes["dev-a"]
    seed(env, *(pod(f"web-{i}") for i in range(20)))
    keys = list(fake.pods)
    fake.linger.update(keys)
    started = await start_drain(env)
    await wait_job(env, started["job_id"], lambda j: len(fake.deleted) == 20)
    fake.requests.clear()
    for batch in (keys[:7], keys[7:14], keys[14:]):
        await asyncio.sleep(1)
        assert (await job(env, started["job_id"]))["state"] == "running"
        for key in batch:
            del fake.pods[key]
    current = await wait_job(env, started["job_id"], finished)
    assert current["state"] == "succeeded" and current["done"] == 20
    lists = [q for m, p, q in fake.requests if (m, p) == ("GET", "/api/v1/pods")]
    assert 1 <= len(lists) <= math.ceil(3 / nodes.POLL_SECONDS) + 3
    assert all(q == {"fieldSelector": "spec.nodeName=worker"} for q in lists)
    assert not [
        p
        for m, p, _ in fake.requests
        if m == "GET" and p.startswith("/api/v1/namespaces/demo/pods/")
    ]


async def test_drain_gone_by_uid_when_name_reused(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("web-1"))
    fake.linger.add(("demo", "web-1"))
    started = await start_drain(env)
    await wait_job(env, started["job_id"], lambda j: fake.deleted)
    replacement = pod("web-1")
    replacement["metadata"]["uid"] = "u-replacement"
    fake.pods[("demo", "web-1")] = replacement
    current = await wait_job(env, started["job_id"], finished)
    assert current["state"] == "succeeded" and current["done"] == 1
    assert current["message"] == (
        "Drained worker: 1 pods evicted. "
        "1 pods on worker weren't in the review and stay: demo/web-1. worker stays cordoned."
    )


@pytest.mark.parametrize("times, state", [(2, "succeeded"), (200, "failed")])
async def test_drain_list_failure_keeps_waiting_and_reports(env, times, state):
    fake = env.fakes["dev-a"]
    seed(env, pod("web-1"))
    fake.linger.add(("demo", "web-1"))
    started = await start_drain(env, {"timeout_s": 1})
    await wait_job(env, started["job_id"], lambda j: fake.deleted)
    fake.fail_lists["/api/v1/pods"] = [500] * times
    del fake.pods[("demo", "web-1")]
    current = await wait_job(env, started["job_id"], finished)
    assert current["state"] == state
    if state == "failed":
        assert "couldn't check that 1 pods left worker (demo/web-1)" in current["message"]
        assert "Couldn't list the pods on worker:" in current["message"]
        assert "ApiException: (500)" in current["message"]
    else:
        assert current["done"] == 1
        assert fake.fail_lists["/api/v1/pods"] == []


async def test_drain_reports_unexpected_node_poll_failure(env, monkeypatch):
    """Malformed successful list responses must reach the job, never masquerade as a timeout."""
    fake = env.fakes["dev-a"]
    seed(env, pod("web-1"), pod("web-2"))
    fake.linger.update(fake.pods)
    original = fake._get

    async def malformed_list(request, match):
        if request.path == "/api/v1/pods":
            return web.Response(text="{broken", content_type="application/json")
        return await original(request, match)

    monkeypatch.setattr(fake, "_get", malformed_list)
    current = Job(id="drain-test", action="drain", actor="test", audit_id=0, cancelled_message="")
    with pytest.raises(JSONDecodeError):
        await asyncio.wait_for(
            nodes.drain_pods(
                current,
                connections=env.app.state.connections,
                cluster_id=env.ids["dev-a"],
                node="worker",
                pods=[
                    {"namespace": "demo", "name": f"web-{i}", "uid": f"u-web-{i}"} for i in (1, 2)
                ],
                timeout_s=0.2,
            ),
            timeout=1,
        )
    assert current.done == 0


async def test_drain_retries_an_eviction_conflict_that_isnt_a_new_pod(env):
    """A 409 that isn't the uid precondition (the API server's own write conflict) is retried,
    never counted as evicted."""
    fake = env.fakes["dev-a"]
    seed(env, pod("web-1"))
    fake.evictions[("demo", "web-1")] = [409, 201]

    started = await start_drain(env)
    current = await wait_job(env, started["job_id"], finished)

    assert current["state"] == "succeeded"
    assert current["message"] == "Drained worker: 1 pods evicted. worker stays cordoned."
    assert len(fake.eviction_requests) == 2 and ("demo", "web-1") not in fake.pods


async def test_drain_timeout_names_why_pods_couldnt_be_checked(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("slow-1"))
    fake.linger.add(("demo", "slow-1"))

    started = await start_drain(env, {"timeout_s": 1})
    await wait_job(env, started["job_id"], lambda j: fake.deleted)
    fake.forbidden_kinds.add("pods")  # reading the pod is refused from now on
    current = await wait_job(env, started["job_id"], finished)

    assert current["state"] == "failed"
    message = current["message"]
    assert message.startswith(
        "Drain stopped after 1 s: Omnikrux couldn't check that 1 pods left worker (demo/slow-1): "
        "Not allowed to list the pods on worker: pods is forbidden"
    )
    assert message.endswith(" worker stays cordoned.")


async def test_drain_says_the_node_stays_cordoned_when_the_job_cant_start(env, monkeypatch):
    seed(env, pod("web-1"))
    jobs = env.app.state.jobs

    def refuse(*args, **kwargs):
        raise RuntimeError("the job runner is closed")

    monkeypatch.setattr(jobs, "start", refuse)
    r = await plan_node(env, "drain")
    r = await apply(env, r.json()["plan_id"], {"confirm_text": "worker"})

    assert r.status_code == 503
    assert r.json() == {
        "detail": "The drain couldn't start: the console is stopping. worker stays cordoned; "
        "uncordon it, or drain it again once the console is back."
    }
    assert live_node(env)["spec"]["unschedulable"] is True
    [record] = await records(env)
    assert (record.outcome, record.message) == ("failed", r.json()["detail"])

    # A runner that is already closed: refused before the node is cordoned.
    monkeypatch.undo()
    seed(env, pod("web-1"))
    await jobs.close()
    r = await plan_node(env, "drain")
    r = await apply(env, r.json()["plan_id"], {"confirm_text": "worker"})
    assert r.status_code == 503
    assert r.json() == {
        "detail": "Drains can't run right now: the console is stopping. Try again once it's back."
    }
    assert "unschedulable" not in live_node(env)["spec"]


async def test_drain_retries_pdb_429_then_succeeds(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("guarded-1"), pod("web-1"))
    fake.evictions[("demo", "guarded-1")] = [429]  # until the test lets it go

    started = await start_drain(env)
    current = await wait_job(env, started["job_id"], lambda j: j["blocked"] and j["done"] == 1)

    assert current["state"] == "running"
    assert current["blocked"] == [
        {
            "namespace": "demo",
            "name": "guarded-1",
            "message": "Cannot evict pod as it would violate the pod's disruption budget.",
        }
    ]
    fake.evictions[("demo", "guarded-1")] = [201]
    current = await wait_job(env, started["job_id"], finished)

    assert current["state"] == "succeeded" and current["blocked"] == []
    assert current["done"] == 2
    retried = [r for r in fake.eviction_requests if r["pod"] == ("demo", "guarded-1")]
    assert len(retried) >= 2  # refused at least once, then evicted
    [record] = await records(env)
    assert record.outcome == "succeeded"


async def test_drain_stops_on_pdb_timeout_and_says_which_pods(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("guarded-1"), pod("guarded-2"), pod("web-1"))
    fake.evictions[("demo", "guarded-1")] = [429]
    fake.evictions[("demo", "guarded-2")] = [429]

    started = await start_drain(env, {"timeout_s": 1})
    current = await wait_job(env, started["job_id"], finished)

    message = (
        "Drain stopped after 1 s: 2 pods are still protected by a PodDisruptionBudget "
        "(demo/guarded-1, demo/guarded-2). worker stays cordoned."
    )
    assert current["state"] == "failed" and current["message"] == message
    assert current["done"] == 1 and len(current["blocked"]) == 2
    assert ("demo", "web-1") not in fake.pods and ("demo", "guarded-1") in fake.pods
    assert live_node(env)["spec"]["unschedulable"] is True
    [record] = await records(env)
    assert (record.outcome, record.message) == ("failed", message)


async def test_drain_stops_on_timeout_while_pods_terminate(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("slow-1"))
    fake.linger.add(("demo", "slow-1"))

    started = await start_drain(env, {"timeout_s": 1})
    current = await wait_job(env, started["job_id"], finished)

    message = (
        "Drain stopped after 1 s: 1 pods haven't left worker yet (demo/slow-1). "
        "worker stays cordoned."
    )
    assert (current["state"], current["message"]) == ("failed", message)


async def test_drain_stops_when_an_eviction_fails(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("web-1"))
    fake.evictions[("demo", "web-1")] = [500]

    started = await start_drain(env)
    current = await wait_job(env, started["job_id"], finished)

    assert current["state"] == "failed"
    assert current["message"].startswith("Couldn't evict pod demo/web-1:")
    assert current["message"].endswith(" worker stays cordoned.")
    [record] = await records(env)
    assert (record.outcome, record.message) == ("failed", current["message"])


async def test_drain_conflict_when_node_recreated(env):
    seed(env, pod("web-1"))
    r = await plan_node(env, "drain")
    env.fakes["dev-a"].objects["nodes"][("", "worker")] = node(uid="u-worker-2")

    r = await apply(env, r.json()["plan_id"], {"confirm_text": "worker"})

    assert r.status_code == 409
    assert env.fakes["dev-a"].eviction_requests == []
    [record] = await records(env)
    assert record.outcome == "failed"


async def test_drain_cancel_leaves_node_cordoned_and_audits(env):
    fake = env.fakes["dev-a"]
    seed(env, pod("guarded-1"), pod("web-1"))
    fake.evictions[("demo", "guarded-1")] = [429]

    started = await start_drain(env)
    job_id = started["job_id"]
    await wait_job(env, job_id, lambda j: j["blocked"] and j["done"] == 1)

    r = await env.client.post(f"/api/actions/jobs/{job_id}/cancel")

    assert r.status_code == 200, r.text
    assert r.json()["state"] == "cancelled" and r.json()["message"] == CANCELLED
    assert r.json()["finished_at"] is not None
    assert (await job(env, job_id))["state"] == "cancelled"
    tries = len(fake.eviction_requests)
    await asyncio.sleep(0.05)
    assert len(fake.eviction_requests) == tries  # nothing more is evicted
    assert live_node(env)["spec"]["unschedulable"] is True
    [record] = await records(env)
    assert (record.action, record.outcome, record.message) == ("drain", "failed", CANCELLED)

    # Cancelling again changes nothing; unknown jobs are a plain 404.
    r = await env.client.post(f"/api/actions/jobs/{job_id}/cancel")
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    r = await env.client.post("/api/actions/jobs/nope/cancel")
    assert r.status_code == 404
    r = await env.client.get("/api/actions/jobs/nope")
    assert r.status_code == 404

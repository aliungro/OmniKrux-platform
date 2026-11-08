"""Operations against the real kind cluster `omnikrux-dev` (scripts/dev-kind.sh --recreate):
kinds, watches, metrics, the action pipeline (scale, restart, rollback, edit, delete, drain),
secret reveal and port-forwards, through the real app in-process.

Everything that changes the cluster stays in the `demo` namespace; the drain test is the only
one that touches a node (the labelled worker) and runs last."""

import base64
import json
import subprocess
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager

import pytest

from tests.e2e.support import Reader, kubectl, wait_for
from tests.kube.test_source_kind import CONTEXT, REPO

pytestmark = pytest.mark.kind

WIDGETS = "widgets.example.omnikrux.dev"
WORKLOADS = REPO / "scripts" / "fixtures" / "workloads.yaml"
WORKER_SELECTOR = "omnikrux.dev/drain-test=true"
SECRET = "s3cr3t-omnikrux"
TEMPLATE_ANNOTATIONS = "jsonpath={.spec.template.metadata.annotations}"


# --- helpers ------------------------------------------------------------------------------


def api_path(cluster: str, tail: str) -> str:
    return f"/api/clusters/{cluster}/{tail}"


def snapshot_rows(client, kind: str, timeout: float = 60.0) -> list[dict]:
    """Every row of the first complete snapshot the watch of `kind` sends."""
    with client.websocket_connect(f"/api/watch?kind={kind}") as ws:
        messages = Reader(ws).until(
            lambda m: m["type"] == "closed" or (m["type"] == "snapshot" and m["last"]),
            f"the {kind} snapshot",
            timeout,
        )
    assert messages[-1]["type"] == "snapshot", messages[-3:]
    return [row for m in messages if m["type"] == "snapshot" for row in m["rows"]]


def plan_request(cluster: str, action: str, kind_key: str, name: str, ns, params: dict) -> dict:
    target = {"cluster_id": cluster, "kind_key": kind_key, "namespace": ns, "name": name}
    return {"action": action, "target": target, "params": params}


def plan(client, cluster: str, action: str, kind_key: str, name: str, ns=None, **params) -> dict:
    response = client.post(
        "/api/actions/plan", json=plan_request(cluster, action, kind_key, name, ns, params)
    )
    assert response.status_code == 200, response.text
    return response.json()


def apply_plan(client, planned: dict):
    body = {"confirm_text": planned["confirm_text"]}
    return client.post(f"/api/actions/{planned['plan_id']}/apply", json=body)


def audit_records(client, action: str, name: str) -> list[dict]:
    page = client.get("/api/audit", params={"action": action, "q": name, "limit": 50}).json()
    return [r for r in page["records"] if r["name"] == name]


def deployment_ready(namespace: str, name: str, replicas: int) -> bool:
    """Exactly `replicas` pods, all of them ready and of the latest template, no extra ones."""
    deployment = json.loads(kubectl("-n", namespace, "get", "deployment", name, "-o", "json"))
    s = deployment["status"]
    return (
        deployment["spec"]["replicas"] == replicas
        and s.get("observedGeneration") == deployment["metadata"]["generation"]
        and s.get("replicas", 0) == replicas
        and s.get("updatedReplicas", 0) == replicas
        and s.get("readyReplicas", 0) == replicas
    )


def wait_ready(name: str, replicas: int, timeout: float = 120.0, namespace: str = "demo") -> None:
    wait_for(
        lambda: deployment_ready(namespace, name, replicas),
        f"deployment {name} to have {replicas} ready replicas",
        timeout=timeout,
    )


@contextmanager
def throwaway_deployment(name: str, command: list[str]) -> Iterator[None]:
    manifest = {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": name, "namespace": "demo"},
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {"labels": {"app": name}},
                "spec": {
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{"name": "c", "image": "busybox:1.36", "command": command}],
                },
            },
        },
    }
    done = subprocess.run(
        ["kubectl", "--context", CONTEXT, "apply", "-f", "-"],
        input=json.dumps(manifest),
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    try:
        yield
    finally:
        kubectl("-n", "demo", "delete", "deployment", name, "--ignore-not-found", "--wait=false")


def set_replicas(count: int) -> None:
    kubectl("-n", "demo", "scale", "deployment", "web", f"--replicas={count}")


# --- kinds and watches --------------------------------------------------------------------


def test_kinds_include_builtins_and_widget_crd(client, cluster):
    body = client.get("/api/kinds", params={"refresh": "true"}).json()
    by_key = {k["key"]: k for k in body["kinds"]}
    for key in ("pods", "deployments.apps", "nodes", "services", "configmaps", "secrets"):
        assert key in by_key, sorted(by_key)
    widget = by_key[WIDGETS]
    assert widget["kind"] == "Widget" and widget["namespaced"] is True
    assert widget["builtin"] is False and widget["clusters"] == [cluster]
    assert body["clusters"][cluster]["state"] == "ok", body["clusters"]
    assert "pc_size" in [c["key"] for c in widget["columns"]], widget["columns"]


def test_widget_rows_show_printer_column(client, cluster):
    rows = snapshot_rows(client, WIDGETS)
    sprocket = next(r for r in rows if r["name"] == "sprocket")
    assert sprocket["namespace"] == "demo" and sprocket["kind"] == "Widget"
    assert str(sprocket["columns"]["pc_size"]) == "3"


def test_nodes_and_events_watch_rows(client, cluster):
    nodes = {r["name"]: r for r in snapshot_rows(client, "nodes")}
    listed = set(kubectl("get", "nodes", "-o", "jsonpath={.items[*].metadata.name}").split())
    assert len(listed) == 2 and set(nodes) == listed
    assert all(r["columns"]["status"] == "Ready" for r in nodes.values()), nodes
    events = snapshot_rows(client, "events")
    # crasher, oom and stuck keep producing events in demo.
    assert any(r["namespace"] == "demo" for r in events), events[:3]


# --- metrics ------------------------------------------------------------------------------


def test_pod_and_node_metrics_live(client, cluster):
    # metrics-server needs a minute or two after a cluster is created before it answers.
    def pods_live():
        answer = client.get("/api/metrics/pods").json()["clusters"][cluster]
        if answer["state"] != "ok":
            return None
        return answer["items"] if any(k.startswith("demo/web-") for k in answer["items"]) else None

    items = wait_for(pods_live, "pod metrics for the web pods", timeout=150, interval=3)
    usage = next(v for k, v in items.items() if k.startswith("demo/web-"))
    assert usage["memory_b"] > 0 and usage["window_s"] > 0 and usage["stale"] is False

    def nodes_live():
        answer = client.get("/api/metrics/nodes").json()["clusters"][cluster]
        return answer if answer["state"] == "ok" and len(answer["items"]) == 2 else None

    nodes = wait_for(nodes_live, "metrics for both nodes", timeout=60, interval=3)
    assert all(v["cpu_m"] >= 0 and v["memory_b"] > 0 for v in nodes["items"].values())

    pod = kubectl(
        "-n", "demo", "get", "pods", "-l", "app=web", "--field-selector=status.phase=Running",
        "-o", "jsonpath={.items[0].metadata.name}",
    )  # fmt: skip

    def pod_live():
        body = client.get(api_path(cluster, f"pods/demo/{pod}/metrics")).json()
        return body if body["state"] == "ok" else None

    one = wait_for(pod_live, f"metrics for pod {pod}", timeout=60, interval=3)
    assert one["containers"][0]["name"] == "nginx" and one["containers"][0]["memory_b"] > 0

    node = min(nodes["items"])
    node_body = client.get(api_path(cluster, f"nodes/{node}/metrics")).json()
    assert node_body["state"] == "ok" and node_body["memory_b"] > 0
    assert node_body["allocatable_cpu_m"] and node_body["capacity_memory_b"]


# --- scale, restart, rollback -------------------------------------------------------------


def test_scale_web_to_3_and_back_audited(client, cluster):
    wait_ready("web", 2)
    try:
        for replicas in (3, 2):
            planned = plan(
                client, cluster, "scale", "deployments.apps", "web", "demo", replicas=replicas
            )
            assert planned["blocked"] == [] and planned["confirm_text"] is None
            response = apply_plan(client, planned)
            assert response.status_code == 200, response.text
            assert response.json()["outcome"] == "succeeded"
            wait_ready("web", replicas)
    finally:
        set_replicas(2)
    records = audit_records(client, "scale", "web")  # newest first: back to 2, then up to 3
    assert [r["outcome"] for r in records[:2]] == ["succeeded", "succeeded"]
    assert all(r["finished_at"] and r["cluster_id"] == cluster for r in records[:2])
    assert "replicas: 3" in records[1]["diff"]
    wait_ready("web", 2)


def test_scale_conflict_when_replicas_changed_on_a_real_api_server(client, cluster):
    """R9: a real API server answers a failed JSON-patch `test` with a bare 422 (no cause in the
    Status), so the pipeline checks the live object and answers the conflict copy; nothing changes."""
    wait_ready("web", 2)
    try:
        planned = plan(client, cluster, "scale", "deployments.apps", "web", "demo", replicas=3)
        set_replicas(4)  # moved since the review
        response = apply_plan(client, planned)
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == (
            "Deployment web changed since you reviewed this change. Review it again."
        )
        replicas = kubectl("-n", "demo", "get", "deployment", "web", "-o",
                           "jsonpath={.spec.replicas}")  # fmt: skip
        assert replicas == "4"  # untouched by the refused apply
    finally:
        set_replicas(2)
    assert audit_records(client, "scale", "web")[0]["outcome"] == "failed"
    wait_ready("web", 2)


REMOVE_RESTARTED_AT = json.dumps(
    [
        {
            "op": "remove",
            "path": "/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt",
        }
    ]
)


def clear_restart_annotation() -> None:
    """Whatever the test left: no restartedAt on the template, so a later run starts clean."""
    subprocess.run(
        ["kubectl", "--context", CONTEXT, "-n", "demo", "patch", "deployment", "web",
         "--type=json", "-p", REMOVE_RESTARTED_AT],
        check=False,
        capture_output=True,
        timeout=60,
    )  # fmt: skip


def test_restart_then_rollback_web(client, cluster):
    wait_ready("web", 2)
    assert "restartedAt" not in kubectl(
        "-n", "demo", "get", "deployment", "web", "-o", TEMPLATE_ANNOTATIONS
    )
    try:
        restart_then_rollback(client, cluster)
    finally:
        clear_restart_annotation()
        wait_ready("web", 2)


def restart_then_rollback(client, cluster) -> None:
    planned = plan(client, cluster, "restart", "deployments.apps", "web", "demo")
    response = apply_plan(client, planned)
    assert response.status_code == 200, response.text
    wait_for(
        lambda: (
            "restartedAt"
            in kubectl("-n", "demo", "get", "deployment", "web", "-o", TEMPLATE_ANNOTATIONS)
        ),
        "the restart annotation",
    )
    wait_ready("web", 2)

    planned = plan(client, cluster, "rollback", "deployments.apps", "web", "demo")
    assert planned["blocked"] == [], planned
    response = apply_plan(client, planned)
    assert response.status_code == 200, response.text
    assert "Rolled back" in response.json()["message"]
    assert "restartedAt" not in kubectl(
        "-n", "demo", "get", "deployment", "web", "-o", TEMPLATE_ANNOTATIONS
    )
    wait_ready("web", 2)
    outcomes = {a: audit_records(client, a, "web")[0]["outcome"] for a in ("restart", "rollback")}
    assert outcomes == {"restart": "succeeded", "rollback": "succeeded"}


def test_rollback_keeps_shell_operators_and_non_ascii_in_the_template(client, cluster):
    """R28: a template with `a && b` and non-ASCII is sent back byte for byte."""
    command = ["sh", "-c", "echo 'héllo wörld ✓' && sleep 3600"]
    name = "rollback-me"
    with throwaway_deployment(name, command):
        wait_ready(name, 1, timeout=90)
        # Revision 2 differs only by a template annotation.
        patch = {"spec": {"template": {"metadata": {"annotations": {"omnikrux.dev/rev": "2"}}}}}
        kubectl("-n", "demo", "patch", "deployment", name, "-p", json.dumps(patch))
        wait_ready(name, 1, timeout=90)
        planned = plan(client, cluster, "rollback", "deployments.apps", name, "demo")
        assert planned["blocked"] == [], planned
        response = apply_plan(client, planned)
        assert response.status_code == 200, response.text
        wait_ready(name, 1, timeout=90)
        deployment = json.loads(kubectl("-n", "demo", "get", "deployment", name, "-o", "json"))
        template = deployment["spec"]["template"]
        assert template["spec"]["containers"][0]["command"] == command
        assert "annotations" not in template["metadata"]


# --- edit, delete -------------------------------------------------------------------------


def test_edit_configmap_diff_and_apply(client, cluster):
    url = api_path(cluster, "resources/configmaps/app-config/yaml")
    original = client.get(url, params={"namespace": "demo"}).json()["yaml"]
    assert "greeting: hello" in original
    edited = original.replace("greeting: hello", "greeting: hello from omnikrux")
    try:
        planned = plan(client, cluster, "edit", "configmaps", "app-config", "demo", yaml=edited)
        assert planned["blocked"] == []
        assert "greeting: hello\n" in planned["diff"]["before"]
        assert "greeting: hello from omnikrux" in planned["diff"]["after"]
        response = apply_plan(client, planned)
        assert response.status_code == 200, response.text
        greeting = kubectl("-n", "demo", "get", "configmap", "app-config", "-o",
                           "jsonpath={.data.greeting}")  # fmt: skip
        assert greeting == "hello from omnikrux"
        assert audit_records(client, "edit", "app-config")[0]["outcome"] == "succeeded"
        # The YAML the user edited is stale now: planning the same edit is a conflict.
        body = plan_request(cluster, "edit", "configmaps", "app-config", "demo", {"yaml": edited})
        assert client.post("/api/actions/plan", json=body).status_code == 409
    finally:
        patch = '{"data":{"greeting":"hello"}}'
        kubectl("-n", "demo", "patch", "configmap", "app-config", "-p", patch)


def test_delete_throwaway_configmap_with_uid_precondition(client, cluster):
    uid_of = "jsonpath={.metadata.uid}"
    kubectl("-n", "demo", "create", "configmap", "delete-me", "--from-literal=a=b")
    try:
        # Re-created under the same name after the review: the uid no longer matches.
        stale = plan(client, cluster, "delete", "configmaps", "delete-me", "demo")
        reviewed_uid = kubectl("-n", "demo", "get", "configmap", "delete-me", "-o", uid_of)
        kubectl("-n", "demo", "delete", "configmap", "delete-me")
        kubectl("-n", "demo", "create", "configmap", "delete-me", "--from-literal=a=b")
        new_uid = kubectl("-n", "demo", "get", "configmap", "delete-me", "-o", uid_of)
        assert new_uid != reviewed_uid
        refused = apply_plan(client, stale)
        assert refused.status_code == 409, refused.text
        assert refused.json()["detail"] == (
            "ConfigMap delete-me changed since you reviewed this change. Review it again."
        )
        assert kubectl("-n", "demo", "get", "configmap", "delete-me", "-o", uid_of) == new_uid

        fresh = plan(client, cluster, "delete", "configmaps", "delete-me", "demo")
        response = apply_plan(client, fresh)
        assert response.status_code == 200, response.text
        wait_for(
            lambda: (
                not kubectl(
                    "-n",
                    "demo",
                    "get",
                    "configmap",
                    "delete-me",
                    "--ignore-not-found",
                    "-o",
                    "name",
                ).strip()
            ),
            "delete-me to be gone",
            timeout=30,
        )
        outcomes = [r["outcome"] for r in audit_records(client, "delete", "delete-me")]
        assert outcomes[:2] == ["succeeded", "failed"]
    finally:
        kubectl("-n", "demo", "delete", "configmap", "delete-me", "--ignore-not-found")


# --- secrets, port-forward ----------------------------------------------------------------


def test_secret_yaml_masked_and_reveal_audited(client, cluster):
    url = api_path(cluster, "resources/secrets/db-credentials/yaml")
    text = client.get(url, params={"namespace": "demo"}).json()["yaml"]
    assert f"•••••• ({len(SECRET)} bytes)" in text
    encoded = base64.b64encode(SECRET.encode()).decode()
    assert SECRET not in text and encoded not in text
    assert "last-applied-configuration" not in text  # `kubectl apply` stored the value there
    described = client.get(
        api_path(cluster, "resources/secrets/db-credentials/describe"),
        params={"namespace": "demo"},
    )
    assert described.status_code == 200 and SECRET not in described.text

    reveal = api_path(cluster, "secrets/demo/db-credentials/reveal")
    response = client.post(reveal, json={"key": "password"})
    assert response.status_code == 200, response.text
    assert response.json() == {"key": "password", "value": SECRET, "encoding": "utf-8"}
    assert response.headers["cache-control"] == "no-store"

    missing = client.post(reveal, json={"key": "nope"})
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Secret db-credentials has no key nope."

    page = client.get("/api/audit", params={"limit": 100})
    assert SECRET not in page.text and encoded not in page.text
    reveals = audit_records(client, "secret_reveal", "db-credentials")
    assert [r["outcome"] for r in reveals[:2]] == ["failed", "succeeded"]
    assert reveals[1]["details"] == {"key": "password"}


def fetch(url: str) -> str:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=5) as response:
        return response.read().decode("utf-8")


def test_port_forward_web_service_serves_nginx(client, cluster):
    wait_ready("web", 2)
    body = {
        "cluster_id": cluster,
        "namespace": "demo",
        "kind": "service",
        "name": "web",
        "port": 80,
    }
    response = client.post("/api/port-forwards", json=body)
    assert response.status_code == 200, response.text
    forward = response.json()
    try:
        assert forward["state"] == "listening" and forward["address"].startswith("127.0.0.1:")
        local = f"http://{forward['address']}/"

        def served() -> str | None:
            try:
                return fetch(local)
            except OSError:  # the first connection can race the pod; ask again
                return None

        page = wait_for(served, "nginx through the forward", timeout=30, interval=1)
        assert "Welcome to nginx!" in page
        listed = client.get("/api/port-forwards").json()
        assert [f["id"] for f in listed] == [forward["id"]]
        assert listed[0]["pod"].startswith("web-")
    finally:
        assert client.delete(f"/api/port-forwards/{forward['id']}").status_code == 204
    assert client.get("/api/port-forwards").json() == []
    records = audit_records(client, "port_forward", "web")
    assert records and records[0]["outcome"] == "ended"  # stopped by the user
    assert records[0]["details"]["remote_port"] == 80


# --- drain (last: it cordons the worker and evicts its pods) ------------------------------


def test_drain_worker_evicts_and_reports_pdb_blocked_pod(client, cluster):
    worker = kubectl("get", "nodes", "-l", WORKER_SELECTOR, "-o", "name").split()
    assert len(worker) == 1, "scripts/dev-kind.sh --recreate builds a labelled worker"
    node = worker[0].removeprefix("node/")
    wait_ready("web", 2)
    wait_ready("guarded", 1)
    try:
        planned = plan(
            client, cluster, "drain", "nodes", node, delete_emptydir_data=True, timeout_s=30
        )
        assert planned["blocked"] == [], planned
        assert planned["confirm_text"] == node  # a node is typed to confirm
        assert any(line.startswith("demo/guarded-") for line in planned["summary"]), planned[
            "summary"
        ]
        assert any("PodDisruptionBudget" in w and "guarded" in w for w in planned["warnings"])
        response = apply_plan(client, planned)
        assert response.status_code == 200, response.text
        assert response.json()["outcome"] == "started"
        job_id = response.json()["job_id"]

        seen_blocked: list[str] = []

        def finished():
            job = client.get(f"/api/actions/jobs/{job_id}").json()
            seen_blocked.extend(b["name"] for b in job["blocked"])
            return job if job["state"] != "running" else None

        job = wait_for(finished, "the drain job to end", timeout=90, interval=1)
        assert job["state"] == "failed", job
        assert job["message"].startswith("Drain stopped after 30 s"), job["message"]
        assert "demo/guarded-" in job["message"] and f"{node} stays cordoned" in job["message"]
        assert any(name.startswith("guarded-") for name in seen_blocked), seen_blocked
        # The pod the budget protects is still on the node; the web pods were evicted.
        on_node = kubectl(
            "get", "pods", "-A", "--field-selector", f"spec.nodeName={node}",
            "-o", "jsonpath={.items[*].metadata.name}",
        ).split()  # fmt: skip
        assert any(p.startswith("guarded-") for p in on_node), on_node
        assert not any(p.startswith("web-") for p in on_node), on_node
        unschedulable = kubectl("get", "node", node, "-o", "jsonpath={.spec.unschedulable}")
        assert unschedulable == "true"
        record = audit_records(client, "drain", node)[0]
        assert record["outcome"] == "failed" and "PodDisruptionBudget" in record["message"]

        uncordon = plan(client, cluster, "uncordon", "nodes", node)
        assert apply_plan(client, uncordon).status_code == 200
        # The pipeline did it (the finally's kubectl uncordon must not be the one that did).
        assert kubectl("get", "node", node, "-o", "jsonpath={.spec.unschedulable}") == ""
    finally:
        for command in (["uncordon", node], ["apply", "-f", str(WORKLOADS)]):
            subprocess.run(
                ["kubectl", "--context", CONTEXT, *command],
                check=False,
                capture_output=True,
                timeout=120,
            )
        wait_ready("web", 2, timeout=150)

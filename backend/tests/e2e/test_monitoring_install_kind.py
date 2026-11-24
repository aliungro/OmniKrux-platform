"""Installing the monitoring tools on a real cluster: a second kind cluster (`omnikrux-install`,
or `OMNIKRUX_KIND_INSTALL_CLUSTER`), added to an OmniKrux that also has `omnikrux-dev`, so the
install also proves it touches only the cluster it names.

The tests run in order on one app: install and connect, install again with other settings,
OmniKrux's contact points through its own Alertmanager, then uninstall, a cancelled install and
an install with the defaults, which stays (later checks use it). They need the pinned Helm and
chart archives (scripts/dev-monitoring-tools.sh); the cluster pulls the images itself, so the
first install can take many minutes."""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from omnikrux.config import DEFAULT_ALLOWED_HOSTS, Settings
from omnikrux.main import create_app
from omnikrux.monitoring.install.facts import decode_release
from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.values import AMC_NAME, MANAGED_BY
from tests.e2e.support import kubectl, wait_for
from tests.e2e.test_monitoring_kind import (
    ALERTS,
    RECEIVER_PORT,
    Receiver,
    apply_plan,
    delete_project,
    remove_rule,
    rule_now,
    sync_and_apply,
)
from tests.kube.test_source_kind import REPO, find_kind

pytestmark = pytest.mark.kind

# Read when the module is imported: the shared test fixtures clear OMNIKRUX_* for every test.
CLUSTER_NAME = os.environ.get("OMNIKRUX_KIND_INSTALL_CLUSTER") or "omnikrux-install"
CONTEXT = f"kind-{CLUSTER_NAME}"
HELM_SETTING = os.environ.get("OMNIKRUX_HELM_BINARY")
CHARTS_SETTING = os.environ.get("OMNIKRUX_CHARTS_DIR")

NOT_RUNNING = (
    f"The kind cluster {CLUSTER_NAME} isn't running (see docs/guide/developer/testing.md)."
)
NO_TOOLS = (
    "The pinned Helm and charts aren't available (run scripts/dev-monitoring-tools.sh and set "
    "OMNIKRUX_HELM_BINARY and OMNIKRUX_CHARTS_DIR)."
)
INSTALL = "/api/monitoring/install"
JOBS = "/api/actions/jobs"
NS = "monitoring"
RELEASES = ("omnikrux-metrics", "omnikrux-loki", "omnikrux-alloy")
CHART_OF = {
    "omnikrux-metrics": "kube-prometheus-stack",
    "omnikrux-loki": "loki",
    "omnikrux-alloy": "alloy",
}
SMALL = {
    "prometheus": {"cpu_request": "100m", "memory_request": "256Mi", "memory_limit": "1Gi"},
    "loki": {"cpu_request": "50m", "memory_request": "128Mi", "memory_limit": "512Mi"},
    "prometheus_storage": "2Gi",
    "loki_storage": "2Gi",
}
PROMETHEUS_STS = "prometheus-omnikrux-metrics-prometheus"
FIFTEEN_MINUTES = 900.0
THREE_MINUTES = 180.0
RECEIVER_PATH = "/omnikrux-install"
ARGO_APPS = ("kps", "loki", "prometheus")

# The second cluster's own kubeconfig (written by `install_files`), for kubectl.
_CONFIG: dict[str, Path] = {}
# What the live run saw (progress messages, timings), printed with `-s` for the live notes.
SEEN: dict[str, object] = {}


def _helm_and_charts() -> tuple[Path, Path] | None:
    tools = REPO / ".tools"
    helm = Path(HELM_SETTING) if HELM_SETTING else None
    if helm is None:
        helm = next((p for p in (tools / "helm", tools / "helm.exe") if p.is_file()), None)
    charts = Path(CHARTS_SETTING) if CHARTS_SETTING else tools / "charts"
    if helm is None or not charts.is_dir():
        return None
    return helm, charts


def _kind_kubeconfig(name: str) -> str | None:
    if (kind := find_kind()) is None:
        return None
    done = subprocess.run(
        [kind, "get", "kubeconfig", "--name", name],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return done.stdout if done.returncode == 0 else None


@pytest.fixture(scope="module")
def install_files(tmp_path_factory) -> dict[str, Path]:
    if shutil.which("kubectl") is None:
        pytest.skip("kubectl is not installed")
    dev = _kind_kubeconfig("omnikrux-dev")
    second = _kind_kubeconfig(CLUSTER_NAME)
    if dev is None:
        pytest.skip("kind cluster omnikrux-dev not running (scripts/dev-kind.sh)")
    if second is None:
        pytest.skip(NOT_RUNNING)
    tools = _helm_and_charts()
    if tools is None:
        pytest.skip(NO_TOOLS)
    folder = tmp_path_factory.mktemp("install-kind")
    (folder / "dev-config").write_text(dev, encoding="utf-8")
    (folder / "install-config").write_text(second, encoding="utf-8")
    _CONFIG["install"] = folder / "install-config"
    return {
        "data": folder,
        "dev": folder / "dev-config",
        "install": folder / "install-config",
        "helm": tools[0],
        "charts": tools[1],
    }


@pytest.fixture(scope="module")
def install_client(install_files):
    """The real app on omnikrux-dev's kubeconfig, then the second cluster added through the
    API, as Settings → Import kubeconfig does."""
    app = create_app(
        Settings(
            data_dir=install_files["data"],
            kubeconfig=str(install_files["dev"]),
            in_container=False,
            port_forward_ports="30140-30159",
            helm_binary=install_files["helm"],
            charts_dir=install_files["charts"],
            # Set here: this app outlives the per-test fixture that allows `testserver`.
            allowed_hosts=[*DEFAULT_ALLOWED_HOSTS, "testserver"],
        )
    )
    with TestClient(app) as client:
        tools = client.get(f"{INSTALL}/tools").json()
        if not tools["available"]:
            pytest.skip(f"{NO_TOOLS} {tools['message']}")
        text = install_files["install"].read_text(encoding="utf-8")
        added = client.post("/api/clusters/kubeconfig", json={"kubeconfig": text})
        assert added.status_code == 200, added.text
        try:
            yield client
        finally:
            print("LIVE", json.dumps(SEEN, indent=1, default=str))  # shown with -s


@pytest.fixture(scope="module")
def install_cluster(install_client) -> str:
    clusters = install_client.get("/api/clusters").json()
    [found] = [c for c in clusters if c["name"] == CONTEXT]
    return found["id"]


def kubectl_install(*args: str, check: bool = True) -> str:
    """kubectl on the second cluster (its own kubeconfig, never the shared one's context)."""
    done = subprocess.run(
        ["kubectl", "--kubeconfig", str(_CONFIG["install"]), "--context", CONTEXT, *args],
        check=False,
        capture_output=True,
        encoding="utf-8",
        timeout=60,
    )
    if check:
        assert done.returncode == 0, f"kubectl {' '.join(args)} failed: {done.stderr.strip()}"
    return done.stdout


def items(*args: str) -> list[dict]:
    return json.loads(kubectl_install("get", *args, "-o", "json"))["items"]


def status(client, cluster: str) -> dict:
    r = client.get(f"{INSTALL}/clusters/{cluster}")
    assert r.status_code == 200, r.text
    return r.json()


def plan_install(client, cluster: str, components: list[str], settings: dict | None = None):
    body: dict = {"cluster_id": cluster, "components": components}
    if settings is not None:
        body["settings"] = settings
    r = client.post(f"{INSTALL}/plan", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def apply(client, plan: dict) -> dict:
    r = client.post(
        f"/api/actions/{plan['plan_id']}/apply", json={"confirm_text": plan["confirm_text"]}
    )
    assert r.status_code == 200, r.text
    return r.json()


def follow(client, job_id: str, timeout: float = FIFTEEN_MINUTES) -> tuple[dict, list[str]]:
    """Poll the job every 5 seconds until it ends; the job and each message it showed."""
    messages: list[str] = []
    deadline = time.monotonic() + timeout
    while True:
        job = client.get(f"{JOBS}/{job_id}").json()
        if not messages or messages[-1] != job["message"]:
            messages.append(job["message"])
        if job["state"] != "running":
            return job, messages
        if time.monotonic() > deadline:
            pytest.fail(f"The job ran longer than {timeout:.0f}s: {messages[-5:]}")
        time.sleep(5)


def installed_sources(client) -> dict[str, dict]:
    return {
        s["type"]: s
        for s in client.get("/api/monitoring/sources").json()
        if s["installed_by_omnikrux"]
    }


def run_query(client, source_id: str, **body) -> dict:
    r = client.post("/api/monitoring/query", json={"source_id": source_id} | body)
    assert r.status_code == 200, r.text
    return r.json()


def release_records() -> dict[str, dict]:
    """The latest Helm release Secret of each of OmniKrux's releases in the namespace."""
    latest: dict[str, dict] = {}
    for secret in items("secrets", "-n", NS, "-l", "owner=helm"):
        labels = secret["metadata"].get("labels", {})
        name = labels.get("name")
        if name in RELEASES and (
            name not in latest
            or int(labels.get("version", 0)) > int(latest[name]["metadata"]["labels"]["version"])
        ):
            latest[name] = secret
    return latest


def loki_claim() -> str | None:
    """The data volume size the installed Loki StatefulSet claims, if there is one."""
    found = kubectl_install(
        "get", "statefulset", "omnikrux-loki", "-n", NS, "-o", "json", check=False
    )
    if not found:
        return None
    claims = json.loads(found)["spec"].get("volumeClaimTemplates") or [{}]
    return claims[0].get("spec", {}).get("resources", {}).get("requests", {}).get("storage")


def dev_untouched() -> None:
    """omnikrux-dev keeps its own tools: no OmniKrux release there, the Argo apps healthy."""
    secrets = json.loads(kubectl("get", "secrets", "-n", NS, "-l", "owner=helm", "-o", "json"))
    names = [s["metadata"].get("labels", {}).get("name", "") for s in secrets["items"]]
    assert not [n for n in names if n.startswith("omnikrux-")], names

    def healthy() -> bool:
        apps = json.loads(kubectl("get", "applications", "-n", "argocd", "-o", "json"))["items"]
        state = {
            a["metadata"]["name"]: (
                a.get("status", {}).get("sync", {}).get("status"),
                a.get("status", {}).get("health", {}).get("status"),
            )
            for a in apps
        }
        return all(state.get(name) == ("Synced", "Healthy") for name in ARGO_APPS)

    wait_for(healthy, "the Argo apps on omnikrux-dev to read Synced and Healthy", timeout=120)


def test_install_review_apply_and_connect(install_client, install_cluster):
    client, cluster = install_client, install_cluster
    settings = SMALL
    if (kept := loki_claim()) not in (None, SMALL["loki_storage"]):
        # A run after an earlier one: the installed Loki's volume can't change size, and the
        # review says so before anything is written. The rest of the small settings apply.
        refused = plan_install(client, cluster, ["metrics", "logs"], SMALL)["plan"]
        assert refused["blocked"] == [
            (
                f"Loki already keeps its data on a {kept} volume, and its size can't change once "
                f"Loki has it. Set Loki's storage back to {kept}, or uninstall the tools and install "
                "them again."
            )
        ]
        SEEN["loki_volume_kept"] = kept
        settings = SMALL | {"loki_storage": kept}
    answer = plan_install(client, cluster, ["metrics", "logs"], settings)
    SEEN["settings"] = settings
    plan = answer["plan"]
    assert plan["blocked"] == [], plan["blocked"]
    assert answer["problems"] == []
    assert answer["facts"]["default_storage_class"] == "standard"
    assert plan["cluster"]["id"] == cluster
    SEEN["plan_summary"] = plan["summary"]

    started = time.monotonic()
    out = apply(client, plan)
    assert out["outcome"] == "started", out
    job, messages = follow(client, out["job_id"])
    SEEN["install_seconds"] = round(time.monotonic() - started)
    SEEN["install_messages"] = messages
    assert job["state"] == "succeeded", messages

    now = status(client, cluster)
    assert now["problem"] is None
    assert now["install"]["state"] == "installed"
    releases = {r["release"]: r for r in now["releases"]}
    assert set(releases) == set(RELEASES)
    for name, release in releases.items():
        assert release["status"] == "deployed", release
        assert release["version"] == CHARTS[CHART_OF[name]].version
        for w in release["workloads"]:
            assert w["ready"] == w["desired"] and w["desired"] >= 1, w

    # F24: the facts reader decodes Helm 4's own release records.
    for name, secret in release_records().items():
        ref = decode_release(secret)
        assert (ref.name, ref.status, ref.owner_label) == (name, "deployed", MANAGED_BY)
        assert ref.chart_version == CHARTS[CHART_OF[name]].version
        assert ref.deployed_at

    sources = installed_sources(client)
    assert set(sources) == {"prometheus", "alertmanager", "loki"}
    assert all(s["cluster_id"] == cluster for s in sources.values())

    # The chart labels the Operator's resources with the release.
    for kind in ("prometheus", "alertmanager"):
        [cr] = items(kind, "-n", NS)
        assert cr["metadata"]["labels"]["app.kubernetes.io/instance"] == "omnikrux-metrics"

    def scraped() -> set[str]:
        found = run_query(client, sources["prometheus"]["id"], kind="instant", query="up == 1")
        return {s["labels"].get("job", "") for s in found["series"]}

    jobs = wait_for(
        lambda: (j := scraped()) >= {"kube-state-metrics", "node-exporter"} and j,
        "kube-state-metrics and node-exporter to be scraped",
        timeout=THREE_MINUTES,
        interval=10,
    )
    SEEN["scraped_jobs"] = sorted(jobs)

    def shipped() -> int:
        now = time.time()
        logs = run_query(
            client,
            sources["loki"]["id"],
            kind="range",
            query='{namespace="kube-system"}',
            start=now - 600,
            end=now,
            step=60,
            limit=20,
        )
        return sum(len(stream["entries"]) for stream in logs["streams"])

    SEEN["kube_system_lines"] = wait_for(
        shipped, "Alloy to ship kube-system lines", timeout=THREE_MINUTES, interval=10
    )

    # Loki took its retention settings (the compactor and the limits).
    config = kubectl_install(
        "get", "--raw", f"/api/v1/namespaces/{NS}/services/omnikrux-loki:3100/proxy/config"
    )
    assert "retention_enabled: true" in config
    assert "retention_period: 1w" in config  # Loki prints 168h as 1w

    dev_untouched()


def test_install_again_waits_for_the_new_statefulsets(install_client, install_cluster):
    """An update the Operator carries out: the job ends only once the Operator's new
    StatefulSet is rolled out, never on the old one that still reads ready."""
    client, cluster = install_client, install_cluster
    installed = SEEN.get("settings", SMALL)
    changed = installed | {
        "prometheus": installed["prometheus"] | {"memory_request": "320Mi"},
    }
    answer = plan_install(client, cluster, ["metrics", "logs"], changed)
    plan = answer["plan"]
    assert plan["blocked"] == [], plan["blocked"]
    started = time.monotonic()
    job, messages = follow(client, apply(client, plan)["job_id"])
    SEEN["update_seconds"] = round(time.monotonic() - started)
    SEEN["update_messages"] = messages
    assert job["state"] == "succeeded", messages

    sts = json.loads(kubectl_install("get", "statefulset", PROMETHEUS_STS, "-n", NS, "-o", "json"))
    container = next(
        c for c in sts["spec"]["template"]["spec"]["containers"] if c["name"] == "prometheus"
    )
    assert container["resources"]["requests"]["memory"] == "320Mi"
    s = sts["status"]
    assert s.get("observedGeneration", 0) >= sts["metadata"]["generation"], s
    assert s.get("currentRevision") == s.get("updateRevision"), s
    assert s.get("updatedReplicas") == s.get("readyReplicas") == sts["spec"]["replicas"], s
    [pod] = items("pods", "-n", NS, "-l", "app.kubernetes.io/name=prometheus")
    pod_container = next(c for c in pod["spec"]["containers"] if c["name"] == "prometheus")
    assert pod_container["resources"]["requests"]["memory"] == "320Mi"

    dev_untouched()


@pytest.fixture
def receiver():
    server = Receiver()
    server.start()
    try:
        yield server
    finally:
        server.stop()


def contacts_sync(client, cluster: str) -> dict:
    r = client.post(f"{INSTALL}/clusters/{cluster}/contacts/sync")
    assert r.status_code == 200, r.text
    return r.json()


def test_contact_sync_routes_a_tool_rule_to_the_webhook(install_client, install_cluster, receiver):
    client, cluster = install_client, install_cluster
    sources = installed_sources(client)
    url = f"http://host.docker.internal:{RECEIVER_PORT}{RECEIVER_PATH}"
    made: dict[str, list[str]] = {"projects": [], "rules": [], "contact_points": []}
    try:
        project = client.post(
            "/api/monitoring/setup",
            json={
                "name": "Install live check",
                "kind": "custom",
                "sources": [
                    {"source_id": sources["prometheus"]["id"], "filter": ""},
                    {"source_id": sources["alertmanager"]["id"], "filter": ""},
                ],
            },
        )
        assert project.status_code == 201, project.text
        project_id = project.json()["id"]
        made["projects"].append(project_id)
        hook = client.post(
            f"{ALERTS}/contact-points",
            json={"name": "Install live hook", "type": "webhook", "secrets": {"url": url}},
        )
        assert hook.status_code == 201, hook.text
        hook_id = hook.json()["id"]
        made["contact_points"].append(hook_id)
        created = client.post(
            f"{ALERTS}/rules",
            json={
                "name": "Install live rule",
                "scope": {"kind": "project", "id": project_id},
                "source": {"type": "prometheus", "id": sources["prometheus"]["id"]},
                "expr": "vector(1)",
                "condition": {"op": "above", "threshold": 0, "for": "0s", "every": "30s"},
                "engine": "tool",
                "contact_point_ids": [hook_id],
            },
        )
        assert created.status_code == 201, created.text
        rule = created.json()["rule"]
        made["rules"].append(rule["id"])
        [target] = rule["targets"]
        assert target["engine"] == "tool", target

        sync_and_apply(client, target["id"])  # the PrometheusRule's own review
        answer = contacts_sync(client, cluster)
        assert answer["kind"] == "review", answer
        plan = answer["plan"]
        assert plan["action"] == "create" and plan["blocked"] == [], plan
        assert url not in json.dumps(plan)
        apply_plan(client, plan)

        [amc] = items("alertmanagerconfigs.monitoring.coreos.com", "-n", NS)
        assert amc["apiVersion"] == "monitoring.coreos.com/v1alpha1"
        assert amc["metadata"]["name"] == AMC_NAME
        assert status(client, cluster)["install"]["contacts"]["state"] == "in_sync"

        def posted() -> bool:
            return any(
                a["labels"].get("omnikrux_rule") == rule["id"] and a["status"] == "firing"
                for body in receiver.taken(RECEIVER_PATH)
                for a in body.get("alerts", [])
            )

        started = time.monotonic()
        wait_for(posted, "the installed Alertmanager's webhook", timeout=THREE_MINUTES, interval=5)
        SEEN["webhook_seconds"] = round(time.monotonic() - started)

        audit = client.get("/api/audit", params={"limit": 500})
        assert audit.status_code == 200, audit.text
        assert url not in audit.text

        remove_rule(client, rule["id"])
        made["rules"].remove(rule["id"])
        answer = contacts_sync(client, cluster)
        assert answer["kind"] == "review", answer
        assert answer["plan"]["action"] == "delete", answer["plan"]
        apply_plan(client, answer["plan"])
        assert items("alertmanagerconfigs.monitoring.coreos.com", "-n", NS) == []
        assert kubectl_install("get", "secret", AMC_NAME, "-n", NS, check=False) == ""
    finally:
        for rule_id in made["rules"]:
            if rule_now(client, rule_id) is not None:
                remove_rule(client, rule_id)
        for cp_id in made["contact_points"]:
            review = client.get(f"{ALERTS}/contact-points/{cp_id}/delete-review")
            if review.status_code == 200:
                done = client.delete(
                    f"{ALERTS}/contact-points/{cp_id}", params={"token": review.json()["token"]}
                )
                assert done.status_code in (200, 204), done.text
        for project_id in made["projects"]:
            delete_project(client, project_id)
    dev_untouched()


def plan_uninstall(client, cluster: str, *, delete_data: bool) -> dict:
    r = client.post(
        f"{INSTALL}/clusters/{cluster}/uninstall/plan", json={"delete_data": delete_data}
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_uninstall_then_install_again(install_client, install_cluster):
    client, cluster = install_client, install_cluster
    claims = {
        c["metadata"]["name"]: c["metadata"].get("labels", {}).get("app.kubernetes.io/instance")
        for c in items("pvc", "-n", NS)
    }
    SEEN["claims_before_uninstall"] = claims
    assert set(claims.values()) == {
        "omnikrux-metrics-prometheus",
        "omnikrux-metrics-alertmanager",
        "omnikrux-loki",
    }, claims

    plan = plan_uninstall(client, cluster, delete_data=True)
    assert plan["blocked"] == [], plan["blocked"]
    started = time.monotonic()
    job, messages = follow(client, apply(client, plan)["job_id"])
    SEEN["uninstall_seconds"] = round(time.monotonic() - started)
    SEEN["uninstall_messages"] = messages
    assert job["state"] == "succeeded", messages

    now = status(client, cluster)
    assert now["install"] is None
    assert release_records() == {}
    assert installed_sources(client) == {}
    assert items("pvc", "-n", NS) == []
    assert (
        json.loads(kubectl_install("get", "namespace", NS, "-o", "json"))["status"]["phase"]
        == "Active"
    )
    crds = [c["metadata"]["name"] for c in items("crd")]
    assert "prometheuses.monitoring.coreos.com" in crds

    def stopped() -> bool:
        return items("pods", "-n", NS) == []

    wait_for(stopped, "the Pods in monitoring to be gone", timeout=THREE_MINUTES, interval=5)

    # An install cancelled while Helm runs: the cancel ends within Helm's grace, and says what
    # stays; installing again (after an uninstall, when Helm was stopped mid-record) finishes it.
    out = apply(client, plan_install(client, cluster, ["metrics", "logs"])["plan"])
    job_id = out["job_id"]

    def in_helm() -> bool:
        return "with Helm" in client.get(f"{JOBS}/{job_id}").json()["message"]

    wait_for(in_helm, "the install to reach Helm", timeout=THREE_MINUTES, interval=0.5)
    # Once Helm has written its record of the release (it is mid-install then), not before.
    wait_for(
        lambda: "omnikrux-metrics" in release_records(),
        "Helm to record omnikrux-metrics",
        timeout=60,
        interval=0.5,
    )
    asked = time.monotonic()
    cancelled = client.post(f"{JOBS}/{job_id}/cancel")
    SEEN["cancel_seconds"] = round(time.monotonic() - asked, 1)
    assert cancelled.status_code == 200, cancelled.text
    job = cancelled.json()
    assert job["state"] == "cancelled", job
    assert SEEN["cancel_seconds"] < 30, SEEN["cancel_seconds"]
    SEEN["cancel_message"] = job["message"]
    assert job["message"].startswith("Install cancelled while installing omnikrux-")
    assert status(client, cluster)["install"]["state"] == "cancelled"
    SEEN["after_cancel"] = left = {
        name: s["metadata"]["labels"].get("status") for name, s in release_records().items()
    }
    pending = {name: state for name, state in left.items() if state.startswith("pending-")}
    if pending:
        # Helm was stopped before it could record how it ended (a terminate ends it at once on
        # Windows): Helm refuses to touch that release again, and the review says the way out.
        blocked = plan_install(client, cluster, ["metrics", "logs"])["plan"]["blocked"]
        assert blocked == [
            f"Helm's record of {name} says an earlier change never finished ({state}), so Helm "
            "won't change it again. Uninstall the tools, then install them again."
            for name, state in pending.items()
        ]
        plan = plan_uninstall(client, cluster, delete_data=True)
        assert plan["blocked"] == [], plan["blocked"]
        job, messages = follow(client, apply(client, plan)["job_id"])
        SEEN["uninstall_after_cancel_messages"] = messages
        assert job["state"] == "succeeded", messages
        assert release_records() == {}

    started = time.monotonic()
    answer = plan_install(client, cluster, ["metrics", "logs"])
    assert answer["plan"]["blocked"] == [], answer["plan"]["blocked"]
    job, messages = follow(client, apply(client, answer["plan"])["job_id"])
    SEEN["reinstall_seconds"] = round(time.monotonic() - started)
    SEEN["reinstall_messages"] = messages
    assert job["state"] == "succeeded", messages
    now = status(client, cluster)
    assert now["install"]["state"] == "installed"
    assert {r["release"]: r["status"] for r in now["releases"]} == dict.fromkeys(
        RELEASES, "deployed"
    )
    assert set(installed_sources(client)) == {"prometheus", "alertmanager", "loki"}
    dev_untouched()

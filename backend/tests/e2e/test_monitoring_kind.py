"""Monitoring against the Prometheus and Loki installed in kind's `monitoring` namespace."""

import asyncio
import json
import re
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
import yaml
from aiohttp import web
from fastapi.testclient import TestClient

from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.monitoring.transfer.alerts import draft_from_alert
from omnikrux.monitoring.transfer.types import AlertDraft
from tests.e2e.support import kubectl, wait_for

pytestmark = pytest.mark.kind

API = "/api/monitoring"
NOT_INSTALLED = (
    "Prometheus and Loki aren't installed in the monitoring namespace "
    "(see docs/guide/developer/monitoring.md)."
)
LIVE_CHECK_LINES = 3


def reachable(found: list[dict], type: str, service: str) -> dict | None:
    for tool in found:
        if (
            tool["type"] == type
            and tool["state"] == "reachable"
            and tool["namespace"] == "monitoring"
            and tool["service"] == service
        ):
            return tool
    return None


@pytest.fixture
def tools(client, cluster) -> dict[str, dict]:
    """The found Prometheus and Loki, or a skip when the cluster doesn't have them."""
    response = client.get(f"{API}/discovery/{cluster}")
    assert response.status_code == 200, response.text
    found = response.json()["found"]
    prometheus = reachable(found, "prometheus", "prometheus-server")
    loki = reachable(found, "loki", "loki")
    if prometheus is None or loki is None:
        pytest.skip(NOT_INSTALLED)
    return {"prometheus": prometheus, "loki": loki}


def new_source(cluster: str, tool: dict) -> dict:
    return {
        "type": tool["type"],
        "reach": "cluster",
        "cluster_id": cluster,
        "namespace": tool["namespace"],
        "service": tool["service"],
        "port": tool["port"],
        "scheme": tool["scheme"],
    }


def delete_project(client, project_id: str) -> None:
    """Delete through the API, with its review; the sources only it created go with it."""
    review = client.get(f"{API}/projects/{project_id}/delete-review")
    assert review.status_code == 200, review.text
    response = client.delete(
        f"{API}/projects/{project_id}", params={"token": review.json()["token"]}
    )
    assert response.status_code == 204, response.text


@contextmanager
def project_cleanup(client):
    """Collects the ids of projects a test makes and deletes them (newest first) afterwards."""
    made: list[str] = []
    try:
        yield made
    finally:
        for project_id in reversed(made):
            delete_project(client, project_id)


def set_up(client, cluster: str, name: str, sources: list[dict]) -> dict:
    response = client.post(
        f"{API}/setup",
        json={"name": name, "kind": "kubernetes", "cluster_id": cluster, "sources": sources},
    )
    assert response.status_code == 201, response.text
    return response.json()


def link_of(project: dict, type: str) -> dict:
    return next(link for link in project["links"] if link["source_type"] == type)


def query(client, project: dict, type: str, **body) -> dict:
    response = client.post(
        f"{API}/query",
        json={"source_id": link_of(project, type)["source_id"], "project_id": project["id"]} | body,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_discovery_finds_the_installed_tools(client, cluster):
    response = client.get(f"{API}/discovery/{cluster}")
    assert response.status_code == 200, response.text
    found = response.json()["found"]
    prometheus = reachable(found, "prometheus", "prometheus-server")
    loki = reachable(found, "loki", "loki")
    if prometheus is None or loki is None:
        pytest.skip(NOT_INSTALLED)
    assert prometheus["version"]
    assert loki["namespace"] == "monitoring"


def test_setup_and_query_through_the_cluster(client, cluster, tools):
    sources = [{"source": new_source(cluster, tools[t]), "filter": ""} for t in tools]
    with project_cleanup(client) as made:
        project = set_up(client, cluster, "Kind live check", sources)
        made.append(project["id"])

        instant = query(client, project, "prometheus", kind="instant", query="up")
        assert len(instant["series"]) >= 1

        now = time.time()
        ranged = query(
            client,
            project,
            "prometheus",
            kind="range",
            query="rate(prometheus_http_requests_total[5m])",
            start=now - 15 * 60,
            end=now,
            step=30,
        )
        assert ranged["series"]
        assert all(series["points"] for series in ranged["series"])

        logs = query(
            client, project, "loki", kind="range", query='{job="omnikrux-live-check"}',
            start=now - 7 * 86400, end=now, step=60, limit=10,
        )  # fmt: skip
        lines = [line for stream in logs["streams"] for _, line in stream["entries"]]
        assert len(lines) == LIVE_CHECK_LINES


def test_a_filtered_project_sees_only_its_part(client, cluster, tools):
    prometheus = new_source(cluster, tools["prometheus"])
    with project_cleanup(client) as made:
        wide = set_up(client, cluster, "Kind wide", [{"source": prometheus, "filter": ""}])
        made.append(wide["id"])
        source_id = wide["links"][0]["source_id"]
        narrow = set_up(
            client,
            cluster,
            "Kind narrow",
            [{"source_id": source_id, "filter": 'job="prometheus"'}],
        )
        made.append(narrow["id"])

        only = query(client, narrow, "prometheus", kind="instant", query="up")
        assert only["series"]
        assert all(s["labels"]["job"] == "prometheus" for s in only["series"])
        assert only["applied_filter"] == 'job="prometheus"'

        everything = query(client, wide, "prometheus", kind="instant", query="up")
        assert any(s["labels"]["job"] != "prometheus" for s in everything["series"])


# --- Dashboards: the ready-made views and a dashboard's life ----------------------------------

NO_NODE_EXPORTER = "node-exporter isn't installed in the monitoring namespace."
HOUR = 3600
STEP = 30
# What the browser puts in for the built-in variables on a one-hour range at step 30.
BUILTINS = {"__interval": "30s", "__rate_interval": "4m", "__range": "1h"}


@pytest.fixture
def prometheus_project(client, cluster, tools):
    """A Kubernetes project over the found Prometheus with no filter, deleted afterwards."""
    sources = [{"source": new_source(cluster, tools["prometheus"]), "filter": ""}]
    with project_cleanup(client) as made:
        project = set_up(client, cluster, "Kind dashboards", sources)
        made.append(project["id"])
        yield project


def ready_views(client, project: dict) -> dict[str, dict]:
    response = client.get(f"{API}/projects/{project['id']}/ready-made")
    assert response.status_code == 200, response.text
    return {view["key"]: view for view in response.json()}


def dashboard(client, id: str) -> dict:
    response = client.get(f"{API}/dashboards/{id}")
    assert response.status_code == 200, response.text
    return response.json()


def fill_in(
    text: str, document: dict, chosen: dict[str, str] | None = None, builtins: dict | None = None
) -> str:
    """The query as the browser sends it: variables stand for every value (`.+`) unless `chosen`
    names one, the built-in ones for a one-hour range at step 30."""
    values = (
        {v["name"]: ".+" for v in document["variables"]} | (chosen or {}) | (builtins or BUILTINS)
    )
    for name in sorted(values, key=len, reverse=True):
        text = text.replace("${" + name + "}", values[name]).replace("$" + name, values[name])
    return text


def panel_requests(project: dict, document: dict, now: float) -> list[tuple[dict, dict]]:
    """(panel, request) for every query of every panel, ready for `POST /query/batch`."""
    out = []
    for panel in document["panels"]:
        for q in panel["queries"]:
            request = {
                "source_id": link_of(project, q["source"]["type"])["source_id"],
                "project_id": project["id"],
                "query": fill_in(q["expr"], document),
            }
            if panel["type"] in ("bar", "table"):
                request |= {"kind": "instant", "time": now}
            else:
                request |= {"kind": "range", "start": now - HOUR, "end": now, "step": STEP}
            out.append((panel, request))
    return out


def run_batch(client, requests: list[dict]) -> list[dict]:
    results = []
    for start in range(0, len(requests), 64):  # a batch takes at most 64 queries
        response = client.post(f"{API}/query/batch", json={"queries": requests[start : start + 64]})
        assert response.status_code == 200, response.text
        results += response.json()["results"]
    assert len(results) == len(requests)
    return results


def run_panel(client, project: dict, document: dict, title: str) -> list[dict]:
    """The answers (one per query) of the panel with this title."""
    now = time.time()
    chosen = [(p, r) for p, r in panel_requests(project, document, now) if p["title"] == title]
    assert chosen, f"{document['title']} has no panel {title!r}"
    results = run_batch(client, [r for _, r in chosen])
    assert all(r["ok"] for r in results), results
    return [r["response"] for r in results]


def test_ready_made_views_run_on_the_cluster(client, prometheus_project):
    project = prometheus_project
    views = ready_views(client, project)
    assert views, "a Kubernetes project with Prometheus gets ready-made views"
    cluster_view = views["cluster"]
    assert cluster_view["checked"], cluster_view["check_message"]
    assert not {"kube_state", "cadvisor"} & set(cluster_view["missing"]), cluster_view

    documents = {key: dashboard(client, view["id"])["spec"] for key, view in views.items()}
    now = time.time()
    sent = [
        (key, panel, request)
        for key, document in documents.items()
        for panel, request in panel_requests(project, document, now)
    ]
    results = run_batch(client, [request for _, _, request in sent])
    for (key, panel, _), result in zip(sent, results, strict=True):
        code = (result.get("error") or {}).get("code")
        assert code != "bad_query", f"{key} / {panel['title']}: {result['error']}"

    nodes_ready = run_panel(client, project, documents["cluster"], "Nodes ready")[0]
    last = [p[1] for s in nodes_ready["series"] for p in s["points"] if p[1] is not None]
    assert last and last[-1] >= 1

    cpu = run_panel(client, project, documents["pods"], "CPU by Pod")[0]
    assert len(cpu["series"]) >= 1


def test_node_health_on_the_cluster(client, prometheus_project):
    project = prometheus_project
    views = ready_views(client, project)
    # "missing" only means something once the metric names were read.
    assert views["nodes"]["checked"], views["nodes"]["check_message"]
    if "node_exporter" in views["nodes"]["missing"]:
        pytest.skip(NO_NODE_EXPORTER)
    document = dashboard(client, views["nodes"]["id"])["spec"]
    busy = run_panel(client, project, document, "CPU busy")[0]
    nodes = query(client, project, "prometheus", kind="instant", query="count(kube_node_info)")
    assert nodes["series"], "kube_node_info has no series: is kube-state-metrics running?"
    count = nodes["series"][0]["points"][0][1]
    assert len(busy["series"]) == count


# --- Ready-made views over both Prometheus (the operator's first, then prometheus-server) --------
#
# The operator's Prometheus (kps) holds cAdvisor's metrics but not kube-state-metrics'; the
# plain prometheus-server holds both. These run the ready-made query texts on a real Prometheus:
# FakePrometheus can't evaluate PromQL.

NO_OPERATOR_PROMETHEUS = "The operator's Prometheus isn't installed in the monitoring namespace."
REPLICASET_HASH = re.compile(r"-[0-9a-f]{8,10}$")


@pytest.fixture
def two_prometheus_project(client, cluster, tools):
    """A Kubernetes project linking the operator's Prometheus first, then prometheus-server."""
    response = client.get(f"{API}/discovery/{cluster}")
    assert response.status_code == 200, response.text
    operator = reachable(response.json()["found"], "prometheus", OPERATOR_PROMETHEUS)
    if operator is None:
        pytest.skip(NO_OPERATOR_PROMETHEUS)
    sources = [
        {"source": new_source(cluster, tool), "filter": ""}
        for tool in (operator, tools["prometheus"])
    ]
    with project_cleanup(client) as made:
        project = set_up(client, cluster, "Kind two Prometheus", sources)
        made.append(project["id"])
        yield project


def ready_panel(client, project: dict, key: str, title: str) -> list[dict]:
    """The series of the ready-made view's panel, each query run against the source it names."""
    document = dashboard(client, ready_views(client, project)[key]["id"])["spec"]
    [panel] = [p for p in document["panels"] if p["title"] == title]
    now = time.time()
    requests = []
    for q in panel["queries"]:
        request = {
            "source_id": q["source"]["id"],
            "project_id": project["id"],
            "query": fill_in(q["expr"], document),
        }
        if panel["type"] in ("bar", "table"):
            request |= {"kind": "instant", "time": now}
        else:
            request |= {"kind": "range", "start": now - HOUR, "end": now, "step": STEP}
        requests.append(request)
    results = run_batch(client, requests)
    assert all(r["ok"] for r in results), results
    return [s for r in results for s in r["response"]["series"]]


def last_value(series: dict) -> float | None:
    values = [p[1] for p in series["points"] if p[1] is not None]
    return values[-1] if values else None


def test_ready_made_reads_the_prometheus_with_kube_state_metrics(client, two_prometheus_project):
    project = two_prometheus_project
    server = project["links"][1]
    views = ready_views(client, project)
    cluster_view = views["cluster"]
    assert cluster_view["checked"], cluster_view["check_message"]
    assert cluster_view["source_name"] == server["source_name"], cluster_view
    assert cluster_view["missing"] == [] and cluster_view["notes"] == [], cluster_view
    document = dashboard(client, cluster_view["id"])["spec"]
    ids = {q["source"]["id"] for p in document["panels"] for q in p["queries"]}
    assert ids == {server["source_id"]}

    [ready] = ready_panel(client, project, "cluster", "Nodes ready")
    assert (last_value(ready) or 0) >= 1
    [not_ready] = ready_panel(client, project, "cluster", "Nodes not ready")
    assert last_value(not_ready) == 0


def test_cpu_requested_is_a_share_of_scheduled_requests(client, two_prometheus_project):
    for title in ("CPU requested", "Memory requested"):
        [share] = ready_panel(client, two_prometheus_project, "cluster", title)
        value = last_value(share)
        assert value is not None and 0 < value < 1.0, (title, value)


def test_workloads_have_no_replicaset_names(client, two_prometheus_project):
    for title in ("CPU by workload", "Memory by workload"):
        series = ready_panel(client, two_prometheus_project, "workloads", title)
        assert series, title
        names = [
            f"{s['labels'].get('namespace', '')}/{s['labels'].get('workload', '')}" for s in series
        ]
        # Every Pod has a workload (a bare or static Pod's is "(no owner)"), never a ReplicaSet.
        assert all(not name.endswith("/") for name in names), names
        assert not [n for n in names if REPLICASET_HASH.search(n)], names
        assert len(names) == len(set(names)), names


def test_node_health_uses_node_names(client, two_prometheus_project):
    views = ready_views(client, two_prometheus_project)
    if "node_exporter" in views["nodes"]["missing"]:
        pytest.skip(NO_NODE_EXPORTER)
    nodes = set(kubectl("get", "nodes", "-o", "jsonpath={.items[*].metadata.name}").split())
    for title in ("CPU busy", "Memory used", "Fullest disk", "Network received"):
        series = ready_panel(client, two_prometheus_project, "nodes", title)
        assert {s["labels"].get("nodename") for s in series} == nodes, title


def test_dashboard_lifecycle_on_the_cluster(client, prometheus_project):
    project = prometheus_project
    ready = ready_views(client, project)["cluster"]
    copied = client.post(
        f"{API}/dashboards/copy",
        json={"from_id": ready["id"], "owner_kind": "project", "owner_id": project["id"]},
    )
    assert copied.status_code == 201, copied.text
    saved_dashboard = copied.json()
    url = f"{API}/dashboards/{saved_dashboard['id']}"
    assert saved_dashboard["version"] == 1 and not saved_dashboard["ready_made"]

    changed = saved_dashboard["spec"] | {"title": "Kind cluster health, changed"}
    saved = client.put(url, json={"base_version": 1, "spec": changed})
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 2 and saved.json()["title"] == changed["title"]

    restored = client.post(f"{url}/versions/1/restore", json={"base_version": 2})
    assert restored.status_code == 200, restored.text
    assert restored.json()["version"] == 3
    assert restored.json()["title"] == saved_dashboard["title"]

    removed = client.delete(url, params={"version": 3})
    assert removed.status_code == 204, removed.text
    assert client.get(url).status_code == 404

    records = [
        r
        for r in reversed(client.get("/api/audit").json()["records"])
        if r["app"] == "monitoring" and r["kind"] == "dashboard"
    ]
    assert [(r["action"], r["outcome"]) for r in records] == [
        ("dashboard_add", "succeeded"),
        ("dashboard_save", "succeeded"),
        ("dashboard_restore", "succeeded"),
        ("dashboard_remove", "succeeded"),
    ]


# --- Building and Explore: the catalog and the suggestion templates -----------------------------

CHECK_JOB = "omnikrux-m3-check"
# The order the browser's suggestion rules pick a log label in (frontend/src/monitoring/build).
STREAM_LABELS = ["namespace", "app", "service_name", "job", "container"]
IDENT = r"^[A-Za-z_][A-Za-z0-9_]*$"


@pytest.fixture
def both_project(client, cluster, tools):
    """A Kubernetes project over the found Prometheus and Loki with no filter."""
    sources = [{"source": new_source(cluster, tools[t]), "filter": ""} for t in tools]
    with project_cleanup(client) as made:
        project = set_up(client, cluster, "Kind catalog", sources)
        made.append(project["id"])
        yield project


def lines_missing(found: bool, what: str) -> None:
    """Fails, with how to fix it, when a check that needs the pushed log lines finds none."""
    if not found:
        pytest.fail(
            f"{what}: the pushed log lines are missing or older than the last hour. Push them "
            "again (see 'Pushing the log lines' in docs/guide/developer/monitoring.md)."
        )


def catalog_of(client, project: dict) -> dict[str, dict]:
    """The project's catalog sections, by source type."""
    response = client.get(f"{API}/projects/{project['id']}/catalog")
    assert response.status_code == 200, response.text
    return {section["source_type"]: section for section in response.json()["sources"]}


def metrics_by_name(section: dict) -> dict[str, dict]:
    return {m["name"]: m for m in section["metrics"]}


def test_catalog_on_the_cluster(client, both_project):
    sections = catalog_of(client, both_project)

    prometheus = sections["prometheus"]
    assert prometheus["state"] in ("ok", "partial"), prometheus["message"]
    metrics = metrics_by_name(prometheus)
    requests = metrics["prometheus_http_requests_total"]
    assert requests["type"] == "counter"
    assert {"code", "handler"} <= set(requests["labels"])
    buckets = metrics["prometheus_http_request_duration_seconds_bucket"]
    assert buckets["family"] == "prometheus_http_request_duration_seconds"
    assert "kube_pod_container_status_restarts_total" in metrics

    loki = sections["loki"]
    assert loki["state"] in ("ok", "partial"), loki["message"]
    streams = {s["name"]: s for s in loki["streams"]}
    lines_missing(CHECK_JOB in streams.get("job", {}).get("values", []), "Loki lists no job value")
    lines_missing("level" in streams, "Loki lists no level label")


def test_suggestion_templates_run_on_the_cluster(client, both_project):
    project = both_project
    loki_section = catalog_of(client, project)["loki"]
    writable = [s["name"] for s in loki_section["streams"] if re.match(IDENT, s["name"])]
    lines_missing(bool(writable), "Loki lists no log label")
    label = next((name for name in STREAM_LABELS if name in writable), writable[0])
    # Assumes the pushed streams carry a `level` label (the volume is split by it).
    volume = f'sum by (level) (count_over_time({{{label}=~".+"}}[30s]))'
    errors = f'{{{label}=~".+"}} |~ "(?i)(error|fatal|panic)"'

    prometheus_queries = {
        "rate": "sum by (handler) (rate(prometheus_http_requests_total[2m]))",
        "error_rate": (
            'sum(rate(prometheus_http_requests_total{code=~"5.."}[2m]))'
            " / sum(rate(prometheus_http_requests_total[2m]))"
        ),
        "latency": (
            "histogram_quantile(0.95, sum by (le) "
            "(rate(prometheus_http_request_duration_seconds_bucket[2m])))"
        ),
        "restarts": (
            "topk(5, sum by (namespace, pod) "
            "(increase(kube_pod_container_status_restarts_total[1h])))"
        ),
        "cpu": (
            "topk(10, sum by (namespace, pod) "
            '(rate(container_cpu_usage_seconds_total{container!=""}[2m])))'
        ),
        "down": "count(up == 0) or vector(0)",
    }
    now = time.time()
    window = {"kind": "range", "start": now - HOUR, "end": now, "step": STEP}
    prometheus_id = link_of(project, "prometheus")["source_id"]
    loki_id = link_of(project, "loki")["source_id"]
    named = [(name, prometheus_id, text) for name, text in prometheus_queries.items()]
    named += [("volume", loki_id, volume), ("errors", loki_id, errors)]
    requests = [
        {"source_id": source_id, "project_id": project["id"], "query": text} | window
        for _, source_id, text in named
    ]
    results = run_batch(client, requests)
    answers = dict(zip([name for name, _, _ in named], results, strict=True))
    for name, result in answers.items():
        code = (result.get("error") or {}).get("code")
        assert code != "bad_query", f"{name}: {result['error']}"

    assert answers["rate"]["ok"] and answers["rate"]["response"]["series"]
    assert answers["volume"]["ok"], answers["volume"]
    lines_missing(bool(answers["volume"]["response"]["series"]), "The log volume is empty")


def test_catalog_follows_a_filter_on_the_cluster(client, cluster, tools):
    prometheus = new_source(cluster, tools["prometheus"])
    restarts = "kube_pod_container_status_restarts_total"
    with project_cleanup(client) as made:
        wide = set_up(client, cluster, "Kind catalog wide", [{"source": prometheus, "filter": ""}])
        made.append(wide["id"])
        narrow = set_up(
            client,
            cluster,
            "Kind catalog narrow",
            [{"source_id": wide["links"][0]["source_id"], "filter": 'job="prometheus"'}],
        )
        made.append(narrow["id"])

        assert restarts in metrics_by_name(catalog_of(client, wide)["prometheus"])
        narrow_section = catalog_of(client, narrow)["prometheus"]
        assert narrow_section["state"] in ("ok", "partial"), narrow_section["message"]
        assert narrow_section["metrics"]
        assert restarts not in metrics_by_name(narrow_section)


# --- Alerts: the Prometheus Operator, Alertmanager, the Loki ruler and OmniKrux's own engine ---
#
# These need the tools of `docs/guide/developer/monitoring.md` ("Alerts on a kind cluster"):
# kube-prometheus-stack (release `kps`, Alertmanager routing `team="omnikrux-live"` to
# http://host.docker.internal:9911/alertmanager) and, for the Loki test, a Loki ruler with a
# writable rule store.

NO_ALERT_TOOLS = (
    "The Prometheus Operator and Alertmanager aren't installed in the monitoring namespace "
    "(see docs/guide/developer/monitoring.md)."
)
NO_RULER = "The Loki ruler isn't turned on in the monitoring namespace."
ALERTS = f"{API}/alerts"
OPERATOR_PROMETHEUS = "kps-kube-prometheus-stack-prometheus"
OPERATOR_ALERTMANAGER = "kps-kube-prometheus-stack-alertmanager"
LIVE_TEAM = {"team": "omnikrux-live"}
RECEIVER_PORT = 9911
THREE_MINUTES = 180.0
EVERY_30S = {"of": "each", "op": "above", "threshold": 0, "for": "0s", "every": "30s"}


class Receiver:
    """The test's own webhook server, for as long as the test runs.

    It binds 0.0.0.0, not 127.0.0.1: Alertmanager runs in kind (inside Docker Desktop's VM) and
    reaches this machine as `host.docker.internal`, which a socket bound to loopback only never
    sees. Anything on the local network could post to it meanwhile, so it keeps nothing but what
    it was sent, answers 200 and stops with the test."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self._lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._failure: BaseException | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        runner = web.AppRunner(self._app())
        try:
            self._loop.run_until_complete(runner.setup())
            site = web.TCPSite(runner, "0.0.0.0", RECEIVER_PORT)  # all interfaces: see the class
            self._loop.run_until_complete(site.start())
        except OSError as exc:
            self._failure = exc
            self._ready.set()
            return
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            self._loop.run_until_complete(runner.cleanup())
            self._loop.close()

    def _app(self) -> web.Application:
        async def take(request: web.Request) -> web.Response:
            try:
                body = await request.json()
            except ValueError:
                body = {}
            with self._lock:
                self.requests.append((request.path, body if isinstance(body, dict) else {}))
            return web.Response(text="ok")

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", take)
        return app

    def start(self) -> None:
        self._thread.start()
        assert self._ready.wait(10), "the receiver didn't start"
        if self._failure is not None:
            pytest.skip(f"Port {RECEIVER_PORT} on this machine isn't free ({self._failure}).")

    def stop(self) -> None:
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(10)

    def taken(self, path: str) -> list[dict]:
        with self._lock:
            return [body for p, body in self.requests if p == path]


@pytest.fixture
def receiver():
    server = Receiver()
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def alert_client(tmp_path, kind_kubeconfig):
    """The real app with OmniKrux's alert engine turned on (the tests that need it say so)."""
    app = create_app(
        Settings(
            data_dir=tmp_path,
            kubeconfig=str(kind_kubeconfig),
            in_container=False,
            port_forward_ports="30120-30139",
            alert_engine=True,
        )
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def alert_cluster(alert_client):
    clusters = alert_client.get("/api/clusters").json()
    assert len(clusters) == 1, clusters
    return clusters[0]["id"]


@pytest.fixture
def alert_tools(alert_client, alert_cluster) -> dict[str, dict]:
    """The operator's Prometheus and Alertmanager, and Loki when it is there; else a skip."""
    response = alert_client.get(f"{API}/discovery/{alert_cluster}")
    assert response.status_code == 200, response.text
    found = response.json()["found"]
    prometheus = reachable(found, "prometheus", OPERATOR_PROMETHEUS)
    alertmanager = reachable(found, "alertmanager", OPERATOR_ALERTMANAGER)
    if prometheus is None or alertmanager is None:
        pytest.skip(NO_ALERT_TOOLS)
    out = {"prometheus": prometheus, "alertmanager": alertmanager}
    if loki := reachable(found, "loki", "loki"):
        out["loki"] = loki
    return out


def proxied(service: str, path: str) -> dict | list:
    """A read of a Service in `monitoring` through the API server (JSON)."""
    return json.loads(
        kubectl("get", "--raw", f"/api/v1/namespaces/monitoring/services/{service}/proxy/{path}")
    )


def alert_project(client, cluster: str, tools: dict[str, dict], name: str, types: list[str]):
    sources = [{"source": new_source(cluster, tools[t]), "filter": ""} for t in types]
    return set_up(client, cluster, name, sources)


def rule_body(project: dict, name: str, expr: str, **over) -> dict:
    body = {
        "name": name,
        "scope": {"kind": "project", "id": project["id"]},
        "source": {"type": "prometheus", "id": None},
        "expr": expr,
        "condition": EVERY_30S,
        "engine": "tool",
    }
    return body | over


def add_alert_rule(client, body: dict) -> dict:
    response = client.post(f"{ALERTS}/rules", json=body)
    assert response.status_code == 201, response.text
    return response.json()["rule"]


def rule_now(client, rule_id: str) -> dict | None:
    response = client.get(f"{ALERTS}/rules/{rule_id}")
    return None if response.status_code == 404 else response.json()


def apply_plan(client, plan: dict) -> None:
    response = client.post(
        f"/api/actions/{plan['plan_id']}/apply", json={"confirm_text": plan["confirm_text"]}
    )
    assert response.status_code == 200, response.text


def sync_and_apply(client, target_id: str) -> None:
    """Bring the tool in line with the target: the review is applied like any cluster change."""
    response = client.post(f"{ALERTS}/targets/{target_id}/sync")
    assert response.status_code == 200, response.text
    answer = response.json()
    if answer["kind"] == "review":
        assert not answer["plan"]["blocked"], answer["plan"]["blocked"]
        apply_plan(client, answer["plan"])


def remove_rule(client, rule_id: str) -> None:
    """Delete a rule through its review; what it left in a cluster goes through its own review."""
    rule = rule_now(client, rule_id)
    if rule is None:
        return
    review = client.get(f"{ALERTS}/rules/{rule_id}/delete-review")
    assert review.status_code == 200, review.text
    done = client.delete(f"{ALERTS}/rules/{rule_id}", params={"token": review.json()["token"]})
    assert done.status_code == 200, done.text
    left = done.json()["rule"]
    for target in (left or {}).get("targets", []):
        sync_and_apply(client, target["id"])
    wait_for(lambda: rule_now(client, rule_id) is None, "the rule to be gone", timeout=60)


def remove_contact_point(client, cp_id: str) -> None:
    review = client.get(f"{ALERTS}/contact-points/{cp_id}/delete-review")
    if review.status_code == 404:
        return
    assert review.status_code == 200, review.text
    done = client.delete(
        f"{ALERTS}/contact-points/{cp_id}", params={"token": review.json()["token"]}
    )
    assert done.status_code in (200, 204), done.text


@contextmanager
def alert_cleanup(client):
    """Collects what a test makes (rules, contact points, silences, projects) and removes it,
    through the API with its reviews, whatever the test did (newest first)."""
    made: dict[str, list] = {"rules": [], "contact_points": [], "silences": [], "projects": []}
    try:
        yield made
    finally:
        problems: list[str] = []

        def attempt(what: str, action) -> None:
            try:
                action()
            except BaseException as exc:  # noqa: BLE001 (every cleanup runs; failures are reported)
                problems.append(f"{what}: {exc}")

        for kind, ident, source_id in reversed(made["silences"]):
            params = {"source_id": source_id} if source_id else None
            attempt(
                "silence",
                lambda k=kind, i=ident, p=params: client.delete(
                    f"{ALERTS}/silences/{k}/{i}", params=p
                ),
            )
        for rule_id in reversed(made["rules"]):
            attempt("rule", lambda r=rule_id: remove_rule(client, r))
        for cp_id in reversed(made["contact_points"]):
            attempt("contact point", lambda c=cp_id: remove_contact_point(client, c))
        for project_id in reversed(made["projects"]):
            attempt("project", lambda p=project_id: delete_project(client, p))
        assert not problems, problems


def add_webhook(client, name: str, url: str) -> dict:
    response = client.post(
        f"{ALERTS}/contact-points", json={"name": name, "type": "webhook", "secrets": {"url": url}}
    )
    assert response.status_code == 201, response.text
    return response.json()


def tool_rules_for(target_id: str) -> list[dict]:
    """The `PrometheusRule` objects (label `release=kps`) that hold this target's group."""
    items = json.loads(
        kubectl("get", "prometheusrule", "-n", "monitoring", "-l", "release=kps", "-o", "json")
    )["items"]
    return [
        item
        for item in items
        if any(g["name"] == f"omnikrux-{target_id}" for g in item["spec"]["groups"])
    ]


def test_tool_rule_round_trip_on_kind(alert_client, alert_cluster, alert_tools, receiver):
    client = alert_client
    with alert_cleanup(client) as made:
        project = alert_project(
            client, alert_cluster, alert_tools, "Kind alerts tool", ["prometheus", "alertmanager"]
        )
        made["projects"].append(project["id"])
        rule = add_alert_rule(
            client,
            rule_body(
                project,
                "Live tool rule",
                "vector(1)",
                channel={"receiver": "live-check", "labels": LIVE_TEAM},
            ),
        )
        made["rules"].append(rule["id"])
        [target] = rule["targets"]

        sync_and_apply(client, target["id"])
        [held] = tool_rules_for(target["id"])
        assert held["metadata"]["labels"]["release"] == "kps"

        def firing():
            current = rule_now(client, rule["id"])
            return current is not None and current["targets"][0]["state"] == "firing"

        wait_for(firing, "the target to read firing", timeout=THREE_MINUTES, interval=5)
        reading = proxied(f"{OPERATOR_PROMETHEUS}:9090", "api/v1/rules?type=alert")
        names = [r["name"] for g in reading["data"]["groups"] for r in g["rules"]]
        assert "Live tool rule" in names

        def posted():
            return any(
                a["labels"].get("alertname") == "Live tool rule" and a["status"] == "firing"
                for body in receiver.taken("/alertmanager")
                for a in body.get("alerts", [])
            )

        wait_for(posted, "Alertmanager's webhook", timeout=THREE_MINUTES, interval=5)

        remove_rule(client, rule["id"])
        assert tool_rules_for(target["id"]) == []


def test_omnikrux_engine_on_kind(alert_client, alert_cluster, alert_tools, receiver):
    client = alert_client
    path = "/omnikrux"
    name = "Live engine rule"
    with alert_cleanup(client) as made:
        project = alert_project(
            client, alert_cluster, alert_tools, "Kind alerts engine", ["prometheus"]
        )
        made["projects"].append(project["id"])
        hook = add_webhook(client, "Live receiver", f"http://127.0.0.1:{RECEIVER_PORT}{path}")
        made["contact_points"].append(hook["id"])
        body = rule_body(
            project, name, "count(up)", engine="omnikrux", contact_point_ids=[hook["id"]]
        )
        rule = add_alert_rule(client, body)
        made["rules"].append(rule["id"])

        def statuses() -> list[str]:
            return [b["status"] for b in receiver.taken(path) if b.get("rule") == name]

        wait_for(lambda: statuses() == ["firing"], "one firing webhook", timeout=90, interval=2)

        # A silence on the rule: the instance reads silenced, and nothing more is sent.
        silence = client.post(
            f"{ALERTS}/silences",
            json={
                "where": {"kind": "omnikrux"},
                "matchers": f'alertname="{name}"',
                "ends_at": (datetime.now(UTC) + timedelta(minutes=30)).isoformat(),
                "comment": "live check",
            },
        )
        assert silence.status_code == 201, silence.text
        silence_id = silence.json()["id"]
        made["silences"].append(("omnikrux", silence_id, None))

        def silenced() -> bool:
            instances = rule_now(client, rule["id"])["targets"][0]["instances"]
            return bool(instances) and all(i["silenced"] for i in instances)

        wait_for(silenced, "the instance to read silenced", timeout=90, interval=2)
        assert statuses() == ["firing"]

        # The silence ends: still firing, so it is told again. Then the condition goes.
        ended = client.delete(f"{ALERTS}/silences/omnikrux/{silence_id}")
        assert ended.status_code == 204, ended.text
        wait_for(lambda: statuses() == ["firing", "firing"], "told again", timeout=90, interval=2)
        current = rule_now(client, rule["id"])
        calm = body | {
            "condition": EVERY_30S | {"threshold": 100000},
            "base_version": current["version"],
        }
        changed = client.put(f"{ALERTS}/rules/{rule['id']}", json=calm)
        assert changed.status_code == 200, changed.text
        wait_for(
            lambda: statuses() == ["firing", "firing", "resolved"],
            "one resolved webhook",
            timeout=90,
            interval=2,
        )


def test_alertmanager_silence_on_kind(alert_client, alert_cluster, alert_tools):
    client = alert_client
    with alert_cleanup(client) as made:
        project = alert_project(
            client,
            alert_cluster,
            alert_tools,
            "Kind alerts silence",
            ["prometheus", "alertmanager"],
        )
        made["projects"].append(project["id"])
        source_id = link_of(project, "alertmanager")["source_id"]
        created = client.post(
            f"{ALERTS}/silences",
            json={
                "where": {"kind": "alertmanager", "source_id": source_id},
                "matchers": 'alertname="omnikrux-live-silence-check"',
                "ends_at": (datetime.now(UTC) + timedelta(minutes=30)).isoformat(),
                "comment": "live check",
            },
        )
        assert created.status_code == 201, created.text
        silence_id = created.json()["id"]
        made["silences"].append(("alertmanager", silence_id, source_id))

        held = {s["id"]: s for s in proxied(f"{OPERATOR_ALERTMANAGER}:9093", "api/v2/silences")}
        assert held[silence_id]["status"]["state"] == "active"
        assert held[silence_id]["matchers"][0]["name"] == "alertname"
        listed = client.get(f"{ALERTS}/silences").json()
        assert silence_id in [s["id"] for s in listed["silences"]]

        ended = client.delete(
            f"{ALERTS}/silences/alertmanager/{silence_id}", params={"source_id": source_id}
        )
        assert ended.status_code == 204, ended.text
        held = {s["id"]: s for s in proxied(f"{OPERATOR_ALERTMANAGER}:9093", "api/v2/silences")}
        assert held[silence_id]["status"]["state"] == "expired"


def ruler_groups() -> list[str]:
    """The names of the groups the ruler holds. An empty ruler answers 404 ("no rule groups
    found"), which kubectl reports as NotFound: that is none."""
    try:  # the ruler lists in YAML
        path = "/api/v1/namespaces/monitoring/services/loki:3100/proxy/loki/api/v1/rules"
        rules = yaml.safe_load(kubectl("get", "--raw", path)) or {}
    except AssertionError as exc:
        if "NotFound" in str(exc):
            return []
        raise
    return [g["name"] for groups in rules.values() for g in groups]


def test_loki_ruler_on_kind(alert_client, alert_cluster, alert_tools):
    client = alert_client
    if "loki" not in alert_tools:
        pytest.skip(NO_RULER)
    with alert_cleanup(client) as made:
        project = alert_project(
            client, alert_cluster, alert_tools, "Kind alerts loki", ["loki", "alertmanager"]
        )
        made["projects"].append(project["id"])
        capability = client.get(
            f"{ALERTS}/capabilities",
            params={"scope_kind": "project", "scope_id": project["id"], "source_type": "loki"},
        ).json()
        if capability[0]["tool"] != "loki_ruler":
            pytest.skip(NO_RULER)
        rule = add_alert_rule(
            client,
            rule_body(
                project,
                "Live loki rule",
                'sum(count_over_time({job="omnikrux-live-check"}[5m]))',
                source={"type": "loki", "id": None},
                condition=EVERY_30S | {"every": "1m"},
            ),
        )
        made["rules"].append(rule["id"])
        [target] = rule["targets"]
        group = f"omnikrux-{target['id']}"

        wait_for(lambda: group in ruler_groups(), "the ruler to hold the group", timeout=60)

        def settled() -> bool:
            state = rule_now(client, rule["id"])["targets"][0]
            assert state["state"] != "error", state["message"]
            return state["state"] in ("ok", "firing")

        wait_for(settled, "the target to read ok or firing", timeout=THREE_MINUTES, interval=5)

        remove_rule(client, rule["id"])
        assert group not in ruler_groups()


# --- Import and export: the Grafana in kind's `monitoring` namespace ---------------------------
#
# The Grafana is an Argo CD app. Its folder, the dashboard `omnikrux-live` and the rule on its stat
# panel are provisioned through its Helm values, so they come back after every restart. It is read
# anonymously through the cluster (no token anywhere): see docs/guide/developer/monitoring.md.

NO_GRAFANA = (
    "Grafana isn't installed in the monitoring namespace (see docs/guide/developer/monitoring.md)."
)
LIVE_UID = "omnikrux-live"
LIVE_TITLE = "OmniKrux live check"


@pytest.fixture
def grafana_target(client, cluster) -> dict:
    """A Grafana as the setup step sends it: the cluster's `monitoring/grafana`, no sign-in.

    Skips only when the Service is missing; a Grafana that is there but not ready is a failure
    with discovery's words."""
    if "service/grafana" not in kubectl("-n", "monitoring", "get", "svc", "-o", "name").split():
        pytest.skip(NO_GRAFANA)
    found = client.get(f"{API}/discovery/{cluster}").json()["found"]
    grafana = next((t for t in found if t["type"] == "grafana" and t["service"] == "grafana"), None)
    assert grafana is not None, "Discovery doesn't list the Grafana service."
    assert grafana["state"] == "reachable", grafana["message"]
    assert (grafana["namespace"], grafana["port"], grafana["scheme"]) == (
        "monitoring",
        "80",
        "http",
    )
    return {
        "reach": "cluster",
        "cluster_id": cluster,
        "namespace": grafana["namespace"],
        "service": grafana["service"],
        "port": grafana["port"],
        "scheme": grafana["scheme"],
        "auth": {"type": "none"},
    }


@contextmanager
def grafana_cleanup(client):
    """Collects the ids of Grafana connections a test makes and removes them afterwards."""
    made: list[str] = []
    try:
        yield made
    finally:
        for grafana_id in made:
            assert client.delete(f"{API}/grafana/{grafana_id}").status_code in (204, 404)


def live_project(client, cluster: str, tools: dict, name: str) -> dict:
    sources = [{"source": new_source(cluster, tools[t]), "filter": ""} for t in tools]
    return set_up(client, cluster, name, sources)


def grafana_input(target: dict) -> dict:
    return {"kind": "grafana", "connection": target, "uids": [LIVE_UID]}


def choose(preview: dict, project: dict) -> list[dict]:
    """Each source the import names goes to the project's own source of that type."""
    return [
        {"key": s["key"], "source_id": link_of(project, s["type"])["source_id"], "leave_out": False}
        for s in preview["sources"]
    ]


def commit_body(preview: dict, project: dict, input: dict) -> dict:
    return {
        "input": input,
        "target": {"kind": "project", "id": project["id"]},
        "mapping": choose(preview, project),
        "dashboards": [
            {"key": d["key"], "title": d["title"], "digest": d["digest"]}
            for d in preview["dashboards"]
        ],
    }


def import_live(client, project: dict, target: dict, connections: list[str]) -> dict:
    """Preview then commit the live check dashboard; the saved dashboard.
    The Grafana connection the commit saved goes into `connections` as soon as it exists, so the
    cleanup removes it even when a later step fails."""
    input = grafana_input(target)
    body = {"input": input, "target": {"kind": "project", "id": project["id"]}}
    preview = client.post(f"{API}/import/preview", json=body)
    assert preview.status_code == 200, preview.text
    shown = preview.json()
    assert [d["problems"] for d in shown["dashboards"]] == [[]]
    committed = client.post(f"{API}/import/commit", json=commit_body(shown, project, input))
    assert committed.status_code == 201, committed.text
    result = committed.json()
    if result.get("grafana_id"):
        connections.append(result["grafana_id"])
    [made] = result["dashboards"]
    saved = client.get(f"{API}/dashboards/{made['id']}")
    assert saved.status_code == 200, saved.text
    return saved.json()


def test_grafana_is_found_and_lists_dashboards(client, cluster, grafana_target):
    listed = client.post(f"{API}/grafana/dashboards", json=grafana_target)
    assert listed.status_code == 200, listed.text
    titles = {d["uid"]: d["title"] for d in listed.json()["items"]}
    assert titles.get(LIVE_UID) == LIVE_TITLE


def test_import_from_the_cluster_grafana(client, cluster, tools, grafana_target):
    with project_cleanup(client) as made, grafana_cleanup(client) as connections:
        project = live_project(client, cluster, tools, "Kind Grafana import")
        made.append(project["id"])
        dashboard = import_live(client, project, grafana_target, connections)

        spec = dashboard["spec"]
        assert spec["title"] == LIVE_TITLE
        assert [p["type"] for p in spec["panels"]] == ["timeseries", "stat", "logs"]
        assert [v["name"] for v in spec["variables"]] == ["job"]
        stat = spec["panels"][1]
        assert draft_from_alert(stat["alert"]) == AlertDraft(
            query_ref=stat["queries"][0]["ref"],
            reducer="last",
            op="below",
            threshold=1,
            for_seconds=300,
            title="Targets down",
            message="Fewer than one target is up",
            severity="warning",
            window_seconds=None,
        )

        now = time.time()
        requests = [
            {
                "source_id": q["source"]["id"],
                "project_id": project["id"],
                "kind": "range",
                "query": q["expr"],
                "start": now - 3600,
                "end": now,
                "step": 60,
            }
            for p in spec["panels"]
            for q in p["queries"]
        ]
        assert len(requests) == 3
        for request, answer in zip(requests, run_batch(client, requests), strict=True):
            code = (answer.get("error") or {}).get("code")
            assert code != "bad_query", f"{request['query']}: {answer['error']}"


def test_export_and_import_round_trip(client, cluster, tools, grafana_target):
    with project_cleanup(client) as made, grafana_cleanup(client) as connections:
        first = live_project(client, cluster, tools, "Kind export first")
        made.append(first["id"])
        dashboard = import_live(client, first, grafana_target, connections)

        exported = client.post(f"{API}/export", json={"kind": "project", "id": first["id"]})
        assert exported.status_code == 200, exported.text
        assert exported.json()["dashboards"] == 1

        second = set_up(
            client,
            cluster,
            "Kind export second",
            [{"source_id": link["source_id"], "filter": ""} for link in first["links"]],
        )
        made.append(second["id"])
        text = json.dumps(exported.json()["export"])
        input = {"kind": "text", "text": text, "file_name": "round-trip.json", "via": "file"}
        body = {"input": input, "target": {"kind": "project", "id": second["id"]}}
        preview = client.post(f"{API}/import/preview", json=body)
        assert preview.status_code == 200, preview.text
        shown = preview.json()
        assert [d["problems"] for d in shown["dashboards"]] == [[]]
        committed = client.post(f"{API}/import/commit", json=commit_body(shown, second, input))
        assert committed.status_code == 201, committed.text
        [made_copy] = committed.json()["dashboards"]
        copied = client.get(f"{API}/dashboards/{made_copy['id']}").json()["spec"]

        def shape(spec: dict) -> list:
            return [
                (p["type"], p["title"], [q["expr"] for q in p["queries"]]) for p in spec["panels"]
            ]

        assert shape(copied) == shape(dashboard["spec"])


def test_update_from_source_with_no_change(client, cluster, tools, grafana_target):
    with project_cleanup(client) as made, grafana_cleanup(client) as connections:
        project = live_project(client, cluster, tools, "Kind Grafana update")
        made.append(project["id"])
        dashboard = import_live(client, project, grafana_target, connections)

        shown = client.post(
            f"{API}/import/preview", json={"input": grafana_input(grafana_target)}
        ).json()
        mapping = [
            {"key": s["key"], "source_id": link_of(project, s["type"])["source_id"]}
            for s in shown["sources"]
        ]
        preview = client.post(
            f"{API}/dashboards/{dashboard['id']}/update-from-source/preview",
            json={"mapping": mapping},
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["same"] is True


# --- Log views and empty reasons on the OpenTelemetry labels --------------------------------------

OTEL_NAMESPACE = "k8s_namespace_name"
OTEL_POD = "k8s_pod_name"
LOG_WINDOW = 6 * HOUR
LOG_STEP = 60
LOG_BUILTINS = {"__interval": "60s", "__rate_interval": "4m", "__range": "6h"}


def ready_document(client, project: dict, key: str) -> dict:
    return dashboard(client, ready_views(client, project)[key]["id"])["spec"]


def run_logs_panel(
    client, project: dict, document: dict, title: str, chosen: dict[str, str] | None = None
) -> list[dict]:
    """The answers of a ready-made panel over the last six hours, one per query; each query is
    sent to the source of its own type."""
    now = time.time()
    [panel] = [p for p in document["panels"] if p["title"] == title]
    requests = []
    for q in panel["queries"]:
        request = {
            "source_id": link_of(project, q["source"]["type"])["source_id"],
            "project_id": project["id"],
            "query": fill_in(q["expr"], document, chosen, LOG_BUILTINS),
        }
        if panel["type"] in ("bar", "table"):
            request |= {"kind": "instant", "time": now}
        else:
            request |= {"kind": "range", "start": now - LOG_WINDOW, "end": now, "step": LOG_STEP}
        if panel["type"] == "logs":
            request["limit"] = 100
        requests.append(request)
    results = run_batch(client, requests)
    for result in results:
        code = (result.get("error") or {}).get("code")
        assert code != "bad_query", f"{title}: {result['error']}"
    assert all(r["ok"] for r in results), results
    return [r["response"] for r in results]


def why_empty(client, project: dict, type: str, **body) -> dict:
    now = time.time()
    response = client.post(
        f"{API}/query/why-empty",
        json={
            "source_id": link_of(project, type)["source_id"],
            "project_id": project["id"],
            "start": now - HOUR,
            "end": now,
        }
        | body,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_logs_overview_runs_on_otel_labels(client, both_project):
    project = both_project
    views = ready_views(client, project)
    view = views["logs"]
    assert view["title"] == "Logs overview", view
    assert view["checked"], view["check_message"]
    assert view["notes"] == [], view
    document = dashboard(client, view["id"])["spec"]
    selectors = [q["expr"] for p in document["panels"] for q in p["queries"]]
    assert selectors and all(OTEL_NAMESPACE in text for text in selectors), selectors

    answers = {
        p["title"]: run_logs_panel(client, project, document, p["title"])
        for p in document["panels"]
    }
    assert answers["Log lines per second"][0]["series"], "no log lines per second on the cluster"


def test_pod_health_logs_use_otel_labels(client, both_project):
    project = both_project
    document = ready_document(client, project, "pods")
    [panel] = [p for p in document["panels"] if p["title"] == "Logs"]
    selector = panel["queries"][0]["expr"]
    assert OTEL_NAMESPACE in selector and OTEL_POD in selector, selector
    [answer] = run_logs_panel(client, project, document, "Logs", {"namespace": "monitoring"})
    lines = [line for stream in answer["streams"] for _, line in stream["entries"]]
    assert lines, "the Logs panel for namespace monitoring and every Pod returned no lines"


def test_pod_restarts_are_whole_numbers(client, both_project):
    project = both_project
    document = ready_document(client, project, "pods")
    [answer] = run_logs_panel(client, project, document, "Restarts")
    values = [p[1] for s in answer["series"] for p in s["points"] if p[1] is not None]
    if not values:
        pytest.skip("No Pod restarted in the last 6 hours, so there is nothing to check.")
    assert all(v == int(v) and v > 0 for v in values), sorted(set(values))


def test_why_empty_on_the_cluster(client, both_project):
    project = both_project
    never = why_empty(
        client, project, "prometheus",
        query="omnikrux_never_collected_total", metrics=["omnikrux_never_collected_total"],
    )  # fmt: skip
    assert never["reason"] == "missing_metric", never
    assert "omnikrux_never_collected_total" in never["message"]

    selector = f'{{{OTEL_POD}="omnikrux-no-such-pod"}}'
    nobody = why_empty(client, project, "loki", query=selector, selector=selector)
    assert nobody["reason"] == "no_streams", nobody

    throttled = "container_cpu_cfs_throttled_periods_total"
    present = query(client, project, "prometheus", kind="instant", query=f"count({throttled})")
    if present["series"]:
        pytest.skip(
            f"The cluster collects {throttled}, so there is no CPU throttling answer to check."
        )
    answer = why_empty(client, project, "prometheus", query=throttled, metrics=[throttled])
    assert answer["reason"] == "missing_metric", answer
    assert "CPU throttling" in answer["message"], answer


def test_catalog_lists_otel_streams(client, both_project):
    loki = catalog_of(client, both_project)["loki"]
    assert loki["stream_window_seconds"] == 604800, loki["stream_window_seconds"]
    streams = {s["name"]: s for s in loki["streams"]}
    assert OTEL_NAMESPACE in streams, sorted(streams)
    assert streams[OTEL_NAMESPACE]["values"], streams[OTEL_NAMESPACE]

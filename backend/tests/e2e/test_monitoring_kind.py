"""Monitoring against the Prometheus and Loki installed in kind's `monitoring` namespace."""

import re
import time
from contextlib import contextmanager

import pytest

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
BUILTINS = {"__interval": "30s", "__rate_interval": "2m", "__range": "1h"}


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


def fill_in(text: str, document: dict) -> str:
    """The query as the browser sends it: variables stand for every value (`.+`), the built-in
    ones for a one-hour range at step 30."""
    values = {v["name"]: ".+" for v in document["variables"]} | BUILTINS
    for name in sorted(values, key=len, reverse=True):
        text = text.replace("${" + name + "}", values[name]).replace("$" + name, values[name])
    return text


def panel_requests(project: dict, document: dict, now: float) -> list[tuple[dict, dict]]:
    """(panel, request) for every query of every panel, ready for `POST /query/batch`."""
    source_id = link_of(project, "prometheus")["source_id"]
    out = []
    for panel in document["panels"]:
        for q in panel["queries"]:
            request = {
                "source_id": source_id,
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
    assert CHECK_JOB in streams["job"]["values"], "push the log lines again (see live-check.md)"
    assert "level" in streams


def test_suggestion_templates_run_on_the_cluster(client, both_project):
    project = both_project
    loki_section = catalog_of(client, project)["loki"]
    writable = [s["name"] for s in loki_section["streams"] if re.match(IDENT, s["name"])]
    assert writable, "Loki lists no log label"
    label = next((name for name in STREAM_LABELS if name in writable), writable[0])
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
    assert answers["volume"]["response"]["series"], "push the log lines again (see live-check.md)"


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

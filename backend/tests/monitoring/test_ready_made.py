"""Ready-made views: valid generated documents that take a project's filter, which views a
project gets, what each is missing, and how they open, copy and sit in the tree."""

import re
from urllib.parse import quote

import pytest

from omnikrux.monitoring.dashboards.loki_labels import LokiFacts
from omnikrux.monitoring.dashboards.ready_made import (
    LOKI_EMPTY,
    LOKI_UNREAD,
    NEED_METRIC,
    NEED_NOTE,
    NEEDS,
    POD_LOGS_NO_LABELS,
    READY_ORDER,
    build_ready_made,
    loki_notes,
    parse_ready_id,
    ready_id,
    ready_keys,
)
from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import inject_logql, inject_promql
from omnikrux.monitoring.sources.connector import FieldCatalog

API = "/api/monitoring"
DASHBOARDS = f"{API}/dashboards"
FILTER = (Matcher("cluster", "=", "a"),)
READ_ONLY = "Ready-made views can't be changed. Copy one to edit it."
CANT_READ_ALL = "OmniKrux couldn't read every metric name, so it can't tell what's missing."
PROMETHEUS_KEYS = ["cluster", "nodes", "namespaces", "workloads", "pods"]

# The labels the test cluster's Loki holds over 7 days (OpenTelemetry Collector, plus
# `namespace` on old lines).
TEST_CLUSTER = frozenset(
    {
        "job",
        "level",
        "namespace",
        "service_name",
        "k8s_container_name",
        "k8s_daemonset_name",
        "k8s_deployment_name",
        "k8s_namespace_name",
        "k8s_pod_name",
        "k8s_replicaset_name",
        "k8s_statefulset_name",
        "service_instance_id",
        "service_namespace",
    }
)
UNREAD_REASON = "Can't reach Shop logs: the connection was refused."
FACTS = {
    "otel": LokiFacts(TEST_CLUSTER, None),
    "classic": LokiFacts(frozenset({"namespace", "pod", "container", "app", "level"}), None),
    "no level": LokiFacts(frozenset({"namespace", "pod", "app"}), None),
    "no labels": LokiFacts(frozenset(), None),
    "unread": LokiFacts(None, UNREAD_REASON),
}


def kinds_for(key):
    """(kind, has Loki, Loki facts) to build each view with."""
    if key == "nodes":
        return [("kubernetes", True, None), ("kubernetes", False, None), ("servers", False, None)]
    if key == "logs":
        return [
            (kind, True, facts) for kind in ("kubernetes", "custom") for facts in FACTS.values()
        ]
    if key == "pods":
        return [("kubernetes", False, None), ("kubernetes", True, None)] + [
            ("kubernetes", True, facts) for facts in FACTS.values()
        ]
    return [("kubernetes", True, None), ("kubernetes", False, None)]


@pytest.mark.parametrize("key", READY_ORDER)
def test_every_ready_made_view_is_a_valid_document(key):
    for kind, loki, facts in kinds_for(key):
        doc = build_ready_made(key, kind=kind, has_loki=loki, loki=facts)
        assert validate_dashboard(doc, owner_kind="project") == doc
        assert all(s["id"] is None for s in sources_of(doc))
        assert [p["id"] for p in doc["panels"]] == [f"p-{i + 1}" for i in range(len(doc["panels"]))]


def sources_of(doc):
    for variable in doc["variables"]:
        yield variable["source"]
    for panel in doc["panels"]:
        for query in panel["queries"]:
            yield query["source"]


@pytest.mark.parametrize("key", READY_ORDER)
def test_every_ready_made_query_takes_a_filter(key):
    for kind, loki, facts in kinds_for(key):
        doc = build_ready_made(key, kind=kind, has_loki=loki, loki=facts)
        for panel in doc["panels"]:
            for query in panel["queries"]:
                expr = re.sub(r"\$(?!__)\w+", ".+", query["expr"]).replace("$__rate_interval", "4m")
                expr = expr.replace("$__interval", "1m").replace("$__range", "1h")
                inject = inject_logql if query["source"]["type"] == "loki" else inject_promql
                filtered = inject(expr, FILTER)
                bodies = re.findall(r"\{([^}]*)\}", filtered)
                assert bodies, filtered
                assert all('cluster="a"' in body for body in bodies), filtered


def test_restarts_in_the_last_hour_are_whole_numbers():
    doc = build_ready_made("cluster", kind="kubernetes", has_loki=False)
    panel = next(p for p in doc["panels"] if p["title"] == "Restarts in the last hour")
    assert panel["type"] == "table"
    assert panel["options"]["decimals"] == 0


RESTARTS = (
    "sum by ({by}) (kube_pod_container_status_restarts_total{{{sel}}}"
    " - kube_pod_container_status_restarts_total{{{sel}}} offset $__interval) > 0"
)


def test_pod_restarts_count_whole_restarts_per_step():
    doc = build_ready_made("pods", kind="kubernetes", has_loki=False)
    panel = next(p for p in doc["panels"] if p["title"] == "Restarts")
    [query] = panel["queries"]
    sel = 'namespace=~"$namespace",pod=~"$pod"'
    assert query["expr"] == RESTARTS.format(by="namespace, pod", sel=sel)
    assert "increase(" not in query["expr"]
    assert query["legend"] == "{{namespace}}/{{pod}}"
    options = panel["options"]
    assert (options["style"], options["decimals"], options["unit"]) == ("bars", 0, "short")


def test_namespace_restarts_use_the_same_count():
    doc = build_ready_made("namespaces", kind="kubernetes", has_loki=False)
    panel = next(p for p in doc["panels"] if p["title"] == "Container restarts")
    [query] = panel["queries"]
    assert query["expr"] == RESTARTS.format(by="namespace", sel='namespace=~"$namespace"')
    assert "increase(" not in query["expr"]
    assert query["legend"] == "{{namespace}}"
    options = panel["options"]
    assert (options["style"], options["decimals"], options["unit"]) == ("bars", 0, "short")


def test_logs_errors_and_warnings_are_bars():
    for loki in (FACTS["otel"], FACTS["classic"], FACTS["no level"]):
        doc = build_ready_made("logs", kind="kubernetes", has_loki=True, loki=loki)
        panel = next(p for p in doc["panels"] if p["title"] == "Errors and warnings")
        assert panel["options"]["style"] == "bars"


def test_ready_keys():
    assert ready_keys("kubernetes", True, False) == tuple(PROMETHEUS_KEYS)
    assert ready_keys("kubernetes", True, True) == (*PROMETHEUS_KEYS, "logs")
    assert ready_keys("kubernetes", True, True) == READY_ORDER
    for kind in ("docker", "servers", "custom"):
        assert ready_keys(kind, True, True) == ("nodes", "logs")
        assert ready_keys(kind, True, False) == ("nodes",)
    for kind in ("kubernetes", "docker", "servers", "custom"):
        assert ready_keys(kind, False, True) == ("logs",)
        assert ready_keys(kind, False, False) == ()
    assert READY_ORDER == ("cluster", "nodes", "namespaces", "workloads", "pods", "logs")


def test_ready_ids_round_trip():
    assert ready_id("p1", "pods") == "ready:p1:pods"
    assert parse_ready_id("ready:p1:pods") == ("p1", "pods")
    for other in ("p1", "ready:p1", "ready:p1:nope", "ready::pods", "x:p1:pods", "ready:a:b:pods"):
        assert parse_ready_id(other) is None


def test_pod_health_has_logs_only_with_loki():
    with_logs = build_ready_made("pods", kind="kubernetes", has_loki=True)
    without = build_ready_made("pods", kind="kubernetes", has_loki=False)
    assert [p["type"] for p in with_logs["panels"]].count("logs") == 1
    assert with_logs["panels"][-1]["options"]["limit"] == 200
    assert with_logs["panels"][-1]["queries"][0]["expr"] == '{namespace=~"$namespace", pod=~"$pod"}'
    assert "logs" not in [p["type"] for p in without["panels"]]
    assert len(with_logs["panels"]) == len(without["panels"]) + 1


def test_node_health_outside_kubernetes_has_no_conditions_table():
    kube = build_ready_made("nodes", kind="kubernetes", has_loki=False)
    servers = build_ready_made("nodes", kind="servers", has_loki=False)
    assert [p["title"] for p in kube["panels"]][-1] == "Node conditions"
    assert "Node conditions" not in [p["title"] for p in servers["panels"]]
    assert len(kube["panels"]) == len(servers["panels"]) + 1
    assert kube["title"] == "Node health" and kube["variables"][0]["name"] == "instance"


def test_needs_and_notes():
    assert NEEDS["nodes"] == ("node_exporter",)
    assert NEED_METRIC["cadvisor"] == "container_cpu_usage_seconds_total"
    assert NEED_NOTE["kube_state"].startswith("kube-state-metrics isn't reporting")


async def kube_project(http, cluster_id, fake_prometheus, name="Cluster apps"):
    source = await http.post(
        f"{API}/sources",
        json={"type": "prometheus", "reach": "url", "url": fake_prometheus.url, "name": name},
    )
    assert source.status_code == 201, source.text
    sources = [{"source_id": source.json()["id"], "filter": 'cluster="a"'}]
    project = await http.post(
        f"{API}/setup",
        json={"name": name, "kind": "kubernetes", "cluster_id": cluster_id, "sources": sources},
    )
    assert project.status_code == 201, project.text
    return project.json()


async def test_a_custom_project_gets_only_node_health(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert [v["key"] for v in views] == ["nodes"]
    assert views[0]["id"] == f"ready:{pid}:nodes" and views[0]["title"] == "Node health"
    missing = await http.get(f"{DASHBOARDS}/{quote(f'ready:{pid}:cluster', safe='')}")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "not_found"


async def test_ready_made_lists_what_is_missing(monitoring_app, kube_cluster, fake_prometheus):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    pid = project["id"]
    fake_prometheus.label_values["__name__"] = ["kube_pod_info", "up"]
    response = await http.get(f"{API}/projects/{pid}/ready-made")
    assert response.status_code == 200, response.text
    views = response.json()
    assert [v["key"] for v in views] == PROMETHEUS_KEYS
    pods = next(v for v in views if v["key"] == "pods")
    assert pods["missing"] == ["cadvisor"]
    assert pods["notes"] == [
        "Container usage from the kubelet (cAdvisor) isn't collected, so CPU and memory stay empty."
    ]
    assert pods["id"] == f"ready:{pid}:pods" and pods["checked"] is True
    assert pods["check_message"] is None
    assert pods["title"] == "Pod health"
    assert pods["description"] == "Readiness, restarts, waiting reasons and resource use per Pod."
    nodes = next(v for v in views if v["key"] == "nodes")
    assert nodes["missing"] == ["node_exporter"] and nodes["notes"] == [NEED_NOTE["node_exporter"]]
    # Every metric needed is reported: nothing is missing.
    fake_prometheus.label_values["__name__"] = list(NEED_METRIC.values())
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert all(v["missing"] == [] and v["notes"] == [] and v["checked"] for v in views)


async def test_ready_made_with_an_unreachable_source_says_so(monitoring_app, kube_cluster):
    http, _ = monitoring_app

    class Dead:
        url = "http://127.0.0.1:1"

    project = await kube_project(http, kube_cluster, Dead())
    views = (await http.get(f"{API}/projects/{project['id']}/ready-made")).json()
    assert len(views) == 5
    for view in views:
        assert view["checked"] is False and view["missing"] == [] and view["notes"] == []
        assert view["check_message"].startswith("Can't reach")


async def test_ready_made_never_invents_notes_from_a_cut_catalog(
    monitoring_app, kube_cluster, fake_prometheus
):
    http, app = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    connector = app.state.monitoring.connectors.get("prometheus")
    asked = []

    async def cut(t, *, matchers, limit=2000):
        asked.append(limit)
        return FieldCatalog((), (), True)

    connector.describe_fields = cut
    views = (await http.get(f"{API}/projects/{project['id']}/ready-made")).json()
    assert asked == [100_000]
    for view in views:
        assert view["checked"] is False and view["missing"] == [] and view["notes"] == []
        assert view["check_message"] == CANT_READ_ALL


async def test_ready_made_without_prometheus_is_empty(monitoring_app, kube_cluster):
    http, _ = monitoring_app
    made = await http.post(
        f"{API}/setup",
        json={"name": "Bare", "kind": "kubernetes", "cluster_id": kube_cluster, "sources": []},
    )
    assert made.status_code == 201, made.text
    assert (await http.get(f"{API}/projects/{made.json()['id']}/ready-made")).json() == []
    assert (await http.get(f"{API}/projects/nope/ready-made")).status_code == 404


async def test_ready_made_opens_and_copies(monitoring_app, kube_cluster, fake_prometheus):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    pid = project["id"]
    url = f"{DASHBOARDS}/{quote(f'ready:{pid}:cluster', safe='')}"

    opened = await http.get(url)
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert body["ready_made"] is True and body["version"] == 0
    assert body["created_at"] is None and body["updated_at"] is None
    assert body["id"] == f"ready:{pid}:cluster" and body["title"] == "Cluster health"
    assert body["owner_kind"] == "project" and body["owner_id"] == pid
    assert body["owner_name"] == "Cluster apps"
    assert body["spec"] == build_ready_made("cluster", kind="kubernetes", has_loki=False)

    save = await http.put(url, json={"base_version": 0, "spec": body["spec"]})
    assert save.status_code == 409
    assert save.json()["detail"] == {"code": "read_only", "message": READ_ONLY}
    gone = await http.delete(f"{url}?version=0")
    assert gone.status_code == 409 and gone.json()["detail"]["code"] == "read_only"
    restore = await http.post(f"{url}/versions/1/restore", json={"base_version": 0})
    assert restore.status_code == 409 and restore.json()["detail"]["code"] == "read_only"

    titles = []
    for _ in range(2):
        copied = await http.post(
            f"{DASHBOARDS}/copy",
            json={"from_id": f"ready:{pid}:cluster", "owner_kind": "project", "owner_id": pid},
        )
        assert copied.status_code == 201, copied.text
        assert copied.json()["ready_made"] is False
        titles.append(copied.json()["title"])
    assert titles == ["Cluster health", "Cluster health (2)"]
    versions = (await http.get(f"{DASHBOARDS}/{copied.json()['id']}/versions")).json()
    assert versions[0]["origin"] == "copied" and versions[0]["copied_from"] == "Cluster health"

    absent = await http.post(
        f"{DASHBOARDS}/copy",
        json={"from_id": f"ready:{pid}:nope", "owner_kind": "project", "owner_id": pid},
    )
    assert absent.status_code == 404 and absent.json()["detail"]["code"] == "not_found"


async def test_a_ready_made_copy_goes_to_another_owner(
    monitoring_app, kube_cluster, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    group = await http.post(f"{API}/groups", json={"name": "Ops", "project_ids": [project["id"]]})
    copied = await http.post(
        f"{DASHBOARDS}/copy",
        json={
            "from_id": f"ready:{project['id']}:pods",
            "owner_kind": "group",
            "owner_id": group.json()["id"],
        },
    )
    assert copied.status_code == 201, copied.text
    assert copied.json()["title"] == "Pod health" and copied.json()["owner_kind"] == "group"


async def test_tree_appends_ready_made_after_saved(monitoring_app, kube_cluster, fake_prometheus):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    pid = project["id"]
    saved = await http.post(
        DASHBOARDS,
        json={
            "owner_kind": "project",
            "owner_id": pid,
            "spec": {"schemaVersion": 1, "title": "Zebra"},
        },
    )
    assert saved.status_code == 201, saved.text
    [tree_project] = (await http.get(f"{API}/tree")).json()["projects"]
    got = tree_project["dashboards"]
    assert got[0] == {"id": saved.json()["id"], "title": "Zebra", "ready_made": False}
    assert got[1:] == [
        {"id": f"ready:{pid}:{key}", "title": title, "ready_made": True}
        for key, title in (
            ("cluster", "Cluster health"),
            ("nodes", "Node health"),
            ("namespaces", "Namespace health"),
            ("workloads", "Workload health"),
            ("pods", "Pod health"),
        )
    ]


# --- The Logs overview and Pod health's Logs panel -----------------------------------------------


def loki_exprs(doc):
    return [q["expr"] for p in doc["panels"] for q in p["queries"] if q["source"]["type"] == "loki"]


def by_title(doc):
    return {p["title"]: p for p in doc["panels"]}


def test_ready_made_copy():
    assert LOKI_UNREAD == (
        "OmniKrux couldn't read this Loki's labels ({reason}), so its log panels assume "
        "namespace and pod labels and may stay empty."
    )
    assert LOKI_EMPTY == (
        "This Loki holds no log streams for this project from the last 7 days, so this view "
        "stays empty until logs arrive."
    )
    assert POD_LOGS_NO_LABELS == (
        "This project's log streams from the last 7 days have no Pod labels (k8s_namespace_name "
        "and k8s_pod_name, or namespace and pod), so the Logs panel stays empty."
    )


def test_logs_overview_uses_otel_labels():
    doc = build_ready_made("logs", kind="kubernetes", has_loki=True, loki=FACTS["otel"])
    assert doc["title"] == "Logs overview"
    assert doc["description"] == (
        "Log lines per second, errors and warnings, the noisiest streams and recent error lines."
    )
    assert doc["variables"] == []
    panels = by_title(doc)
    assert list(panels) == [
        "Log lines per second",
        "Errors and warnings",
        "Noisiest streams",
        "Recent error lines",
    ]
    exprs = loki_exprs(doc)
    assert exprs and all("k8s_namespace_name" in e for e in exprs)
    every = [q["source"] for p in doc["panels"] for q in p["queries"]]
    assert all(source == {"type": "loki", "id": None} for source in every)
    sel = '{k8s_namespace_name=~".+"}'
    rate = panels["Log lines per second"]
    assert (rate["type"], rate["layout"]) == ("timeseries", {"x": 0, "y": 0, "w": 24, "h": 8})
    assert rate["queries"][0]["expr"] == (
        f"sum by (k8s_namespace_name) (rate({sel}[$__rate_interval]))"
    )
    assert rate["queries"][0]["legend"] == "{{k8s_namespace_name}}"
    assert rate["options"]["unit"] == "short"
    errors = panels["Errors and warnings"]
    assert (errors["type"], errors["layout"]) == ("timeseries", {"x": 0, "y": 8, "w": 12, "h": 8})
    [query] = errors["queries"]
    assert query["expr"] == (
        'sum by (level) (count_over_time({k8s_namespace_name=~".+", '
        'level=~"(?i)(error|err|fatal|critical|crit|warn|warning)"}[$__interval]))'
    )
    assert query["legend"] == "{{level}}"
    assert errors["options"]["style"] == "bars" and errors["options"]["decimals"] == 0
    noisy = panels["Noisiest streams"]
    assert (noisy["type"], noisy["layout"]) == ("bar", {"x": 12, "y": 8, "w": 12, "h": 8})
    assert noisy["queries"][0]["expr"] == (
        f"topk(10, sum by (k8s_namespace_name) (count_over_time({sel}[$__range])))"
    )
    assert noisy["queries"][0]["legend"] == "{{k8s_namespace_name}}"
    assert noisy["options"]["decimals"] == 0
    recent = panels["Recent error lines"]
    assert (recent["type"], recent["layout"]) == ("logs", {"x": 0, "y": 16, "w": 24, "h": 10})
    assert recent["queries"][0]["expr"] == (
        '{k8s_namespace_name=~".+", level=~"(?i)(error|err|fatal|critical|crit)"}'
    )
    assert recent["options"]["limit"] == 100


def test_logs_overview_groups_by_what_the_loki_has():
    classic = build_ready_made("logs", kind="custom", has_loki=True, loki=FACTS["classic"])
    assert all('namespace=~".+"' in e for e in loki_exprs(classic))
    # No Pod labels: the first of the group labels it has.
    only_job = LokiFacts(frozenset({"job", "severity"}), None)
    doc = build_ready_made("logs", kind="servers", has_loki=True, loki=only_job)
    assert all('{job=~".+"' in e for e in loki_exprs(doc))
    assert by_title(doc)["Errors and warnings"]["queries"][0]["legend"] == "{{severity}}"
    # No labels at all: `job`. Unread (or not read): the classic set's `namespace`.
    cases = ((FACTS["no labels"], "job"), (FACTS["unread"], "namespace"), (None, "namespace"))
    for facts, group in cases:
        doc = build_ready_made("logs", kind="custom", has_loki=True, loki=facts)
        rate = by_title(doc)["Log lines per second"]["queries"][0]
        assert rate["expr"] == f'sum by ({group}) (rate({{{group}=~".+"}}[$__rate_interval]))'


def test_logs_overview_falls_back_to_line_filters():
    for facts in (FACTS["no level"], FACTS["unread"], FACTS["no labels"]):
        doc = build_ready_made("logs", kind="kubernetes", has_loki=True, loki=facts)
        errors = by_title(doc)["Errors and warnings"]["queries"]
        group = "job" if facts is FACTS["no labels"] else "namespace"
        sel = f'{{{group}=~".+"}}'
        assert [(q["ref"], q["expr"], q["legend"]) for q in errors] == [
            (
                "A",
                f'sum(count_over_time({sel} |~ "(?i)(error|fatal|panic)" [$__interval]))',
                "Errors",
            ),
            ("B", f'sum(count_over_time({sel} |~ "(?i)warn" [$__interval]))', "Warnings"),
        ]
        recent = by_title(doc)["Recent error lines"]["queries"][0]["expr"]
        assert recent == f'{sel} |~ "(?i)(error|fatal|panic)"'


def test_pod_health_logs_follow_the_label_set():
    def logs_expr(facts):
        doc = build_ready_made("pods", kind="kubernetes", has_loki=True, loki=facts)
        return by_title(doc)["Logs"]["queries"][0]["expr"]

    otel = '{k8s_namespace_name=~"$namespace", k8s_pod_name=~"$pod"}'
    classic = '{namespace=~"$namespace", pod=~"$pod"}'
    assert logs_expr(FACTS["otel"]) == otel
    assert logs_expr(FACTS["classic"]) == classic
    # Unread, or no Pod labels: the classic set, and the notes say so.
    for facts in (FACTS["unread"], FACTS["no labels"], LokiFacts(frozenset({"job"}), None), None):
        assert logs_expr(facts) == classic


def test_loki_notes():
    unread = [LOKI_UNREAD.format(reason=UNREAD_REASON)]
    assert loki_notes("logs", FACTS["unread"]) == unread
    assert loki_notes("pods", FACTS["unread"]) == unread
    assert loki_notes("logs", FACTS["no labels"]) == [LOKI_EMPTY]
    assert loki_notes("pods", FACTS["no labels"]) == [POD_LOGS_NO_LABELS]
    job_only = LokiFacts(frozenset({"job", "namespace"}), None)
    assert loki_notes("pods", job_only) == [POD_LOGS_NO_LABELS]
    assert loki_notes("logs", job_only) == []
    for key in ("logs", "pods"):
        assert loki_notes(key, FACTS["otel"]) == [] and loki_notes(key, FACTS["classic"]) == []
        assert loki_notes(key, None) == []
    for key in PROMETHEUS_KEYS[:4]:
        assert loki_notes(key, FACTS["unread"]) == []


async def add_loki(http, url: str, name: str = "Shop logs") -> str:
    source = await http.post(
        f"{API}/sources", json={"type": "loki", "reach": "url", "url": url, "name": name}
    )
    assert source.status_code == 201, source.text
    return source.json()["id"]


async def link_loki(http, pid: str, loki_id: str) -> None:
    linked = await http.put(
        f"{API}/projects/{pid}/sources/{loki_id}", json={"filter": 'cluster="a"'}
    )
    assert linked.status_code == 200, linked.text


async def test_a_loki_only_project_gets_the_logs_overview(
    monitoring_app, kube_cluster, fake_loki, fake_prometheus
):
    http, _ = monitoring_app
    loki_id = await add_loki(http, fake_loki.url)
    made = await http.post(
        f"{API}/setup",
        json={
            "name": "Logs only",
            "kind": "kubernetes",
            "cluster_id": kube_cluster,
            "sources": [{"source_id": loki_id, "filter": 'cluster="a"'}],
        },
    )
    assert made.status_code == 201, made.text
    pid = made.json()["id"]
    fake_loki.series = [{"k8s_namespace_name": "shop", "k8s_pod_name": "api-1", "level": "info"}]

    [tree_project] = (await http.get(f"{API}/tree")).json()["projects"]
    assert tree_project["dashboards"] == [
        {"id": f"ready:{pid}:logs", "title": "Logs overview", "ready_made": True}
    ]
    opened = await http.get(f"{DASHBOARDS}/{quote(f'ready:{pid}:logs', safe='')}")
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert body["ready_made"] is True and body["title"] == "Logs overview"
    found = LokiFacts(frozenset({"k8s_namespace_name", "k8s_pod_name", "level"}), None)
    assert body["spec"] == build_ready_made("logs", kind="kubernetes", has_loki=True, loki=found)
    for other in ("pods", "cluster"):
        gone = await http.get(f"{DASHBOARDS}/{quote(f'ready:{pid}:{other}', safe='')}")
        assert gone.status_code == 404

    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert views == [
        {
            "key": "logs",
            "id": f"ready:{pid}:logs",
            "title": "Logs overview",
            "description": (
                "Log lines per second, errors and warnings, the noisiest streams and recent "
                "error lines."
            ),
            "missing": [],
            "notes": [],
            "checked": True,
            "check_message": None,
        }
    ]
    assert fake_prometheus.requests == []
    series = [r for r in fake_loki.requests if r.path == "/loki/api/v1/series"]
    assert series and all(r.params["match[]"] == ['{cluster="a"}'] for r in series)


async def test_logs_overview_says_when_labels_were_unread(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    await link_loki(http, pid, await add_loki(http, "http://127.0.0.1:1"))
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert [v["key"] for v in views] == ["nodes", "logs"]
    logs = views[1]
    assert logs["checked"] is False and logs["missing"] == []
    [note] = logs["notes"]
    reason = note.removeprefix("OmniKrux couldn't read this Loki's labels (").split("), so")[0]
    assert reason.startswith("Can't reach Shop logs")
    assert logs["notes"] == [LOKI_UNREAD.format(reason=reason)]
    # The note carries the reason; it isn't said twice.
    assert logs["check_message"] is None
    # The view still opens, on the classic labels.
    opened = await http.get(f"{DASHBOARDS}/{quote(f'ready:{pid}:logs', safe='')}")
    assert opened.status_code == 200, opened.text
    assert opened.json()["spec"] == build_ready_made("logs", kind="custom", has_loki=True)


async def test_logs_overview_says_when_loki_holds_nothing(
    monitoring_app, linked_project, fake_loki
):
    http, _ = monitoring_app
    pid = linked_project.project_id
    await link_loki(http, pid, await add_loki(http, fake_loki.url))
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    logs = next(v for v in views if v["key"] == "logs")
    assert logs["notes"] == [LOKI_EMPTY] and logs["checked"] is True


async def test_pod_health_says_when_loki_has_no_pod_labels(
    monitoring_app, kube_cluster, fake_prometheus, fake_loki
):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    pid = project["id"]
    await link_loki(http, pid, await add_loki(http, fake_loki.url))
    fake_prometheus.label_values["__name__"] = list(NEED_METRIC.values())
    fake_loki.series = [{"job": "shop/api", "namespace": "shop"}]
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert [v["key"] for v in views] == list(READY_ORDER)
    pods = next(v for v in views if v["key"] == "pods")
    assert pods["notes"] == [POD_LOGS_NO_LABELS] and pods["missing"] == []
    assert pods["checked"] is True
    assert all(v["notes"] == [] for v in views if v["key"] != "pods")

    # With the OpenTelemetry labels, the Logs panel uses them and nothing is said.
    fake_loki.series = [{"k8s_namespace_name": "shop", "k8s_pod_name": "api-1"}]
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert next(v for v in views if v["key"] == "pods")["notes"] == []
    opened = await http.get(f"{DASHBOARDS}/{quote(f'ready:{pid}:pods', safe='')}")
    logs = by_title(opened.json()["spec"])["Logs"]
    assert logs["queries"][0]["expr"] == '{k8s_namespace_name=~"$namespace", k8s_pod_name=~"$pod"}'

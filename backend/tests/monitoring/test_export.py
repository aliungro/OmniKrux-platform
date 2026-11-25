"""Export: a dashboard, a project or a group as an OmniKrux export file. Sources are named by
keys, never by ids; the file never carries a secret; contact points go by name; every export is
audited; and the file reads back as an import would read it."""

import itertools
import logging
from datetime import UTC, datetime, timedelta

from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.query.filters import parse_matchers
from omnikrux.monitoring.sources.store import NewSource
from omnikrux.monitoring.sources.types import ClusterTarget, SourceSecrets
from omnikrux.monitoring.transfer import export as export_module
from omnikrux.monitoring.transfer.alerts import import_alert
from omnikrux.monitoring.transfer.envelope import read_envelope
from omnikrux.monitoring.transfer.export import export_file_name
from tests.monitoring.test_panel_alerts import ALERT
from tests.monitoring.test_rules_api import as_tool, monitoring_records

API = "/api/monitoring"
EXPORT = f"{API}/export"
DASHBOARDS = f"{API}/dashboards"
CONTACT_POINTS = f"{API}/alerts/contact-points"
EXPORT_GONE = "That dashboard, project or group no longer exists."
PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n"
SOURCE_KEYS = [
    "key",
    "type",
    "name",
    "reach",
    "url",
    "cluster",
    "pathPrefix",
    "auth",
    "headerNames",
]


def query(ref: str, source_id: str | None, kind: str = "prometheus") -> dict:
    expr = 'sum(rate({app="api"}[5m]))' if kind == "loki" else "rate(http_seconds_sum[5m])"
    return {"ref": ref, "source": {"type": kind, "id": source_id}, "expr": expr}


def panel(id: str, queries: list[dict], *, x: int = 0, alert=None) -> dict:
    return {
        "id": id,
        "type": "timeseries",
        "title": f"Panel {id}",
        "layout": {"x": x, "y": 0, "w": 6, "h": 4},
        "queries": queries,
        "alert": alert,
    }


def board(title: str, *panels: dict) -> dict:
    return {"schemaVersion": 1, "title": title, "panels": list(panels)}


async def create(http, owner_id: str, spec: dict, kind: str = "project") -> dict:
    r = await http.post(DASHBOARDS, json={"owner_kind": kind, "owner_id": owner_id, "spec": spec})
    assert r.status_code == 201, r.text
    return r.json()


async def export(http, kind: str, id: str) -> dict:
    r = await http.post(EXPORT, json={"kind": kind, "id": id})
    assert r.status_code == 200, r.text
    return r.json()


_order = itertools.count(1)


async def link(services, project_id: str, source_id: str, filter: str) -> None:
    """Link with the filter; links made here are listed in the order they were made."""
    created = datetime.now(UTC) + timedelta(seconds=next(_order))
    await services.projects.link(
        project_id, source_id, parse_matchers(filter), "user", created_at=created
    )


async def test_export_never_carries_secrets(monitoring_app, kube_cluster, caplog):
    caplog.set_level(logging.DEBUG, logger="omnikrux")
    http, app = monitoring_app
    services = app.state.monitoring
    project = await services.projects.create("prod-east", "kubernetes", kube_cluster)
    news = [
        NewSource(
            name="Metrics",
            type="prometheus",
            reach="url",
            url="https://metrics.example.invalid",
            auth_type="bearer",
            header_names=("X-Scope-OrgID",),
            secrets=SourceSecrets(token="tok-SECRET-6", headers={"X-Scope-OrgID": "hv-SECRET-7"}),
        ),
        NewSource(
            name="Logs",
            type="loki",
            reach="url",
            url="https://logs.example.invalid",
            auth_type="basic",
            username="user-SECRET-8",
            secrets=SourceSecrets(password="pw-SECRET-9"),
        ),
        NewSource(
            name="Thanos",
            type="prometheus",
            reach="url",
            url="https://thanos.example.invalid",
            auth_type="mtls",
            client_cert_pem=PEM,
            ca_pem=PEM,
            secrets=SourceSecrets(client_key_pem="key-SECRET-10"),
        ),
        NewSource(
            name="Mimir",
            type="prometheus",
            reach="url",
            url="https://mimir.example.invalid",
            auth_type="api_key",
            header_name="X-Api-Key",
            secrets=SourceSecrets(api_key="ak-SECRET-11"),
        ),
        NewSource(
            name="In cluster",
            type="prometheus",
            reach="cluster",
            cluster=ClusterTarget(kube_cluster, "monitoring", "prometheus-server", "80", "http"),
        ),
    ]
    ids = []
    for new in news:
        ids.append((await services.sources.create(new)).id)
        await link(services, project.id, ids[-1], 'namespace="shop"')
    await create(http, project.id, board("API", panel("p-1", [query("A", ids[0])])))
    await create(http, project.id, board("Logs", panel("p-1", [query("A", ids[1], "loki")])))

    r = await http.post(EXPORT, json={"kind": "project", "id": project.id})
    assert r.status_code == 200, r.text
    text = r.text + (await http.get("/api/audit")).text + caplog.text
    private = (
        "tok-SECRET-6",
        "hv-SECRET-7",
        "user-SECRET-8",
        "pw-SECRET-9",
        "key-SECRET-10",
        "ak-SECRET-11",
        "BEGIN CERTIFICATE",
        kube_cluster,
        *ids,
    )
    for secret in private:
        assert secret not in text
    out = r.json()["export"]
    src = out["sources"][0]
    assert list(src) == SOURCE_KEYS
    assert src["auth"] == "bearer" and src["headerNames"] == ["X-Scope-OrgID"]
    assert [s["auth"] for s in out["sources"]] == ["bearer", "basic", "mtls", "api_key", "none"]
    # An API-key source's header name stays out: the import asks for it with the key.
    assert "X-Api-Key" not in r.text
    cluster_name = (await app.state.registry.get(kube_cluster)).name
    assert out["sources"][4]["cluster"] == {
        "name": cluster_name,
        "namespace": "monitoring",
        "service": "prometheus-server",
        "port": "80",
        "scheme": "http",
    }
    assert out["project"] == {
        "name": "prod-east",
        "kind": "kubernetes",
        "cluster": cluster_name,
        "links": [{"source": f"src-{i}", "filter": 'namespace="shop"'} for i in range(1, 6)],
    }


async def test_a_cluster_omnikrux_no_longer_knows_is_null(monitoring_app, linked_project):
    http, app = monitoring_app
    services = app.state.monitoring
    target = ClusterTarget("gone-cluster", "monitoring", "prometheus-server", "80", "http")
    source = await services.sources.create(
        NewSource(name="Old", type="prometheus", reach="cluster", cluster=target)
    )
    await link(services, linked_project.project_id, source.id, 'cluster="a"')
    await create(http, linked_project.project_id, board("API", panel("p-1", [query("A", None)])))
    out = (await export(http, "project", linked_project.project_id))["export"]
    assert out["sources"][1]["cluster"]["name"] is None
    assert "gone-cluster" not in str(out)
    [_, old] = read_envelope(out).sources
    assert old.cluster is not None and old.cluster.name is None


async def test_export_replaces_source_ids_with_keys(monitoring_app, linked_project_with_loki):
    http, app = monitoring_app
    shop = linked_project_with_loki
    prom, loki = shop.source_id, shop.loki_source_id
    made = await create(
        http,
        shop.project_id,
        board(
            "Shop",
            panel("p-1", [query("A", loki, "loki")]),
            panel("p-2", [query("A", prom), query("B", None)], x=6),
        ),
    )

    dashboard = await export(http, "dashboard", made["id"])
    out = dashboard["export"]
    assert dashboard["file_name"] == "shop.omnikrux.json"
    assert (dashboard["dashboards"], dashboard["sources"], dashboard["alerts"]) == (1, 2, 0)
    # First use: the Loki source (panel 1), then Prometheus.
    assert [(s["key"], s["type"], s["filter"]) for s in out["sources"]] == [
        ("src-1", "loki", 'cluster="a"'),
        ("src-2", "prometheus", 'cluster="a"'),
    ]
    [entry] = out["dashboards"]
    assert (entry["exportId"], entry["owner"], entry["version"]) == (made["id"], "project", 1)
    panels = entry["dashboard"]["panels"]
    assert [q["source"]["id"] for p in panels for q in p["queries"]] == ["src-1", "src-2", None]
    assert out["owner"] == {"kind": "project", "name": "Shop"}

    # A project: its links in link order; a source no longer linked becomes null.
    project = (await export(http, "project", shop.project_id))["export"]
    assert [s["key"] for s in project["sources"]] == ["src-1", "src-2"]
    assert [s["type"] for s in project["sources"]] == ["prometheus", "loki"]
    assert project["project"]["links"] == [
        {"source": "src-1", "filter": 'cluster="a"'},
        {"source": "src-2", "filter": 'cluster="a"'},
    ]
    await app.state.monitoring.projects.unlink(shop.project_id, loki)
    project = (await export(http, "project", shop.project_id))["export"]
    panels = project["dashboards"][0]["dashboard"]["panels"]
    assert [q["source"]["id"] for p in panels for q in p["queries"]] == [None, "src-1", None]
    assert prom not in str(project) and loki not in str(project)


async def test_export_a_ready_made_view(monitoring_app, kube_cluster, fake_prometheus):
    http, app = monitoring_app
    services = app.state.monitoring
    project = await services.projects.create("prod-east", "kubernetes", kube_cluster)
    source = await services.sources.create(
        NewSource(name="Prometheus", type="prometheus", reach="url", url=fake_prometheus.url)
    )
    await link(services, project.id, source.id, 'cluster="prod-east"')
    ready = f"ready:{project.id}:cluster"
    out = await export(http, "dashboard", ready)
    assert out["file_name"] == "cluster-health.omnikrux.json"
    [entry] = out["export"]["dashboards"]
    assert entry["exportId"] == ready and entry["dashboard"]["title"] == "Cluster health"
    assert out["export"]["sources"] == [] and out["dashboards"] == 1

    # A view the project doesn't have, or a project that is gone: not found.
    for id in (f"ready:{project.id}:nope", "ready:gone:cluster"):
        r = await http.post(EXPORT, json={"kind": "dashboard", "id": id})
        assert r.status_code == 404 and r.json()["detail"]["message"] == EXPORT_GONE


async def test_exporting_the_logs_overview_uses_the_discovered_labels(
    monitoring_app, kube_cluster, fake_loki
):
    http, app = monitoring_app
    services = app.state.monitoring
    project = await services.projects.create("prod-east", "kubernetes", kube_cluster)
    source = await services.sources.create(
        NewSource(name="Logs", type="loki", reach="url", url=fake_loki.url)
    )
    await link(services, project.id, source.id, 'cluster="prod-east"')
    fake_loki.series = [
        {"k8s_namespace_name": "shop", "k8s_pod_name": "api-1", "level": "warn"},
        {"namespace": "old"},
    ]
    ready = f"ready:{project.id}:logs"
    out = await export(http, "dashboard", ready)
    assert out["file_name"] == "logs-overview.omnikrux.json"
    [entry] = out["export"]["dashboards"]
    doc = entry["dashboard"]
    assert entry["exportId"] == ready and doc["title"] == "Logs overview"
    exprs = [q["expr"] for p in doc["panels"] for q in p["queries"]]
    assert exprs and all('k8s_namespace_name=~".+"' in e for e in exprs)
    assert any("sum by (level)" in e for e in exprs)
    assert out["export"]["sources"] == []
    [series] = [r for r in fake_loki.requests if r.path == "/loki/api/v1/series"]
    assert series.params["match[]"] == ['{cluster="prod-east"}']

    # Pod health isn't the project's (no Prometheus), so it can't be exported.
    r = await http.post(EXPORT, json={"kind": "dashboard", "id": f"ready:{project.id}:pods"})
    assert r.status_code == 404 and r.json()["detail"]["message"] == EXPORT_GONE


async def test_group_export_lists_member_names_and_no_sources(monitoring_app, linked_project):
    http, app = monitoring_app
    services = app.state.monitoring
    other = await services.projects.create("billing", "custom", None)
    await link(services, other.id, linked_project.source_id, 'cluster="b"')
    r = await http.post(
        f"{API}/groups",
        json={"name": "Production", "project_ids": [linked_project.project_id, other.id]},
    )
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    await create(http, gid, board("Zeta", panel("p-1", [query("A", None)])), kind="group")
    await create(http, gid, board("alpha", panel("p-1", [query("A", None)])), kind="group")

    out = await export(http, "group", gid)
    assert out["file_name"] == "production-group.omnikrux.json"
    env = out["export"]
    assert env["group"] == {"name": "Production", "projects": ["billing", "Shop"]}
    assert env["sources"] == [] and env["owner"] == {"kind": "group", "name": "Production"}
    assert [d["dashboard"]["title"] for d in env["dashboards"]] == ["alpha", "Zeta"]
    assert {d["owner"] for d in env["dashboards"]} == {"group"}
    assert linked_project.project_id not in str(env) and other.id not in str(env)


async def test_export_is_audited(monitoring_app, linked_project_with_loki):
    http, app = monitoring_app
    shop = linked_project_with_loki
    third = await app.state.monitoring.sources.create(
        NewSource(name="Thanos", type="prometheus", reach="url", url="http://t.example.invalid")
    )
    await link(app.state.monitoring, shop.project_id, third.id, 'cluster="a"')
    await create(http, shop.project_id, board("One", panel("p-1", [query("A", None)])))
    await create(http, shop.project_id, board("Two", panel("p-1", [query("A", None)])))
    out = await export(http, "project", shop.project_id)
    assert (out["dashboards"], out["sources"], out["alerts"]) == (2, 3, 0)
    [record] = [r for r in await monitoring_records(http) if r["action"] == "monitoring_export"]
    assert (record["kind"], record["name"], record["outcome"]) == ("project", "Shop", "succeeded")
    assert record["details"] == {"dashboards": 2, "sources": 3, "alerts": 0}


async def test_no_audit_no_export(monitoring_app, linked_project, monkeypatch):
    http, app = monitoring_app
    made = await create(
        http, linked_project.project_id, board("A", panel("p-1", [query("A", None)]))
    )
    from omnikrux.audit.store import AuditUnavailable

    async def refuse(entry):
        raise AuditUnavailable("disk full")

    monkeypatch.setattr(app.state.audit, "begin_app", refuse)
    r = await http.post(EXPORT, json={"kind": "dashboard", "id": made["id"]})
    assert r.status_code == 503 and "export" not in r.text


async def test_exported_file_imports_back(monitoring_app, linked_project_with_loki, fake_webhook):
    http, _app = monitoring_app
    shop = linked_project_with_loki
    cp = await http.post(
        CONTACT_POINTS,
        json={"name": "Ops hook", "type": "webhook", "secrets": {"url": f"{fake_webhook.url}/h"}},
    )
    assert cp.status_code == 201, cp.text
    alert = ALERT | {"notify": [cp.json()["id"]]}
    await create(
        http,
        shop.project_id,
        board(
            "Shop",
            panel("p-1", [query("A", shop.source_id)], alert=alert),
            panel("p-2", [query("A", shop.loki_source_id, "loki")], x=6),
        ),
    )
    await create(http, shop.project_id, board("Other", panel("p-1", [query("A", None)])))
    out = await export(http, "project", shop.project_id)
    assert out["alerts"] == 1
    read = read_envelope(out["export"])
    assert [d.problems for d in read.dashboards] == [(), ()]
    assert read.skipped_by_key == {"d-1": (), "d-2": ()}
    [shop_doc] = [d.doc for d in read.dashboards if d.title == "Shop"]
    # Contact points travel by name; an import maps them to its own ids.
    assert shop_doc["panels"][0]["alert"]["notify"] == [{"name": "Ops hook"}]
    for d in read.dashboards:
        for p in d.doc["panels"]:
            if p["alert"] is not None:
                p["alert"], skipped = import_alert(
                    p["alert"],
                    panel=p,
                    panel_title=p["title"],
                    contact_points_by_name={"Ops hook": cp.json()["id"]},
                )
                assert skipped == [] and p["alert"]["notify"] == [cp.json()["id"]]
        validate_dashboard(d.doc, owner_kind="project")
    assert [s.filter for s in read.sources] == ['cluster="a"', 'cluster="a"']
    assert fake_webhook.url not in str(out)


async def test_contact_points_of_a_tool_run_alert_follow_the_installed_rule(
    monitoring_app, linked_project, fake_webhook
):
    http, app = monitoring_app
    services = app.state.monitoring
    as_tool(app)
    cp = await http.post(
        CONTACT_POINTS,
        json={"name": "Ops hook", "type": "webhook", "secrets": {"url": f"{fake_webhook.url}/h"}},
    )
    cp_id = cp.json()["id"]
    own = ALERT | {"name": "Own", "notify": [cp_id]}
    tool = ALERT | {"name": "Tool", "notify": [cp_id], "engine": "tool"}
    made = await create(
        http,
        linked_project.project_id,
        board(
            "Mixed",
            panel("p-1", [query("A", linked_project.source_id)], alert=own),
            panel("p-2", [query("A", None)], x=6, alert=tool),
        ),
    )

    def notify(out: dict) -> dict[str, list]:
        panels = out["export"]["dashboards"][0]["dashboard"]["panels"]
        return {p["alert"]["name"]: p["alert"]["notify"] for p in panels}

    # A user's own Prometheus notifies through its channel: the tool-run alert names none.
    out = await export(http, "dashboard", made["id"])
    assert notify(out) == {"Own": [{"name": "Ops hook"}], "Tool": []}
    # On a Prometheus OmniKrux installed, it keeps them (by name, never by id).
    await services.sources.set_installed_by_omnikrux(linked_project.source_id, True)
    out = await export(http, "dashboard", made["id"])
    assert notify(out) == {"Own": [{"name": "Ops hook"}], "Tool": [{"name": "Ops hook"}]}
    assert cp_id not in str(out)


async def test_export_refusals(monitoring_app, linked_project):
    http, _ = monitoring_app
    for kind in ("dashboard", "project", "group"):
        r = await http.post(EXPORT, json={"kind": kind, "id": "nope"})
        assert r.status_code == 404
        assert r.json()["detail"] == {
            "code": "not_found",
            "message": EXPORT_GONE,
            "key": None,
            "problems": [],
        }
    r = await http.post(EXPORT, json={"kind": "project", "id": linked_project.project_id})
    assert r.status_code == 422
    assert (
        r.json()["detail"]["message"] == "Shop has no dashboards to export. Add a dashboard first."
    )
    for body, message in [
        ({"kind": "folder", "id": "x"}, 'Choose "dashboard", "project" or "group" to export.'),
        ({"kind": "project"}, "Choose the dashboard, project or group to export by its id."),
        (
            {"kind": "project", "id": "x", "extra": 1},
            "The request has a field OmniKrux doesn't use. Remove it and try again.",
        ),
    ]:
        r = await http.post(EXPORT, json=body)
        assert r.status_code == 422
        assert r.json()["detail"] == {
            "code": "invalid_input",
            "message": message,
            "key": None,
            "problems": [],
        }
    r = await http.post(EXPORT, content=b"{nope", headers={"content-type": "application/json"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input"
    r = await http.post(
        EXPORT,
        json={"kind": "project", "id": linked_project.project_id},
        headers={"origin": "https://elsewhere.example.invalid"},
    )
    assert r.status_code == 403
    assert [r for r in await monitoring_records(http) if r["action"] == "monitoring_export"] == []


def test_export_file_names():
    assert export_file_name("dashboard", "API latency (p95)") == "api-latency-p95.omnikrux.json"
    assert export_file_name("project", "prod-east") == "prod-east-project.omnikrux.json"
    assert export_file_name("group", "!!!") == "dashboard-group.omnikrux.json"
    # A name that already ends with its kind doesn't take it twice.
    assert export_file_name("group", "Fleet group") == "fleet-group.omnikrux.json"
    assert export_file_name("project", "Shop Project") == "shop-project.omnikrux.json"
    assert export_file_name("group", "Group") == "group.omnikrux.json"
    assert export_file_name("project", "Groupies") == "groupies-project.omnikrux.json"
    assert export_file_name("dashboard", "a" * 59 + " b") == "a" * 59 + ".omnikrux.json"
    assert export_file_name("dashboard", "Ünïcode Board") == "n-code-board.omnikrux.json"


async def test_more_dashboards_than_an_export_holds(monitoring_app, linked_project, monkeypatch):
    http, _ = monitoring_app
    monkeypatch.setattr(export_module, "MAX_EXPORT_DASHBOARDS", 1)
    for title in ("One", "Two"):
        await create(
            http, linked_project.project_id, board(title, panel("p-1", [query("A", None)]))
        )
    r = await http.post(EXPORT, json={"kind": "project", "id": linked_project.project_id})
    assert r.status_code == 422
    assert r.json()["detail"]["message"] == (
        "An export holds at most 200 dashboards, and Shop has 2. "
        "Export its dashboards one at a time."
    )
